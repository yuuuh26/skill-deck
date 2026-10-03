export const APP_VERSION = '1.2.0';
export const SCHEMA_VERSION = 1;
export const DEFAULT_AI = ['ChatGPT', 'Gemini', 'Claude', 'Microsoft Copilot', 'その他'];
export const DEFAULT_TOOLS = ['外部ツール不要', 'Web検索', 'ファイル読込', 'Notion', 'Google Drive', 'GitHub', '画像生成', 'Computer Use', 'その他'];
export const STATUSES = ['動作確認済み', '使用可能', '一部制限あり', '非対応', '未確認'];

const DB_NAME = 'skill-deck';
let dbPromise;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('データベース操作に失敗しました'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('保存処理が中断されました'));
    tx.onerror = () => reject(tx.error || new Error('保存処理に失敗しました'));
  });
}

export function openDb() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('families', { keyPath: 'familyId' });
      const versions = db.createObjectStore('versions', { keyPath: 'versionId' });
      versions.createIndex('familyId', 'familyId');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした'));
    req.onblocked = () => reject(new Error('別のタブを閉じて再試行してください'));
  }).catch(error => { dbPromise = undefined; throw error; });
  return dbPromise;
}

export async function readAll() {
  const db = await openDb();
  const tx = db.transaction(['families', 'versions', 'meta'], 'readonly');
  const done = transactionDone(tx);
  const [families, versions, meta] = await Promise.all([
    request(tx.objectStore('families').getAll()),
    request(tx.objectStore('versions').getAll()),
    request(tx.objectStore('meta').getAll())
  ]);
  await done;
  const byKey = Object.fromEntries(meta.map(item => [item.key, item.value]));
  return {
    families, versions,
    aiMaster: byKey.aiMaster || [...DEFAULT_AI],
    toolMaster: byKey.toolMaster || [...DEFAULT_TOOLS],
    settings: byKey.settings || {}
  };
}

export async function saveVersion({ family, version }) {
  const db = await openDb();
  const tx = db.transaction(['families', 'versions', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  const families = tx.objectStore('families');
  const versions = tx.objectStore('versions');
  // Serialize concurrent saves within the same transaction; a stale editor cannot silently fork history.
  const current = await request(families.get(family.familyId));
  if (current && family.expectedCurrentVersionId !== current.currentVersionId) {
    tx.abort();
    await done.catch(() => {});
    throw new Error('別の画面で更新されています。再読み込みしてから編集してください');
  }
  if (!current && family.expectedCurrentVersionId) {
    tx.abort(); await done.catch(() => {});
    throw new Error('元のSkillが見つかりません');
  }
  const { expectedCurrentVersionId, ...record } = family;
  versions.add(version);
  families.put(record);
  await markChanged(tx);
  await done;
  changed();
}

export async function saveMaster(key, values) {
  if (!['aiMaster', 'toolMaster'].includes(key)) throw new Error('不明な設定です');
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('meta').put({ key, value: values });
  await markChanged(tx);
  await done;
  changed();
}

// Layout and master edits share the durable queue with content saves.
export async function updateSkillLayout(transform) {
  const db = await openDb();
  const tx = db.transaction(['families', 'versions', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  try {
    const [families, versions, record] = await Promise.all([
      request(tx.objectStore('families').getAll()), request(tx.objectStore('versions').getAll()),
      request(tx.objectStore('meta').get('settings'))
    ]);
    const settings = record?.value || {};
    const skillLayout = transform({families, versions, settings});
    tx.objectStore('meta').put({key: 'settings', value: {...settings, skillLayout}});
    await markChanged(tx);
  } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
  await done; changed();
}
export async function editToolMaster(oldName, newName) {
  const db = await openDb(); const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx); const store = tx.objectStore('meta');
  try {
    const values = (await request(store.get('toolMaster')))?.value || [...DEFAULT_TOOLS];
    if (!values.includes(oldName)) throw new Error('選択肢が変更されました。再読み込みしてください');
    if (newName !== null && (typeof newName !== 'string' || !newName.trim() || newName.length > 60)) throw new Error('ツール名を1〜60文字で入力してください');
    if (newName !== null && values.some(v => v !== oldName && v.toLocaleLowerCase() === newName.trim().toLocaleLowerCase())) throw new Error('すでに登録されています');
    store.put({key: 'toolMaster', value: newName === null ? values.filter(v => v !== oldName) : values.map(v => v === oldName ? newName.trim() : v)});
    await markChanged(tx);
  } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
  await done; changed();
}

export async function importData(data, mode) {
  if (!['replace', 'merge', 'empty'].includes(mode)) throw new Error('読み込み方法が不明です');
  const db = await openDb();
  const tx = db.transaction(['families', 'versions', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  const fs = tx.objectStore('families');
  const vs = tx.objectStore('versions');
  const ms = tx.objectStore('meta');
  try {
    if (mode === 'empty' && (await request(fs.count()) || await request(vs.count()))) {
      throw new Error('端末内にデータがあります。統合または置き換えを選んでください');
    }
    if (mode === 'merge') {
      const existingFamilies = await request(fs.getAll());
      const existingVersions = await request(vs.getAll());
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      for (const family of data.families) {
        const found = existingFamilies.find(item => item.familyId === family.familyId);
        if (found && !same(found, family)) throw new Error('同じSkill IDに異なる内容があります。競合を解決してから再試行してください');
      }
      for (const version of data.versions) {
        const found = existingVersions.find(item => item.versionId === version.versionId);
        if (found && !same(found, version)) throw new Error('同じバージョンIDに異なる内容があります。競合を解決してから再試行してください');
      }
    }
    if (mode === 'replace') { fs.clear(); vs.clear(); }
    for (const family of data.families) fs.put(family);
    for (const version of data.versions) vs.put(version);
    if (mode === 'merge') {
      const currentMeta = await request(ms.getAll());
      const byKey = Object.fromEntries(currentMeta.map(item => [item.key, item.value]));
      ms.put({ key: 'aiMaster', value: [...new Set([...(byKey.aiMaster || DEFAULT_AI), ...data.aiMaster])] });
      ms.put({ key: 'toolMaster', value: [...new Set([...(byKey.toolMaster || DEFAULT_TOOLS), ...data.toolMaster])] });
    } else {
      ms.put({ key: 'aiMaster', value: data.aiMaster });
      ms.put({ key: 'toolMaster', value: data.toolMaster });
      ms.put({ key: 'settings', value: data.settings });
    }
    await markChanged(tx);
  } catch (error) {
    tx.abort(); await done.catch(() => {}); throw error;
  }
  await done;
  changed();
}

export const SYNC_DEFAULT = {localRevision:0, ackRevision:0, cloudRevision:0, initialized:false, inFlight:null, lastSuccess:null};
const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('skill-deck-changed')); };
async function markChanged(tx) {
  const store=tx.objectStore('meta');
  const sync=(await request(store.get('cloudSync')))?.value || {...SYNC_DEFAULT};
  store.put({key:'cloudSync', value:{...sync,localRevision:sync.localRevision+1}});
}
export async function syncState() {
  const db=await openDb(); const tx=db.transaction('meta','readonly'); const done=transactionDone(tx);
  const r=await request(tx.objectStore('meta').get('cloudSync')); await done;
  return r?.value || {...SYNC_DEFAULT};
}
export async function updateSync(fn) {
  const db=await openDb(); const tx=db.transaction('meta','readwrite'); const done=transactionDone(tx);
  const store=tx.objectStore('meta'); const value=(await request(store.get('cloudSync')))?.value || {...SYNC_DEFAULT};
  store.put({key:'cloudSync',value:fn(value)}); await done;
}
export async function captureSync(makeBackup) {
  const db=await openDb(); const tx=db.transaction(['families','versions','meta'],'readwrite'); const done=transactionDone(tx);
  const [families,versions,meta]=await Promise.all([request(tx.objectStore('families').getAll()),request(tx.objectStore('versions').getAll()),request(tx.objectStore('meta').getAll())]);
  const byKey=Object.fromEntries(meta.map(x=>[x.key,x.value])); const state=byKey.cloudSync || {...SYNC_DEFAULT};
  if(!state.inFlight && state.localRevision>state.ackRevision) {
    state.inFlight={operationId:crypto.randomUUID(),baseRevision:state.cloudRevision,localRevision:state.localRevision,backup:makeBackup({families,versions,aiMaster:byKey.aiMaster||[...DEFAULT_AI],toolMaster:byKey.toolMaster||[...DEFAULT_TOOLS],settings:byKey.settings||{}})};
    tx.objectStore('meta').put({key:'cloudSync',value:state});
  }
  await done; return state.inFlight;
}
// Remote replacement and its sync revision commit together. Keep a complete
// local safety copy; concurrent local changes abort rather than being erased.
export async function applyRemote(incoming, cloudRevision, expectedRevision) {
  const db=await openDb(); const tx=db.transaction(['families','versions','meta'],'readwrite'); const done=transactionDone(tx);
  const ms=tx.objectStore('meta'), fs=tx.objectStore('families'), vs=tx.objectStore('versions');
  const [families,versions,meta]=await Promise.all([request(fs.getAll()),request(vs.getAll()),request(ms.getAll())]);
  const byKey=Object.fromEntries(meta.map(x=>[x.key,x.value])); const state=byKey.cloudSync || {...SYNC_DEFAULT};
  if(state.localRevision!==expectedRevision) {tx.abort(); await done.catch(()=>{}); throw Error('確認中に端末のデータが変更されました。再確認してください');}
  ms.put({key:'beforeCloudRestore',value:{families,versions,aiMaster:byKey.aiMaster||[...DEFAULT_AI],toolMaster:byKey.toolMaster||[...DEFAULT_TOOLS],settings:byKey.settings||{}}});
  fs.clear(); vs.clear(); incoming.families.forEach(x=>fs.put(x)); incoming.versions.forEach(x=>vs.put(x));
  for(const key of ['aiMaster','toolMaster','settings']) ms.put({key,value:incoming[key]});
  ms.put({key:'cloudSync',value:{...state,localRevision:state.localRevision+1,ackRevision:state.localRevision+1,cloudRevision,initialized:true,inFlight:null,lastSuccess:new Date().toISOString()}});
  await done;
}
export async function safetyCopy() {
  const db=await openDb(); const tx=db.transaction('meta','readonly'); const done=transactionDone(tx);
  const r=await request(tx.objectStore('meta').get('beforeCloudRestore')); await done; return r?.value;
}

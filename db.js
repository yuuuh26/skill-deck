export const APP_VERSION = '1.0.0';
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
  const tx = db.transaction(['families', 'versions'], 'readwrite');
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
  await done;
}

export async function saveMaster(key, values) {
  if (!['aiMaster', 'toolMaster'].includes(key)) throw new Error('不明な設定です');
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('meta').put({ key, value: values });
  await done;
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
  } catch (error) {
    tx.abort(); await done.catch(() => {}); throw error;
  }
  await done;
}

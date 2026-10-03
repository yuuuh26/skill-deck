import {setupCloud,CLOUD_URL} from './cloud.js';
import { APP_VERSION, DEFAULT_AI, DEFAULT_TOOLS, STATUSES, readAll, saveVersion, saveMaster, importData } from './db.js';
import { makeBackup, parseBackup, getMergeConflict, downloadText, filename, asMarkdown } from './backup.js';

const $ = selector => document.querySelector(selector);
const create = (tag, cls, value) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value !== undefined) el.textContent = value;
  return el;
};
let data = { families: [], versions: [], aiMaster: [...DEFAULT_AI], toolMaster: [...DEFAULT_TOOLS], settings: {} };
let screen = 'home';
let detailId = null;
let returnScreen = 'home';
let sourceId = null;
let editorDirty = false;
let saving = false;
let pendingImport = null;
let undoStack = [''];
let undoIndex = 0;
let undoTimer;
let toastTimer;

function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3100);
}
function date(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ja-JP') : '日付不明'; }
function version(id) { return data.versions.find(item => item.versionId === id); }
function family(id) { return data.families.find(item => item.familyId === id); }
function versionsOf(id) { return data.versions.filter(v => v.familyId === id).sort((a, b) => b.versionNumber - a.versionNumber); }
function current(v) { return family(v.familyId)?.currentVersionId === v.versionId; }
function refresh() {
  const shown=version(detailId);
  const followLatest=shown && current(shown);
  return readAll().then(result => {
    data=result;
    if(followLatest) detailId=family(shown.familyId)?.currentVersionId || detailId;
    renderAll();
  });
}

function leaveEditor() {
  if (screen === 'editor' && editorDirty && !window.confirm('保存前の編集内容を破棄して移動しますか？')) return false;
  editorDirty = false; clearTimeout(undoTimer); return true;
}
function navigate(next) {
  if (!leaveEditor()) return;
  screen = next;
  document.querySelectorAll('.screen').forEach(el => el.classList.toggle('active', el.id === next));
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('selected', el.dataset.nav === (next === 'detail' || next === 'editor' ? returnScreen : next)));
  if (next === 'home') renderHome();
  if (next === 'archive') renderArchive();
  window.scrollTo(0, 0);
}

function tagNodes(holder, tags) {
  holder.replaceChildren(...tags.map(tag => create('span', 'tag', tag)));
}
function makeCard(v) {
  const card = create('button', 'skill-card'); card.type = 'button';
  const head = create('div', 'card-head');
  head.append(create('h3', '', v.title), create('span', `badge${current(v) ? '' : ' archived'}`, `v${v.versionNumber}${current(v) ? ' 最新' : ' 旧版'}`));
  card.append(head, create('p', 'card-excerpt', v.content || '本文なし'));
  const foot = create('div', 'card-foot');
  foot.append(create('span', 'mini-ai', v.aiSupport.filter(ai => ai.status !== '非対応').map(ai => ai.name).join(' / ') || 'AI未登録'), create('span', '', date(v.savedAt)));
  card.append(foot);
  if (v.tags.length) { const tags = create('div', 'tags'); tags.style.marginTop = '10px'; tagNodes(tags, v.tags.slice(0, 4)); card.append(tags); }
  card.addEventListener('click', () => showDetail(v.versionId));
  return card;
}
function searchable(v) { return [v.title, v.content, v.note, ...v.tags, ...v.aiSupport.flatMap(ai => [ai.name, ai.status, ai.note, ...ai.tools])].join(' ').toLocaleLowerCase(); }
function containsTerm(v, term) { return !term || searchable(v).includes(term); }
function fillSelect(selector, values, previous) {
  const select = $(selector); select.replaceChildren(new Option('すべて', ''), ...values.map(value => new Option(value, value)));
  select.value = values.includes(previous) ? previous : '';
}
function renderFilters() {
  fillSelect('#filter-ai', data.aiMaster, $('#filter-ai').value);
  fillSelect('#filter-tool', data.toolMaster, $('#filter-tool').value);
  fillSelect('#filter-tag', [...new Set(data.versions.flatMap(v => v.tags))].sort((a,b) => a.localeCompare(b, 'ja')), $('#filter-tag').value);
}
function renderHome() {
  const term = $('#search').value.trim().toLocaleLowerCase();
  const ai = $('#filter-ai').value, tool = $('#filter-tool').value, tag = $('#filter-tag').value;
  const matched = data.families.map(f => version(f.currentVersionId)).filter(Boolean).filter(v => {
    const familyVersions = versionsOf(v.familyId);
    return familyVersions.some(old => containsTerm(old, term)) && (!ai || v.aiSupport.some(a => a.name === ai && a.status !== '非対応')) && (!tool || v.aiSupport.some(a => a.status !== '非対応' && a.tools.includes(tool))) && (!tag || v.tags.includes(tag));
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  $('#home-count').textContent = matched.length;
  $('#skill-list').replaceChildren(...(matched.length ? matched.map(makeCard) : [create('div', 'empty', data.families.length ? '条件に合うSkillがありません。検索や絞り込みを変えてみてください。' : 'まだSkillがありません。「新規作成」から最初のSkillを登録しましょう。')]));
}
function renderArchive() {
  const term = $('#archive-search').value.trim().toLocaleLowerCase();
  const matched = data.versions.filter(v => !current(v) && containsTerm(v, term)).sort((a,b) => b.savedAt.localeCompare(a.savedAt));
  $('#archive-list').replaceChildren(...(matched.length ? matched.map(makeCard) : [create('div', 'empty', '旧バージョンはありません。Skillを更新するとここに残ります。')]));
}
function renderAll() { renderFilters(); renderHome(); renderArchive(); renderMasters(); if (detailId && version(detailId)) renderDetail(); }

function showDetail(id) {
  if (screen === 'editor' && !leaveEditor()) return;
  if (screen === 'home' || screen === 'archive') returnScreen = screen;
  detailId = id; renderDetail(); navigate('detail');
}
function renderDetail() {
  const v = version(detailId); if (!v) return;
  $('#detail-badge').className = `badge${current(v) ? '' : ' archived'}`;
  $('#detail-badge').textContent = `v${v.versionNumber} · ${current(v) ? '最新版' : 'アーカイブ'}`;
  $('#detail-title').textContent = v.title;
  $('#detail-meta').textContent = `更新日 ${date(v.savedAt)}${v.basedOnVersionId && v.basedOnVersionId !== versionsOf(v.familyId)[1]?.versionId ? ' · 過去版を元に作成' : ''}`;
  tagNodes($('#detail-tags'), v.tags);
  $('#detail-content').textContent = v.content;
  $('#edit-skill').textContent = current(v) ? '編集' : '編集して最新版にする';
  const ai = $('#detail-ai'); ai.replaceChildren();
  if (!v.aiSupport.length) ai.append(create('p', 'muted', '対応AIは未登録です'));
  for (const item of v.aiSupport) {
    const row = create('div', 'ai-detail'); row.append(create('strong', '', item.name), create('span', '', item.status));
    if (item.tools.length) row.append(create('small', '', `必要ツール：${item.tools.join(' / ')}`));
    if (item.note) row.append(create('small', '', item.note));
    ai.append(row);
  }
  $('#detail-note-wrap').hidden = !v.note; $('#detail-note').textContent = v.note;
  $('#history-list').hidden = true; $('#show-history').textContent = 'このSkillの履歴を見る →';
  $('#history-list').replaceChildren(...versionsOf(v.familyId).map(makeCard));
}

function captureUndo() {
  clearTimeout(undoTimer);
  const content = $('#edit-content').value;
  if (content === undoStack[undoIndex]) { updateUndoButtons(); return; }
  undoStack = undoStack.slice(0, undoIndex + 1);
  undoStack.push(content);
  if (undoStack.length > 81) undoStack.shift();
  undoIndex = undoStack.length - 1;
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#undo').disabled = undoIndex <= 0 && $('#edit-content').value === undoStack[undoIndex];
  $('#redo').disabled = undoIndex >= undoStack.length - 1;
}
function resetUndo(value) { clearTimeout(undoTimer); undoStack = [value]; undoIndex = 0; updateUndoButtons(); }
function travelUndo(direction) {
  clearTimeout(undoTimer);
  if (direction < 0 && $('#edit-content').value !== undoStack[undoIndex]) captureUndo();
  const next = undoIndex + direction;
  if (next < 0 || next >= undoStack.length) return;
  undoIndex = next; $('#edit-content').value = undoStack[next]; editorDirty = true; updateUndoButtons(); $('#edit-content').focus();
}
function buildAiEditor(existing = []) {
  const parent = $('#ai-editor'); parent.replaceChildren();
  const choices = [...new Set([...data.aiMaster, ...existing.map(ai => ai.name)])];
  for (const name of choices) {
    const old = existing.find(ai => ai.name === name);
    const row = create('div', 'ai-editor-row'); row.dataset.name = name;
    const checkLabel = create('label', 'checkbox-line');
    const enabled = create('input'); enabled.type = 'checkbox'; enabled.checked = !!old; enabled.className = 'ai-enabled';
    checkLabel.append(enabled, document.createTextNode(name)); row.append(checkLabel);
    const options = create('div', 'ai-options'); options.hidden = !enabled.checked;
    const statusLabel = create('label', '', '対応状態'); const status = create('select', 'ai-status');
    status.replaceChildren(...STATUSES.map(s => new Option(s, s))); status.value = old?.status || '未確認';
    statusLabel.append(status); options.append(statusLabel, create('label', '', '必要ツール'));
    const tools = create('div', 'tool-choices');
    for (const tool of [...new Set([...data.toolMaster, ...(old?.tools || [])])]) {
      const label = create('label'); const input = create('input', 'ai-tool'); input.type = 'checkbox'; input.value = tool; input.checked = old?.tools.includes(tool) || false;
      label.append(input, document.createTextNode(tool)); tools.append(label);
    }
    options.append(tools);
    const noteLabel = create('label', '', 'AIごとの補足'); const note = create('textarea', 'ai-note'); note.rows = 2; note.value = old?.note || ''; note.placeholder = 'このAIでの使い方や制限'; noteLabel.append(note); options.append(noteLabel);
    enabled.addEventListener('change', () => { options.hidden = !enabled.checked; editorDirty = true; });
    tools.addEventListener('change', event => {
      if (event.target.value === '外部ツール不要' && event.target.checked) tools.querySelectorAll('input').forEach(input => { if (input !== event.target) input.checked = false; });
      else if (event.target.checked) { const none = [...tools.querySelectorAll('input')].find(input => input.value === '外部ツール不要'); if (none) none.checked = false; }
    });
    row.append(options); parent.append(row);
  }
}
function readAiEditor() {
  return [...document.querySelectorAll('.ai-editor-row')].filter(row => row.querySelector('.ai-enabled').checked).map(row => ({
    name: row.dataset.name, status: row.querySelector('.ai-status').value,
    tools: [...row.querySelectorAll('.ai-tool:checked')].map(el => el.value), note: row.querySelector('.ai-note').value.trim()
  }));
}
function openEditor(id = null) {
  if (screen === 'editor' && !leaveEditor()) return;
  sourceId = id;
  const v = id ? version(id) : null;
  if (v) { detailId = id; $('#editor-heading').textContent = `v${v.versionNumber}を編集`; $('#editor-kind').textContent = current(v) ? 'UPDATE SKILL' : 'FROM ARCHIVE'; $('#editor-source').textContent = `保存するとv${Math.max(...versionsOf(v.familyId).map(x => x.versionNumber)) + 1}の最新版を作成。元の版は残ります。`; }
  else { $('#editor-heading').textContent = 'Skillを作成'; $('#editor-kind').textContent = 'NEW SKILL'; $('#editor-source').textContent = '最初の版はv1として保存します。'; }
  $('#edit-title').value = v?.title || ''; $('#edit-content').value = v?.content || '';
  $('#edit-tags').value = v?.tags.join('、') || ''; $('#edit-note').value = v?.note || '';
  buildAiEditor(v?.aiSupport || []); resetUndo($('#edit-content').value); editorDirty = false;
  navigate('editor');
}
async function saveEditor(event) {
  event.preventDefault(); if (saving) return;
  captureUndo();
  const title = $('#edit-title').value.trim(), content = $('#edit-content').value;
  if (!title || !content.trim()) { toast('タイトルと本文を入力してください'); (!title ? $('#edit-title') : $('#edit-content')).focus(); return; }
  const base = sourceId ? version(sourceId) : null;
  const f = base ? family(base.familyId) : null;
  if (sourceId && (!base || !f)) { toast('元のSkillが見つかりません'); return; }
  const now = new Date().toISOString();
  const familyId = f?.familyId || crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const nextNumber = base ? Math.max(...versionsOf(familyId).map(v => v.versionNumber)) + 1 : 1;
  const record = {
    versionId, familyId, versionNumber: nextNumber, title, content,
    aiSupport: readAiEditor(), tags: [...new Set($('#edit-tags').value.split(/[、,\n]/).map(t => t.trim()).filter(Boolean))],
    note: $('#edit-note').value.trim(), basedOnVersionId: base?.versionId || null,
    createdAt: now, savedAt: now
  };
  saving = true; $('#save-skill').disabled = true;
  try {
    await saveVersion({ family: { familyId, currentVersionId: versionId, createdAt: f?.createdAt || now, updatedAt: now, expectedCurrentVersionId: f?.currentVersionId || null }, version: record });
    editorDirty = false; resetUndo(content); await refresh();
    detailId = versionId; screen = 'home'; showDetail(versionId); toast('保存しました');
  } catch (error) { toast(`保存に失敗しました：${error.message}`); }
  finally { saving = false; $('#save-skill').disabled = false; }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const el = create('textarea'); el.value = text; el.style.position = 'fixed'; el.style.opacity = '0'; document.body.append(el); el.select();
      const ok = document.execCommand('copy'); el.remove(); if (!ok) throw new Error('コピーできません');
    }
    toast('コピーしました');
  } catch { toast('コピーできませんでした。ブラウザの権限を確認してください'); }
}
function renderMasters() {
  tagNodes($('#ai-master'), data.aiMaster);
  tagNodes($('#tool-master'), data.toolMaster);
}
async function addMaster(event, key, inputId) {
  event.preventDefault(); const input = $(inputId), name = input.value.trim();
  if (!name) return;
  if (data[key].some(value => value.toLocaleLowerCase() === name.toLocaleLowerCase())) { toast('すでに登録されています'); return; }
  try { await saveMaster(key, [...data[key], name]); input.value = ''; await refresh(); toast('追加しました'); }
  catch { toast('保存に失敗しました'); }
}
async function storageStatus() {
  if (!navigator.storage?.persisted) { $('#storage-status').textContent = '永続ストレージ：この環境では確認できません'; $('#request-persist').hidden = true; return; }
  try { const yes = await navigator.storage.persisted(); $('#storage-status').textContent = `永続ストレージ：${yes ? '有効' : '未許可'}`; $('#request-persist').hidden = yes; }
  catch { $('#storage-status').textContent = '永続ストレージ：確認できません'; }
}
function exportJson() {
  try { downloadText(filename('json'), JSON.stringify(makeBackup(data), null, 2), 'application/json;charset=utf-8'); toast('JSONバックアップを作成しました'); }
  catch { toast('エクスポートに失敗しました'); }
}
function showImportPreview() {
  const panel = $('#import-preview'); panel.replaceChildren(); panel.hidden = !pendingImport; if (!pendingImport) return;
  const { backup, data: incoming } = pendingImport;
  panel.append(create('h3', '', 'バックアップの内容'), create('p', '', `Skill系列：${backup.counts.families}件`), create('p', '', `バージョン：${backup.counts.versions}件`), create('p', '', `出力日時：${new Date(backup.exportedAt).toLocaleString('ja-JP')}`), create('p', '', `バックアップ形式：v${backup.backupFormatVersion}`));
  const choices = create('div', 'choice-buttons');
  const populated = data.families.length || data.versions.length;
  if (!populated) {
    const button = create('button', '', '完全復元する'); button.addEventListener('click', () => performImport('empty')); choices.append(button);
  } else {
    const conflict = getMergeConflict(data, incoming);
    if (conflict) panel.append(create('p', 'warning', '同じIDに異なる内容があります。統合はできません。内容を確認して置き換えを選んでください。'));
    const merge = create('button', '', 'データを統合'); merge.disabled = conflict; merge.addEventListener('click', () => performImport('merge'));
    const replace = create('button', 'danger', '既存データを置き換える'); replace.addEventListener('click', () => performImport('replace'));
    choices.append(merge, replace);
  }
  const cancel = create('button', '', 'キャンセル'); cancel.addEventListener('click', () => { pendingImport = null; showImportPreview(); }); choices.append(cancel); panel.append(choices);
}
async function performImport(mode) {
  if (!pendingImport) return;
  if (mode === 'replace') {
    const response = window.prompt('端末内の現在のデータをすべて置き換えます。先に現在のJSONバックアップを保存してください。実行する場合は「置き換え」と入力してください。');
    if (response !== '置き換え') return;
  }
  const incoming = pendingImport.data;
  try {
    await importData(incoming, mode); pendingImport = null; showImportPreview(); await refresh();
    toast(`インポート完了：Skill ${data.families.length}件 / バージョン ${data.versions.length}件`);
  } catch (error) { toast(`インポート失敗：${error.message}`); }
}
async function importFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  pendingImport = null; showImportPreview();
  if (file.size > 20 * 1024 * 1024) { toast('ファイルが大きすぎます（上限20 MB）'); return; }
  try { pendingImport = parseBackup(await file.text()); showImportPreview(); $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  catch (error) { toast(`読み込めません：${error.message}`); }
}

document.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.nav)));
$('#top-new').addEventListener('click', () => openEditor());
$('#home-new').addEventListener('click', () => openEditor());
for (const selector of ['#search', '#archive-search']) $(selector).addEventListener('input', () => selector === '#search' ? renderHome() : renderArchive());
for (const selector of ['#filter-ai', '#filter-tool', '#filter-tag']) $(selector).addEventListener('change', renderHome);
document.querySelector('[data-back]').addEventListener('click', () => navigate(returnScreen));
$('#editor-back').addEventListener('click', () => sourceId ? showDetail(sourceId) : navigate(returnScreen));
$('#copy-skill').addEventListener('click', () => copyText(version(detailId)?.content || ''));
$('#edit-skill').addEventListener('click', () => openEditor(detailId));
$('#show-history').addEventListener('click', () => { const list = $('#history-list'); list.hidden = !list.hidden; $('#show-history').textContent = list.hidden ? 'このSkillの履歴を見る →' : '履歴を閉じる ↑'; });
$('#edit-content').addEventListener('input', () => { editorDirty = true; clearTimeout(undoTimer); undoTimer = setTimeout(captureUndo, 500); updateUndoButtons(); });
$('#edit-content').addEventListener('blur', captureUndo);
$('#undo').addEventListener('click', () => travelUndo(-1)); $('#redo').addEventListener('click', () => travelUndo(1));
$('#skill-form').addEventListener('input', () => { editorDirty = true; });
$('#skill-form').addEventListener('submit', saveEditor);
$('#ai-master-form').addEventListener('submit', event => addMaster(event, 'aiMaster', '#new-ai'));
$('#tool-master-form').addEventListener('submit', event => addMaster(event, 'toolMaster', '#new-tool'));
$('#request-persist').addEventListener('click', async () => { try { await navigator.storage.persist(); await storageStatus(); } catch { toast('永続ストレージを申請できませんでした'); } });
$('#export-json').addEventListener('click', exportJson);
$('#export-md').addEventListener('click', () => { try { downloadText(filename('md'), asMarkdown(data, $('#include-archives').checked), 'text/markdown;charset=utf-8'); toast('Markdownを作成しました'); } catch { toast('出力に失敗しました'); } });
$('#import-file').addEventListener('change', importFile);
$('#copy-url').addEventListener('click', () => copyText(location.origin===CLOUD_URL?CLOUD_URL+'/':'https://yuuuh26.github.io/skill-deck/'));
$('#app-version').textContent = `v${APP_VERSION}`;
window.addEventListener('beforeunload', event => { if (editorDirty && screen === 'editor') { event.preventDefault(); event.returnValue = ''; } });

try { await refresh(); await storageStatus(); }
catch (error) { toast(`保存領域を開けません：${error.message}`); }
setupCloud({refresh,isEditing:()=>screen==='editor',toast});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});

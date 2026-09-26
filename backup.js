import { APP_VERSION, SCHEMA_VERSION, STATUSES } from './db.js';

const FORMAT = 'skill-deck-backup';
const MAX_BYTES = 20 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const strings = value => Array.isArray(value) && value.every(nonempty);
const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function makeBackup(data) {
  return {
    format: FORMAT, backupFormatVersion: 1, schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    counts: { families: data.families.length, versions: data.versions.length },
    data: {
      families: data.families, versions: data.versions,
      aiMaster: data.aiMaster, toolMaster: data.toolMaster, settings: data.settings
    }
  };
}

export function validateBackup(raw) {
  if (!isObject(raw) || raw.format !== FORMAT || raw.backupFormatVersion !== 1) throw new Error('Skill Deckのバックアップ形式ではありません');
  if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error(`対応していないデータ形式です（schemaVersion: ${String(raw.schemaVersion)}）`);
  if (!nonempty(raw.appVersion) || !nonempty(raw.exportedAt) || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error('バックアップの日時またはバージョンが不正です');
  if (!isObject(raw.data) || !isObject(raw.counts)) throw new Error('必須データがありません');
  const { families, versions, aiMaster, toolMaster, settings } = raw.data;
  if (!Array.isArray(families) || !Array.isArray(versions) || !strings(aiMaster) || !strings(toolMaster) || !isObject(settings)) throw new Error('データ構造が不正です');
  if (raw.counts.families !== families.length || raw.counts.versions !== versions.length) throw new Error('バックアップの件数が一致しません');
  if (new Set(aiMaster).size !== aiMaster.length || new Set(toolMaster).size !== toolMaster.length) throw new Error('マスターに重複があります');
  const familyMap = new Map();
  const versionMap = new Map();
  for (const f of families) {
    if (!isObject(f) || !nonempty(f.familyId) || !nonempty(f.currentVersionId) || !nonempty(f.createdAt) || !nonempty(f.updatedAt) || familyMap.has(f.familyId)) throw new Error('Skill系列の構造またはIDが不正です');
    familyMap.set(f.familyId, f);
  }
  for (const v of versions) {
    if (!isObject(v) || !nonempty(v.versionId) || !familyMap.has(v.familyId) || !Number.isSafeInteger(v.versionNumber) || v.versionNumber < 1 || !nonempty(v.title) || typeof v.content !== 'string' || !Array.isArray(v.aiSupport) || !strings(v.tags) || typeof v.note !== 'string' || !nonempty(v.createdAt) || !nonempty(v.savedAt) || versionMap.has(v.versionId)) throw new Error('バージョンの構造またはIDが不正です');
    if (v.basedOnVersionId !== null && v.basedOnVersionId !== undefined && !nonempty(v.basedOnVersionId)) throw new Error('参照元IDが不正です');
    const seenAi = new Set();
    for (const ai of v.aiSupport) {
      if (!isObject(ai) || !nonempty(ai.name) || !STATUSES.includes(ai.status) || !strings(ai.tools) || typeof ai.note !== 'string' || seenAi.has(ai.name)) throw new Error('対応AI情報が不正です');
      if (ai.tools.includes('外部ツール不要') && ai.tools.length > 1) throw new Error('必要ツールの指定が矛盾しています');
      seenAi.add(ai.name);
    }
    versionMap.set(v.versionId, v);
  }
  const numbers = new Set();
  for (const v of versions) {
    const key = `${v.familyId}\u0000${v.versionNumber}`;
    if (numbers.has(key)) throw new Error('同一Skillに重複したバージョン番号があります');
    numbers.add(key);
    if (v.basedOnVersionId && versionMap.get(v.basedOnVersionId)?.familyId !== v.familyId) throw new Error('参照元バージョンが見つかりません');
  }
  for (const f of families) {
    const own = versions.filter(v => v.familyId === f.familyId);
    const current = versionMap.get(f.currentVersionId);
    if (!current || current.familyId !== f.familyId || !own.length || current.versionNumber !== Math.max(...own.map(v => v.versionNumber))) throw new Error('最新版の参照が不正です');
  }
  return raw.data;
}

export function parseBackup(text) {
  if (new Blob([text]).size > MAX_BYTES) throw new Error('ファイルが大きすぎます（上限20 MB）');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('JSONを読み取れませんでした'); }
  return { backup: parsed, data: validateBackup(parsed) };
}

export function getMergeConflict(current, incoming) {
  for (const kind of ['families', 'versions']) {
    const id = kind === 'families' ? 'familyId' : 'versionId';
    const existing = new Map(current[kind].map(item => [item[id], item]));
    for (const item of incoming[kind]) if (existing.has(item[id]) && !identical(existing.get(item[id]), item)) return true;
  }
  return false;
}

export function downloadText(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function filename(ext) {
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  return `skill-deck-${ext === 'json' ? 'backup' : 'skills'}_${local}.${ext}`;
}

export function asMarkdown(data, archives = false) {
  const chosen = archives ? data.versions : data.families.map(f => data.versions.find(v => v.versionId === f.currentVersionId)).filter(Boolean);
  const versions = [...chosen].sort((a, b) => a.title.localeCompare(b.title, 'ja') || a.versionNumber - b.versionNumber);
  return ['# Skill Deck', '', `出力日時: ${new Date().toLocaleString('ja-JP')}`, '', ...versions.flatMap(v => [
    `# ${v.title.replaceAll('\n', ' ')}`, '', `Version: v${v.versionNumber}`,
    `対応AI: ${v.aiSupport.filter(a => a.status !== '非対応').map(a => a.name).join(' / ') || '未登録'}`,
    `更新日: ${new Date(v.savedAt).toLocaleString('ja-JP')}`, `タグ: ${v.tags.join(' / ') || 'なし'}`, '',
    '## Skill本文', '', v.content, '', '---', ''
  ])].join('\n');
}

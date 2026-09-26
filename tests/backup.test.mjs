import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup, getMergeConflict, asMarkdown } from '../backup.js';

function sample() {
  return {
    families: [{ familyId: 'family-1', currentVersionId: 'version-2', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }],
    versions: [
      { versionId: 'version-1', familyId: 'family-1', versionNumber: 1, title: '旧タイトル', content: '旧本文', aiSupport: [{ name: 'ChatGPT', status: '使用可能', tools: ['Web検索'], note: '' }], tags: ['料理'], note: '', basedOnVersionId: null, createdAt: '2026-09-01T00:00:00.000Z', savedAt: '2026-09-01T00:00:00.000Z' },
      { versionId: 'version-2', familyId: 'family-1', versionNumber: 2, title: '新タイトル', content: '新本文', aiSupport: [{ name: 'Gemini', status: '動作確認済み', tools: ['外部ツール不要'], note: '貼り付ける' }], tags: ['調理'], note: '', basedOnVersionId: 'version-1', createdAt: '2026-09-02T00:00:00.000Z', savedAt: '2026-09-02T00:00:00.000Z' }
    ],
    aiMaster: ['ChatGPT','Gemini'], toolMaster: ['Web検索','外部ツール不要'], settings: {}
  };
}

test('JSON round trip keeps IDs, old versions and AI metadata', () => {
  const original = sample();
  const parsed = parseBackup(JSON.stringify(makeBackup(original)));
  assert.deepEqual(parsed.data, original);
  assert.equal(parsed.backup.counts.versions, 2);
});

test('broken counts, lineage, duplicate IDs and future schema are rejected', () => {
  for (const breakIt of [
    b => { b.counts.versions = 3; },
    b => { b.data.versions[1].basedOnVersionId = 'missing'; },
    b => { b.data.versions[1].versionId = 'version-1'; },
    b => { b.data.families[0].currentVersionId = 'version-1'; },
    b => { b.schemaVersion = 999; },
    b => { b.data.versions[1].aiSupport[0].tools.push('Web検索'); }
  ]) {
    const backup = makeBackup(sample()); breakIt(backup);
    assert.throws(() => parseBackup(JSON.stringify(backup)));
  }
});

test('merge rejects same ID with changed content', () => {
  const existing = sample(), incoming = sample();
  assert.equal(getMergeConflict(existing, incoming), false);
  incoming.versions[0].content = '別の本文';
  assert.equal(getMergeConflict(existing, incoming), true);
});

test('Markdown uses latest only unless archives requested', () => {
  const data = sample();
  assert.equal(asMarkdown(data).includes('旧本文'), false);
  assert.equal(asMarkdown(data, true).includes('旧本文'), true);
});

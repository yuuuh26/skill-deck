import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const code=await build({entryPoints:['cloudflare/shared-db.ts'],bundle:true,format:'esm',write:false});
const {namespaceSql,appDatabase}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
test('SQL namespaces preserve literal values, comments, parameters and unrelated columns',()=>{
 const input="SELECT * FROM backups JOIN backup_chunks ON backups.operation_id=backup_chunks.operation_id WHERE app_id=? AND backup_json='backups '' backup_chunks' -- backups\n/* auth_sessions */";
 assert.equal(namespaceSql(input,'skill_deck'),"SELECT * FROM skill_deck_backups JOIN skill_deck_backup_chunks ON skill_deck_backups.operation_id=skill_deck_backup_chunks.operation_id WHERE app_id=? AND backup_json='backups '' backup_chunks' -- backups\n/* auth_sessions */");
 assert.equal(namespaceSql('SELECT * FROM \"backups\" JOIN [backup_retention] ON 1', 'sorosoro'),'SELECT * FROM \"sorosoro_backups\" JOIN [sorosoro_backup_retention] ON 1');
});
test('Database adapter rejects another app namespace and forwards original prepared statements',async()=>{
 const seen=[],db={prepare(q){seen.push(q);return {q};},async batch(s){return s;}};
 assert.throws(()=>appDatabase(db,'other','skill_deck'),/does not match/);
 const scoped=appDatabase(db,'skill_deck','skill_deck'),statement=scoped.prepare('DELETE FROM auth_sessions WHERE session_id=?');
 assert.equal(statement.q,'DELETE FROM skill_deck_auth_sessions WHERE session_id=?');
 assert.deepEqual(await scoped.batch([statement]),[statement]);
 assert.equal(scoped.exec,undefined);
 assert.throws(()=>namespaceSql('SELECT * FROM backups','bad;DROP TABLE x'),/Invalid/);
});

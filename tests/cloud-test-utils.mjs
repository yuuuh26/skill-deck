import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {makeBackup} from '../backup.js';
import {digest} from '../cloudflare/snapshot.js';
const compiled=await build({entryPoints:['cloudflare/worker.ts'],bundle:true,platform:'browser',format:'esm',write:false});
export const worker=(await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))).default;
export function database(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON;');
 const db={sql,failWrite:false,corruptRead:false,
  prepare(query){return {args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(query).get(...this.args)||null;},async all(){const results=sql.prepare(query).all(...this.args);if(db.corruptRead&&query.startsWith('SELECT chunk_index'))results[0].backup_json='{}';return {results};},query};},
  async batch(statements){sql.exec('BEGIN');try{const result=statements.map(s=>{if(db.failWrite&&s.query.startsWith('INSERT INTO backup_chunks'))throw Error('network failure');return sql.prepare(s.query).run(...s.args);});sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}
 };return db;
}
export async function envForTest(){const DB=database();DB.sql.exec(await readFile('cloudflare/schema.sql','utf8'));const key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');return {env:{DB,BACKUP_TOKEN_SHA256:await digest(key)},key};}
export function sample(n){const now=new Date().toISOString();return makeBackup({families:[{familyId:'f',currentVersionId:'v',createdAt:now,updatedAt:now}],versions:[{versionId:'v',familyId:'f',versionNumber:1,title:'test '+n,content:'本文 '+n,aiSupport:[],tags:[],note:'',basedOnVersionId:null,createdAt:now,savedAt:now}],aiMaster:['ChatGPT'],toolMaster:['外部ツール不要'],settings:{}});}

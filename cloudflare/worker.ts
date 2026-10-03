import {APP_ID,digest,validateInput} from './snapshot.js';
import {validateBackup} from '../backup.js';
import {AuthError,getSession,sameOrigin,sessionCookie,sessionRoute} from './sessions';
export type Env={DB:any;BACKUP_TOKEN_SHA256:string};
class ApiError extends Error {constructor(public status:number,message:string){super(message)}}
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function bodyJson(r:Request) {
 const limit=21*1024*1024;
 if(!r.headers.get('Content-Type')?.startsWith('application/json'))throw new ApiError(415,'JSONを指定してください');
 if(Number(r.headers.get('Content-Length'))>limit)throw new ApiError(413,'送信内容が大きすぎます');
 if(!r.body)throw new ApiError(400,'JSONがありません');
 const reader=r.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new ApiError(413,'送信内容が大きすぎます');}text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
 catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'JSONを確認してください');}
}
async function state(env:Env){return env.DB.prepare('SELECT revision,operation_id FROM cloud_state WHERE app_id=?').bind(APP_ID).first();}
async function readBackup(env:Env,id:string,staged=false) {
 const row=await env.DB.prepare(`SELECT * FROM backups WHERE operation_id=? ${staged?'':'AND revision IS NOT NULL'}`).bind(id).first();
 if(!row)throw new ApiError(404,'バックアップがありません');
 const {results}=await env.DB.prepare('SELECT chunk_index,backup_json FROM backup_chunks WHERE operation_id=? ORDER BY chunk_index').bind(id).all();
 if(results.length!==row.chunk_count||results.some((c:any,i:number)=>c.chunk_index!==i))throw new ApiError(500,'保存内容を照合できません');
 const backup=JSON.parse(results.map((c:any)=>c.backup_json).join(''));
 validateBackup(backup);
 if(await digest(JSON.stringify(backup.data))!==row.sha256)throw new ApiError(500,'保存内容を照合できません');
 return {...row,backup};
}
async function writeBackup(env:Env,input:any) {
 if(!idPattern.test(input?.operationId))throw new ApiError(400,'処理IDが不正です');
 let checked;try{checked=await validateInput(input);}catch(e){throw new ApiError(400,(e as Error).message);}
 const id=input.operationId,{json,sha256}=checked;
 const receipt=await env.DB.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(id).first();
 if(receipt){if(receipt.sha256!==sha256)throw new ApiError(409,'同じ処理IDに異なる内容があります');return receipt;}
 const head=await state(env);
 if(head.revision!==input.baseRevision)throw new ApiError(409,'別の端末で更新されています。内容を確認してください');
 const chunks:string[]=[];
 for(let offset=0;offset<json.length;){let end=Math.min(offset+600000,json.length);const last=json.charCodeAt(end-1);if(end<json.length&&last>=0xd800&&last<=0xdbff)end--;chunks.push(json.slice(offset,end));offset=end;}
 const old=await env.DB.prepare('SELECT * FROM backups WHERE operation_id=?').bind(id).first();
 if(old && (old.sha256!==sha256||old.base_revision!==input.baseRevision))throw new ApiError(409,'同じ処理IDに異なる内容があります');
 if(!old){try{await env.DB.batch([
  env.DB.prepare('INSERT INTO backups(operation_id,base_revision,sha256,saved_at,record_count,version_count,chunk_count) VALUES (?,?,?,?,?,?,?)').bind(id,input.baseRevision,sha256,new Date().toISOString(),input.backup.counts.families,input.backup.counts.versions,chunks.length),
  ...chunks.map((c,i)=>env.DB.prepare('INSERT INTO backup_chunks(operation_id,chunk_index,backup_json) VALUES (?,?,?)').bind(id,i,c))
 ]);}catch {const winner=await env.DB.prepare('SELECT * FROM backups WHERE operation_id=?').bind(id).first();if(!winner||winner.sha256!==sha256||winner.base_revision!==input.baseRevision)throw new ApiError(503,'保存に失敗しました。端末の内容は保持しています');}}
 // Read and validate the COMPLETE stored payload before promotion or pruning.
 await readBackup(env,id,true);
 await env.DB.batch([
  env.DB.prepare('UPDATE cloud_state SET revision=revision+1,operation_id=? WHERE app_id=? AND revision=?').bind(id,APP_ID,input.baseRevision),
  env.DB.prepare('UPDATE backups SET revision=(SELECT revision FROM cloud_state WHERE app_id=? AND operation_id=?) WHERE operation_id=? AND revision IS NULL').bind(APP_ID,id,id),
  env.DB.prepare('INSERT OR IGNORE INTO receipts(operation_id,sha256,revision) SELECT operation_id,sha256,revision FROM backups WHERE operation_id=? AND revision IS NOT NULL').bind(id),
  env.DB.prepare('DELETE FROM backups WHERE revision IS NOT NULL AND operation_id IN (SELECT operation_id FROM backups WHERE revision IS NOT NULL ORDER BY revision DESC LIMIT -1 OFFSET 3)')
 ]);
 const committed=await env.DB.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(id).first();
 if(!committed){await env.DB.batch([env.DB.prepare('DELETE FROM backups WHERE operation_id=? AND revision IS NULL').bind(id)]);throw new ApiError(409,'別の端末で更新されています。端末の内容を保持しています');}
 return committed;
}
export default {async fetch(request:Request,env:Env) {
 const reply=(body:any,status=200,cookie?:string)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})}});
 try {
  const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)throw new ApiError(403,'このアプリから操作してください');
  if(!/^[0-9a-f]{64}$/.test(env.BACKUP_TOKEN_SHA256||''))throw new ApiError(503,'認証設定が完了していません');
  const auth=await sessionRoute(request,env,bodyJson);if(auth)return auth;
  if(request.method!=='GET')sameOrigin(request);
  const session=await getSession(request,env),cookie=sessionCookie(session.token);
  const url=new URL(request.url),path=url.pathname;
  if(path==='/v1/state'&&request.method==='GET')return reply(await state(env),200,cookie);
  if(path==='/v1/backups'&&request.method==='GET')return reply({backups:(await env.DB.prepare('SELECT operation_id,revision,sha256,saved_at,record_count,version_count FROM backups WHERE revision IS NOT NULL ORDER BY revision DESC LIMIT 3').all()).results},200,cookie);
  if(path==='/v1/backups'&&request.method==='POST')return reply(await writeBackup(env,await bodyJson(request)),200,cookie);
  const match=/^\/v1\/backups\/([^/]+)$/.exec(path);
  if(match&&idPattern.test(match[1])&&request.method==='GET')return reply(await readBackup(env,match[1]),200,cookie);
  throw new ApiError(404,'対応していない操作です');
 }catch(e){return reply({error:e instanceof ApiError||e instanceof AuthError?e.message:'クラウドで処理できませんでした'},e instanceof ApiError||e instanceof AuthError?e.status:500);}
}};

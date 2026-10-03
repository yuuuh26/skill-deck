import test from 'node:test';
import assert from 'node:assert/strict';
import {worker,envForTest,sample} from './cloud-test-utils.mjs';
function request(path,body,cookie,key,origin='https://test.invalid'){return new Request('https://test.invalid/v1/'+path,{method:body?'POST':'GET',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
async function connect(env,key){const r=await worker.fetch(request('session',{deviceName:'test'},null,key),env);assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
test('authentication, cross-app rejection, origin protection and revoked sessions',async()=>{
 const {env,key}=await envForTest();const cookie=await connect(env,key);
 for(const p of ['state','backups','backups/'+crypto.randomUUID()])assert.equal((await worker.fetch(request(p),env)).status,401);
 assert.equal((await worker.fetch(request('backups',{operationId:crypto.randomUUID(),baseRevision:0,backup:sample(1)}),env)).status,401);
 assert.equal((await worker.fetch(request('backups/'+crypto.randomUUID(),null,null),env)).status,401);
 assert.equal((await worker.fetch(new Request('https://test.invalid/v1/backups/'+crypto.randomUUID(),{method:'DELETE'}),env)).status,403);
 assert.equal((await worker.fetch(request('state',null,'__Host-fridge-ai-helper-session=wrong'),env)).status,401);
 assert.equal((await worker.fetch(request('session',{deviceName:'bad'},null,'a'.repeat(43)),env)).status,401);
 assert.equal((await worker.fetch(request('backups',{},cookie,null,'https://evil.invalid'),env)).status,403);
 assert.equal((await worker.fetch(request('sessions/revoke',{all:true},cookie),env)).status,401);
 assert.equal((await worker.fetch(request('sessions/revoke',{all:true},cookie,key),env)).status,200);
 assert.equal((await worker.fetch(request('state',null,cookie),env)).status,401);
 const newCookie=await connect(env,key);
 const rotated=await worker.fetch(request('sessions/rotate',{},newCookie,key),env);assert.equal(rotated.status,200);
 assert.equal((await worker.fetch(request('session',{deviceName:'old'},null,key),env)).status,401);
 assert.equal((await worker.fetch(request('state',null,newCookie),env)).status,401);
});
test('3 generations, complete round trip, idempotent retries, CAS conflicts and failed writes',async()=>{
 const {env,key}=await envForTest();const cookie=await connect(env,key);let lastJob;
 for(let n=1;n<=5;n++){lastJob={operationId:crypto.randomUUID(),baseRevision:n-1,backup:sample(n)};const result=await worker.fetch(request('backups',lastJob,cookie),env);assert.equal(result.status,200,await result.text());}
 let history=await (await worker.fetch(request('backups',null,cookie),env)).json();assert.deepEqual(history.backups.map(x=>x.revision),[5,4,3]);
 const remote=await (await worker.fetch(request('backups/'+lastJob.operationId,null,cookie),env)).json();assert.deepEqual(remote.backup,lastJob.backup);
 assert.equal((await worker.fetch(request('backups',lastJob,cookie),env)).status,200);
 assert.equal((await worker.fetch(request('backups',{operationId:crypto.randomUUID(),baseRevision:4,backup:sample(6)},cookie),env)).status,409);
 const before=env.DB.sql.prepare('SELECT count(*) n FROM backup_chunks').get().n;
 env.DB.failWrite=true;assert.equal((await worker.fetch(request('backups',{operationId:crypto.randomUUID(),baseRevision:5,backup:sample(6)},cookie),env)).status,503);env.DB.failWrite=false;
 assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM backup_chunks').get().n,before);
 env.DB.corruptRead=true;assert.equal((await worker.fetch(request('backups',{operationId:crypto.randomUUID(),baseRevision:5,backup:sample(6)},cookie),env)).status,500);env.DB.corruptRead=false;
 history=await (await worker.fetch(request('backups',null,cookie),env)).json();assert.deepEqual(history.backups.map(x=>x.revision),[5,4,3]);
 assert.throws(()=>env.DB.sql.prepare('DELETE FROM backups WHERE revision=5').run(),/protected/);
});
test('simultaneous writers cannot silently overwrite',async()=>{
 const {env,key}=await envForTest(),cookie=await connect(env,key);
 const results=await Promise.all([1,2].map(n=>worker.fetch(request('backups',{operationId:crypto.randomUUID(),baseRevision:0,backup:sample(n)},cookie),env)));
 assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
 assert.equal(env.DB.sql.prepare('SELECT revision FROM cloud_state').get().revision,1);
});
test('large Unicode data split and read without corruption',async()=>{
 const {env,key}=await envForTest(),cookie=await connect(env,key),backup=sample(1);backup.data.versions[0].content='あ😀'.repeat(260000);
 const job={operationId:crypto.randomUUID(),baseRevision:0,backup};
 assert.equal((await worker.fetch(request('backups',job,cookie),env)).status,200);
 const remote=await (await worker.fetch(request('backups/'+job.operationId,null,cookie),env)).json();assert.equal(remote.backup.data.versions[0].content,backup.data.versions[0].content);
});

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {worker,envForTest} from './cloud-test-utils.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright');
const {env,key}=await envForTest(),origin='http://127.0.0.1:8787';
const mime={html:'text/html',js:'text/javascript',css:'text/css',webmanifest:'application/manifest+json',png:'image/png'};
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/v1/')){const bytes=[];for await(const c of req)bytes.push(c);const response=await worker.fetch(new Request(origin+req.url,{method:req.method,headers:req.headers,...(bytes.length?{body:Buffer.concat(bytes)}:{})}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
 else{const file=req.url==='/'?'index.html':req.url.slice(1);let bytes=await readFile(file);if(file==='cloud.js')bytes=Buffer.from(bytes.toString().replace('https://skill-deck-cloud.dengana-10011212.workers.dev',origin));if(file==='manifest.webmanifest'){const m=JSON.parse(bytes);m.id=m.scope=m.start_url='/';bytes=Buffer.from(JSON.stringify(m));}res.writeHead(200,{'Content-Type':mime[file.split('.').at(-1)]||'text/plain'});res.end(bytes);}
 }catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(r=>server.listen(8787,'127.0.0.1',r));
const sparticuz=process.env.CHROMIUM_PACKAGE ? (await import(process.env.CHROMIUM_PACKAGE)).default : null;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']}:(sparticuz?{executablePath:await sparticuz.executablePath(),args:sparticuz.args}:{}))});const a=await browser.newContext({viewport:{width:390,height:844}}),b=await browser.newContext({viewport:{width:1366,height:900}});
const pa=await a.newPage(),pb=await b.newPage(),errors=[];
for(const p of [pa,pb])p.on('pageerror',e=>errors.push(e.message));
async function connect(p,name){await p.goto(origin);await p.locator('[data-nav="settings"]').last().click();await p.locator('#cloud-name').fill(name);await p.locator('#cloud-key').fill(key);await p.locator('#cloud-connect-form button').click();await p.waitForFunction(()=>document.getElementById('cloud-status').textContent==='クラウドと同期済み');}
async function home(p){await p.locator('[data-nav="home"]').click();}
async function saveNew(p,title){await home(p);await p.locator('#home-new').click();await p.locator('#edit-title').fill(title);await p.locator('#edit-content').fill(title+' 本文');await p.locator('#save-skill').click();await p.waitForFunction(()=>document.getElementById('detail').classList.contains('active'));}
async function synced(p){await p.waitForFunction(()=>document.getElementById('cloud-status').textContent==='クラウドと同期済み',{},{timeout:20000});}
try {
 await connect(pa,'mobile');await connect(pb,'PC');
 await saveNew(pa,'スマホで作成');await synced(pa);await pb.waitForFunction(()=>document.getElementById('home-count').textContent==='1');
 await home(pb);await pb.locator('.skill-card').first().click();await pb.locator('#edit-skill').click();await pb.locator('#edit-content').fill('パソコンで編集');await pb.locator('#save-skill').click();await synced(pb);
 await pa.waitForFunction(()=>document.getElementById('detail-content').textContent==='パソコンで編集');
 await pa.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 await a.setOffline(true);await saveNew(pa,'オフラインで追加');await pa.reload();await pa.waitForFunction(()=>document.getElementById('home-count').textContent==='2');await a.setOffline(false);await synced(pa);await pb.waitForFunction(()=>document.getElementById('home-count').textContent==='2');
 for(const p of [pa,pb]){await home(p);await p.locator('.skill-card').first().click();await p.locator('#edit-skill').click();}
 await pa.locator('#edit-content').fill('スマホの同時編集');await pa.locator('#save-skill').click();await synced(pa);
 await pb.locator('#edit-content').fill('PCの同時編集');await pb.locator('#save-skill').click();await pb.waitForFunction(()=>!document.getElementById('cloud-conflict').hidden);
 assert.equal(await pb.locator('#detail-content').textContent(),'PCの同時編集');
 await pb.locator('[data-nav="settings"]').last().click();pb.once('dialog',d=>d.accept());await pb.locator('#cloud-use-remote').click();await synced(pb);
 await pb.locator('#cloud-history-load').click();await pb.waitForFunction(()=>document.querySelectorAll('#cloud-history button').length===3);
 const head=env.DB.sql.prepare('SELECT revision FROM cloud_state').get().revision;assert.equal(head,4);
 assert.equal(env.DB.sql.prepare('SELECT count(*) n FROM backups WHERE revision IS NOT NULL').get().n,3);
 assert.equal(errors.length,0,errors.join('\n'));
 await pa.locator('[data-nav="settings"]').last().click();await pa.screenshot({path:process.env.CLOUD_MOBILE_SCREENSHOT||'/tmp/skill-deck-cloud-mobile.png',fullPage:true});
 await home(pb);await pb.screenshot({path:process.env.CLOUD_PC_SCREENSHOT||'/tmp/skill-deck-cloud-pc.png',fullPage:true});
 console.log('PASS: mobile/PC round trip, offline reload/retry, concurrent conflict preservation, 3-generation history, no browser errors');
}finally{await browser.close();server.close();}

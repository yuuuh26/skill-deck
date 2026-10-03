import {readAll,syncState,updateSync,captureSync,applyRemote,safetyCopy} from './db.js';
import {makeBackup,validateBackup,downloadText,filename} from './backup.js';
import {digest} from './cloudflare/snapshot.js';
export const CLOUD_URL='https://skill-deck-cloud.dengana-10011212.workers.dev';
export function setupCloud({refresh,isEditing,toast}) {
 const $=id=>document.getElementById(id);
 const enabled=location.origin===CLOUD_URL;
 let connected=false,busy=false,conflict=null,retryTimer,deviceName='',sessionId='',authKnown=false;
 const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('skill-deck-sync'):null;
 const status=async message=>{
  const s=await syncState();
  $('cloud-status').textContent=message;
  $('sync-indicator').textContent=message;
  $('cloud-last').textContent=s.lastSuccess?'前回の同期：'+new Date(s.lastSuccess).toLocaleString('ja-JP'):'クラウド保存：まだありません';
  $('cloud-pending').textContent=s.localRevision>s.ackRevision?'端末に保存済み・未送信の変更あり':'未送信の変更なし';
  $('cloud-device').textContent=connected?'接続端末：'+deviceName:'復旧キーでこの端末を接続してください';
  $('cloud-connect-form').hidden=connected; $('cloud-logout').hidden=!connected;
  $('cloud-conflict').hidden=!conflict;
 };
 async function api(path,body,key,method) {
  const response=await fetch('/v1/'+path,{method:method||(body?'POST':'GET'),credentials:'same-origin',cache:'no-store',headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{Authorization:'Bearer '+key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  if(!response.ok){const error=Error(result.error||'通信に失敗しました');error.status=response.status;throw error;}return result;
 }
 async function stored(id){const r=await api('backups/'+id);validateBackup(r.backup);if(await digest(JSON.stringify(r.backup.data))!==r.sha256)throw Error('クラウドの内容を照合できません');return r;}
 function schedule(ms=1000){clearTimeout(retryTimer);retryTimer=setTimeout(()=>tick(),ms);}
 async function failure(e){
  if(e.status===401){connected=false;await status('認証が解除されています。再接続してください');}
  else if(e.status===409){conflict=await api('state');await status('別端末との変更を確認してください');toast('別端末にも変更があります。設定で内容を選んでください');}
  else {await status(navigator.onLine?'通信失敗・端末の変更を保持しています':'オフライン・端末に保存済み');if(connected)schedule(15000);}
 }
 async function tickInner(){
  if(!connected||!navigator.onLine||conflict)return;
  let s=await syncState();
  if(s.inFlight) {await send(); s=await syncState();}
  const head=await api('state');
  if(!s.initialized){
   const local=await readAll();
   if(head.operation_id){
    const remote=await stored(head.operation_id);
    if(JSON.stringify(local)===JSON.stringify(remote.backup.data)){await updateSync(x=>({...x,initialized:true,cloudRevision:head.revision,ackRevision:x.localRevision}));}
    else if(!local.families.length&&!local.versions.length&&s.localRevision===0&&!isEditing()) {await applyRemote(remote.backup.data,head.revision,s.localRevision);await refresh();channel?.postMessage('refresh');}
    else {conflict=head;await status('端末とクラウドの内容を確認してください');return;}
   }else{
    await updateSync(x=>({...x,initialized:true,cloudRevision:0,localRevision:(local.families.length||local.versions.length)&&x.localRevision===x.ackRevision?x.localRevision+1:x.localRevision}));
   }
   s=await syncState();
  }
  if(head.revision!==s.cloudRevision) {
   if(s.localRevision>s.ackRevision){conflict=head;await status('別端末との変更を確認してください');toast('別端末にも変更があります。設定で内容を選んでください');return;}
   if(isEditing()){await status('別端末の更新あり・編集の保存後に確認');return;}
   const remote=await stored(head.operation_id);
   if(isEditing())return;
   await applyRemote(remote.backup.data,head.revision,s.localRevision);await refresh();channel?.postMessage('refresh');
  }
  if((await syncState()).localRevision>(await syncState()).ackRevision)await send();
  const final=await syncState();await status(final.localRevision>final.ackRevision?'端末に保存済み・送信待ち':'クラウドと同期済み');
 }
 async function send(){
  const job=await captureSync(makeBackup);if(!job)return;
  await status('端末に保存済み・クラウド送信中');
  const result=await api('backups',job);
  if(result.operation_id!==job.operationId||result.sha256!==await digest(JSON.stringify(job.backup.data)))throw Error('保存結果を照合できません');
  await updateSync(x=>x.inFlight?.operationId===job.operationId?{...x,ackRevision:Math.max(x.ackRevision,job.localRevision),cloudRevision:result.revision,inFlight:null,lastSuccess:new Date().toISOString()}:x);
  channel?.postMessage('refresh');
  if((await syncState()).localRevision>job.localRevision)schedule(1000);
 }
 async function tick(){
  if(!enabled||busy)return;busy=true;
  try{if(navigator.locks)await navigator.locks.request('skill-deck-cloud-sync',tickInner);else await status('自動同期には最新のChrome / Edge / Safariを使用してください');}
  catch(e){try{await failure(e);}catch{await status('通信失敗・端末の変更を保持しています');schedule(15000);}}
  finally{busy=false;}
 }
 async function exclusive(fn){if(busy){toast('同期処理の完了後に再試行してください');return;}busy=true;try{await navigator.locks.request('skill-deck-cloud-sync',fn);}catch(e){toast(e.message);await failure(e);}finally{busy=false;}}
 async function choose(useCloud){await exclusive(async()=>{
  if(isEditing())throw Error('編集内容を保存してから選択してください');
  const head=await api('state'),s=await syncState(),local=await readAll();
  const remote=head.operation_id?await stored(head.operation_id):null;
  const text=useCloud?`クラウド：Skill ${remote?.record_count||0}件 / 版 ${remote?.version_count||0}件（${new Date(remote?.saved_at).toLocaleString('ja-JP')}）\n端末：Skill ${local.families.length}件 / 版 ${local.versions.length}件\n現在の端末データを退避して、クラウドの内容を使いますか？`:`端末：Skill ${local.families.length}件 / 版 ${local.versions.length}件\nクラウド：Skill ${remote?.record_count||0}件 / 版 ${remote?.version_count||0}件\n端末の内容を新しいクラウド版として保存しますか？（元のクラウド版は3世代の履歴に残ります）`;
  if(!window.confirm(text))return;
  if(isEditing()||(await syncState()).localRevision!==s.localRevision)throw Error('確認中に変更されました。再確認してください');
  downloadText(filename('json'),JSON.stringify(makeBackup(local),null,2),'application/json');
  if(useCloud){if(!remote)throw Error('クラウドにデータがありません');await applyRemote(remote.backup.data,head.revision,s.localRevision);await refresh();}
  else await updateSync(x=>({...x,initialized:true,cloudRevision:head.revision,inFlight:null,localRevision:x.localRevision+1}));
  conflict=null;channel?.postMessage('refresh');schedule(10);
 });}
 async function history(){await exclusive(async()=>{
  const result=await api('backups');$('cloud-history').replaceChildren();
  if(!result.backups.length)$('cloud-history').textContent='保存履歴はまだありません';
  for(const row of result.backups){const button=document.createElement('button');button.className='setting-action';button.textContent=`${new Date(row.saved_at).toLocaleString('ja-JP')} · Skill ${row.record_count}件 / 版 ${row.version_count}件 → 復元`;
   button.onclick=()=>exclusive(async()=>{
    if(isEditing())throw Error('編集内容を保存してから復元してください');
    const s=await syncState(),head=await api('state'),r=await stored(row.operation_id);
    if(!window.confirm(`${new Date(row.saved_at).toLocaleString('ja-JP')}のSkill ${row.record_count}件 / 版 ${row.version_count}件に戻します。\n現在の端末データを退避して復元しますか？`))return;
    if(isEditing())throw Error('編集内容を保存してから復元してください');
    await applyRemote(r.backup.data,head.revision,s.localRevision);
    await updateSync(x=>({...x,localRevision:x.localRevision+1}));conflict=null;await refresh();channel?.postMessage('refresh');schedule(10);toast('復元しました。クラウドへ保存します');
   });$('cloud-history').append(button);}
 });}
 async function admin(path,body){let key=$('cloud-admin-key').value.trim();$('cloud-admin-key').value='';if(!key)throw Error('端末管理には復旧キーを入力してください');try{return await api(path,body,key);}finally{key='';}}
 async function devices(){await exclusive(async()=>{
  const {sessions}=await admin('sessions',{});$('cloud-devices').replaceChildren();
  for(const d of sessions){const box=document.createElement('div');box.className='device-row';const p=document.createElement('p');p.textContent=`${d.deviceName}${d.id===sessionId?'（この端末）':''}\n接続：${new Date(d.createdAt).toLocaleString('ja-JP')}\n最終利用：${new Date(d.lastUsedAt).toLocaleString('ja-JP')}`;box.append(p);
   for(const [label,path,bodyFn] of [['名前を変更','sessions/rename',()=>{const name=prompt('新しい端末名',d.deviceName);return name?{sessionId:d.id,deviceName:name}:null;}],['接続を解除','sessions/revoke',()=>confirm('この端末の接続を解除しますか？')?{sessionId:d.id}:null]]){const b=document.createElement('button');b.className='secondary-button';b.textContent=label;b.onclick=()=>exclusive(async()=>{const body=bodyFn();if(!body)return;await admin(path,body);toast('更新しました。復旧キーを入力して一覧を更新してください');box.remove();if(d.id===sessionId){if(path.endsWith('revoke'))connected=false;else deviceName=body.deviceName;await status(connected?'端末名を更新しました':'この端末の接続を解除しました');}});box.append(b);}$('cloud-devices').append(box);}
 });}
 if(!enabled){$('cloud-controls').hidden=true;$('cloud-migration').hidden=false;$('cloud-open').href=CLOUD_URL+'/';$('cloud-status').textContent='スマホ・PC共有はクラウド版へ';$('sync-indicator').textContent='端末に保存';return;}
 $('cloud-connect-form').onsubmit=async e=>{e.preventDefault();let key=$('cloud-key').value.trim();$('cloud-key').value='';try{const result=await api('session',{deviceName:$('cloud-name').value.trim()||(/Android|iPhone/.test(navigator.userAgent)?'スマホ':'パソコン')},key);authKnown=true;connected=true;deviceName=result.deviceName;sessionId=result.sessionId;conflict=null;await status('接続しました・同期を確認中');await tick();}catch(e){toast(e.message);await status('未接続・端末のデータは保存されています');}finally{key='';}};
 $('cloud-now').onclick=()=>tick();$('cloud-use-remote').onclick=()=>choose(true);$('cloud-use-local').onclick=()=>choose(false);
 $('cloud-history-load').onclick=history;$('cloud-devices-load').onclick=devices;
 $('cloud-logout').onclick=async()=>{try{await api('session/logout',{});connected=false;conflict=null;await status('未接続・端末のデータは保存されています');}catch(e){toast(e.message);}};
 $('cloud-revoke-all').onclick=()=>exclusive(async()=>{if(!confirm('スマホ・パソコンを含む全端末の接続を解除しますか？'))return;await admin('sessions/revoke',{all:true});connected=false;await status('全端末の接続を解除しました');});
 $('cloud-rotate').onclick=()=>exclusive(async()=>{if(!confirm('復旧キーを変更して、全端末の接続を解除しますか？新しいキーをファイルで保管してください。'))return;const r=await admin('sessions/rotate',{});downloadText('skill-deck-recovery-key.txt',`Skill Deck 復旧キー\n${r.recoveryKey}\n\nクラウド版：${CLOUD_URL}/\nこのキーは非公開で保管してください。\n`,'text/plain');$('cloud-new-key').textContent=r.recoveryKey;$('cloud-new-key').hidden=false;connected=false;await status('キーを変更しました。新しいキーで再接続してください');});
 $('cloud-safety-export').onclick=async()=>{const copy=await safetyCopy();if(!copy){toast('退避データはまだありません');return;}downloadText(filename('json'),JSON.stringify(makeBackup(copy),null,2),'application/json');toast('復元前の退避データを書き出しました');};
 window.addEventListener('skill-deck-changed',()=>{status(connected?'端末に保存済み・送信待ち':'未接続・端末に保存済み');channel?.postMessage('local');schedule();});
 channel && (channel.onmessage=async()=>{if(!isEditing())await refresh();schedule();});
 window.addEventListener('online',async()=>{if(!authKnown)await reconnect();schedule(10);});
 window.addEventListener('offline',()=>status('オフライン・端末に保存済み'));
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')schedule(10);});
 window.addEventListener('focus',()=>schedule(10));
 setInterval(()=>{if(document.visibilityState==='visible')tick();},3000);
 async function reconnect(){try{const s=await api('session');authKnown=true;connected=true;deviceName=s.deviceName;sessionId=s.sessionId;await tick();}catch(e){if(e.status===401)authKnown=true;await status(e.status===401?'未接続・端末に保存済み':'通信を確認できません・端末に保存済み');}}
 reconnect();
}

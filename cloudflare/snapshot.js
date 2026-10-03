import {validateBackup} from '../backup.js';
export const APP_ID='skill-deck';
export async function digest(text) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function validateInput(input) {
  if(!input || !/^[0-9a-f-]{36}$/.test(input.operationId) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision<0) throw Error('更新番号を確認してください');
  validateBackup(input.backup);
  const json=JSON.stringify(input.backup);
  if(new TextEncoder().encode(json).length>20*1024*1024)throw Error('クラウド保存は20 MBまでです');
  return {json,sha256:await digest(JSON.stringify(input.backup.data))};
}

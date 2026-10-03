import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedFamilies, pinLayout, moveLayout} from '../layout.js';
import {saveVersion, updateSkillLayout, editToolMaster, readAll, syncState, captureSync, applyRemote} from '../db.js';
import {makeBackup, parseBackup} from '../backup.js';
const ids = data => orderedFamilies(data).map(f => f.familyId);
function sample() { return {families:['a','b','c'].map((familyId,i)=>({familyId,currentVersionId:familyId,createdAt:'2026-10-01',updatedAt:`2026-10-0${i+1}`})),versions:['a','b','c'].map((familyId,i)=>({familyId,versionId:familyId,versionNumber:1,title:familyId,content:familyId,aiSupport:[{name:'ChatGPT',status:'使用可能',tools:['Notion'],note:''}],tags:[],note:'',basedOnVersionId:null,createdAt:'2026-10-01',savedAt:`2026-10-0${i+1}`})),settings:{other:'keep'},aiMaster:['ChatGPT'],toolMaster:['Notion']}; }
test('pinning survives new content versions; reordering stays inside groups and honors filters',()=>{
 const data=sample(); assert.deepEqual(ids(data),['c','b','a']);
 data.settings.skillLayout=pinLayout(data,'a'); assert.deepEqual(ids(data),['a','c','b']);
 data.settings.skillLayout=pinLayout(data,'b'); assert.deepEqual(ids(data),['a','b','c']);
 data.settings.skillLayout=moveLayout(data,'a',1,['a','b','c']);assert.deepEqual(ids(data),['b','a','c']);
 assert.throws(()=>moveLayout(data,'a',1,['a','b','c']),/移動できません/);
 data.families[0].currentVersionId='new';data.versions.push({...data.versions[0],versionId:'new',savedAt:'2026-10-09'});assert.deepEqual(ids(data),['b','a','c']);
 data.settings.skillLayout=pinLayout(data,'b');data.settings.skillLayout=pinLayout(data,'a');
 const before=ids(data);data.settings.skillLayout=moveLayout(data,before[0],1,[before[0],before[2]]);assert.deepEqual(ids(data),[before[2],before[1],before[0]]);
});
test('layout and editable tools persist in cloud queue and backup; old skill/tool histories survive',async()=>{
 const original=sample();
 for(let i=0;i<original.families.length;i++)await saveVersion({family:{...original.families[i],expectedCurrentVersionId:null},version:original.versions[i]});
 await updateSkillLayout(data=>pinLayout(data,'a'));await updateSkillLayout(data=>moveLayout(data,'c',1,['a','b','c']));
 let data=await readAll();assert.deepEqual(ids(data),['a','b','c']);
 await editToolMaster('Notion','Notes'); await assert.rejects(()=>editToolMaster('Notes','github'),/すでに/);
 await editToolMaster('Computer Use',null);
 data=await readAll();assert.ok(data.toolMaster.includes('Notes'));assert.ok(!data.toolMaster.includes('Computer Use'));assert.deepEqual(data.versions,original.versions);
 const state=await syncState();const job=await captureSync(makeBackup);assert.equal(job.localRevision,state.localRevision);
 assert.deepEqual(parseBackup(JSON.stringify(job.backup)).data,data);
 await applyRemote(parseBackup(JSON.stringify(job.backup)).data,1,state.localRevision);assert.deepEqual(await readAll(),data);
 const savedVersions=structuredClone(data.versions);for(const name of [...data.toolMaster])await editToolMaster(name,null);
 assert.deepEqual((await readAll()).toolMaster,[]);assert.deepEqual((await readAll()).versions,savedVersions);
 const emptyTools=makeBackup(await readAll());assert.deepEqual(parseBackup(JSON.stringify(emptyTools)).data.toolMaster,[]);
});

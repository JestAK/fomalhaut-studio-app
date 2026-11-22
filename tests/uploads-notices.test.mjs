import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {assertDistinctFiles,fileDigest,MAX_UPLOAD_BYTES} from '../dist/file-checks.js';
import {duplicateCandidates} from '../server/upload-checks.mjs';
import {act,normalizeState} from '../dist/workflow.js';
test('duplicates are detected by contents across names; changed content with same name is allowed',async()=>{
 const a=new File(['same'],'one.wav'),b=new File(['same'],'renamed.wav'),c=new File(['diff'],'one.wav');
 await assert.rejects(assertDistinctFiles([a,b]),/дублюються/);await assertDistinctFiles([a,c]);assert.equal(await fileDigest(a),await fileDigest(b));assert.equal(MAX_UPLOAD_BYTES,2000000000);
 const big=new Uint8Array(5*1024*1024);big[big.length-1]=7;assert.equal(await fileDigest(new File([big],'a')),await fileDigest(new File([big],'b')));
});
test('duplicate scope includes actor fixes but excludes other actors and projects',()=>{
 const t={id:'first',project_id:'p',episode:1,assignee:'a',stage:'recording'},fix={...t,id:'fix',stage:'correction'};
 const state={tasks:[t,fix,{...t,id:'other',assignee:'b'},{...t,id:'project',project_id:'q'}],takes:['first','fix','other','project'].map(task_id=>({id:task_id,task_id}))};assert.deepEqual(duplicateCandidates(state,fix).map(t=>t.id),['first','fix']);
});
test('read one notification is scoped to its owner, idempotent, and leaves others unread',()=>{
 const s=normalizeState({users:[{id:'a',roles:['admin']},{id:'b',roles:['actor']}],notifications:[{id:'1',user_id:'a',read_at:null},{id:'2',user_id:'a',read_at:null},{id:'3',user_id:'b',read_at:null}]});
 act(s,{type:'read-notice',data:{id:'1'}},s.users[0]);const first=s.notifications[0].read_at;assert.ok(first);act(s,{type:'read-notice',data:{id:'1'}},s.users[0]);assert.equal(s.notifications[0].read_at,first);assert.equal(s.notifications[1].read_at,null);assert.throws(()=>act(s,{type:'read-notice',data:{id:'3'}},s.users[0]));assert.equal(s.notifications[2].read_at,null);
 act(s,{type:'read-notices'},s.users[0]);assert.ok(s.notifications[1].read_at);assert.equal(s.notifications[2].read_at,null);
});

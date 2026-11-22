import test from 'node:test';
import assert from 'node:assert/strict';
import {act,normalizeState,PIPELINE} from '../dist/workflow.js';
import {fileLabels} from '../server/file-labels.mjs';
import {buildNoticeBatches} from '../server/notice-batches.mjs';
import {parseTelegramTopicLink,parseTelegramLink} from '../dist/telegram-link.js';
function seed(){return normalizeState({users:[{id:'admin',role:'admin',name:'Admin'},{id:'caster',role:'casting',name:'Caster'},...['a','b','c'].map(id=>({id,name:id,role:'actor'}))],projects:[{id:'p',code:'Anime',title:'Назва аніме',season:2}],memberships:[{project_id:'p',user_id:'caster',role:'casting'},...['a','b','c'].map(user_id=>({project_id:'p',user_id,role:'actor'}))]});}
function castSeed(){const s=seed();act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'casting',assignee:'caster',character:'Субтитри'}},s.users[0]);const t=s.tasks[0];for(let i=0;i<3;i++)s.takes.push({id:'f'+i,task_id:t.id,filename:'file'+i+'.ass',metadata:{},bytes:10});return {s,t};}
test('one task per recipient, distinct actors and shared files; replay creates no extra tasks',()=>{
 const {s,t}=castSeed();const a={type:'cast-batch',task_id:t.id,data:{batch_id:'batch',files:[{take_id:'f0',users:['a','b']},{take_id:'f1',users:['b']},{take_id:'f2',users:['c']}]}};
 act(s,a,s.users[1]);act(s,a,s.users[1]);const ts=s.tasks.filter(t=>t.stage==='recording');assert.equal(ts.length,3);assert.deepEqual(ts.find(t=>t.assignee==='b').script_take_ids,['f0','f1']);assert.deepEqual(ts.find(t=>t.assignee==='c').script_take_ids,['f2']);
 for(const task of ts)assert.ok(s.notifications.some(n=>n.key==='task:'+task.id&&n.user_id===task.assignee));
});
test('casting edit retains submitted recordings and correctly changes recipient files',()=>{
 const {s,t}=castSeed(),caster=s.users[1];act(s,{type:'cast-batch',task_id:t.id,data:{batch_id:'one',files:[{take_id:'f0',users:['a']},{take_id:'f1',users:['b']}]}},caster);
 const b=s.tasks.find(t=>t.assignee==='b');b.status='review';s.takes.push({id:'voice',task_id:b.id,filename:'voice.flac'});
 act(s,{type:'cast-batch',task_id:t.id,data:{batch_id:'two',files:[{take_id:'f0',users:['c']},{take_id:'f2',users:['b']}]}},caster);
 assert.equal(s.tasks.some(t=>t.stage==='recording'&&t.assignee==='a'),false);assert.equal(b.status,'review');assert.deepEqual(b.script_take_ids,['f2']);assert.ok(s.takes.some(t=>t.id==='voice'));
 assert.throws(()=>act(s,{type:'cast-batch',task_id:t.id,data:{batch_id:'three',files:[{take_id:'f0',users:['a']}]}},s.users.find(u=>u.id==='a')));
});
test('single episode add does not generate gaps; delete stays skipped when project plan expands',()=>{
 const s=seed(),admin=s.users[0];act(s,{type:'episode-add',project_id:'p',data:{number:7}},admin);assert.deepEqual(s.episodes.map(e=>e.number),[7]);
 const e=s.episodes[0];assert.throws(()=>act(s,{type:'episode-delete',project_id:'p',data:{number:7,confirm:'wrong'}},admin));act(s,{type:'episode-delete',project_id:'p',data:{number:7,confirm:e.id}},admin);assert.equal(s.episodes.length,0);
 act(s,{type:'project-plan',project_id:'p',data:{count:8}},admin);assert.ok(!s.episodes.some(e=>e.number===7));assert.ok(s.episodes.some(e=>e.number===8));
});
test('progress import validates before mutation, is idempotent and does not send historical assignments',()=>{
 const s=seed(),admin=s.users[0];const data={import_id:'old1',number:9,rows:[{stage:'recording',assignee:'a',status:'approved',links:['https://t.me/c/1234567890/42/55']},{stage:'review',assignee:'caster',status:'planned',links:[]}]};
 assert.throws(()=>act(s,{type:'progress-import',project_id:'p',data},admin));assert.equal(s.tasks.length,0);
 data.rows.pop();act(s,{type:'progress-import',project_id:'p',data},admin);act(s,{type:'progress-import',project_id:'p',data},admin);assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].legacy_links.length,1);assert.equal(s.notifications.filter(n=>n.key.startsWith('task:')).length,0);assert.equal(s.episodes[0].nextMode,'manual');
 assert.throws(()=>act(s,{type:'progress-import',project_id:'p',data:{...data,import_id:'other'}},admin));
});
test('file labels preserve Unicode, season, extension and FIX iteration',()=>{
 const x=fileLabels({title:'Назва Проєкту',code:'Code',season:2},{episode:3,stage:'correction',fix_iteration:2},{name:'Нік'},'.FLAC');assert.equal(x.filename,'Нік_S02E03_Code_VO_FIX2.flac');assert.equal(x.caption,'Нік Назва Проєкту S02E03\n#Назва_Проєкту_S02E03');
});
test('topic link is explicit while file parser retains message semantics',()=>{const url='https://t.me/c/1234567890/42';assert.equal(parseTelegramTopicLink(url).threadId,42);assert.equal(parseTelegramLink(url).threadId,null);});
test('notifications group by actual recipient and delay audit but not task assignments',()=>{
 const now=1000000,n=(age,user_id,key)=>({created_at:new Date(now-age).toISOString(),user_id,key,message:'Подія',next_attempt:0});
 assert.equal(buildNoticeBatches([n(59000,'a','admin:1')],now).length,0);
 const batches=buildNoticeBatches([n(60001,'a','admin:1'),n(60002,'a','admin:2'),n(4000,'b','task:3'),n(4000,'c','task:4')],now);assert.equal(batches.length,3);assert.deepEqual(batches.map(b=>b[0].user_id),['a','b','c']);assert.equal(batches[0].length,2);
});

test('controlled casting activates actor tasks automatically and respects explicit manual recording gate',()=>{
 for(const manual of [false,true]){
  const s=seed(),admin=s.users[0],caster=s.users[1];act(s,{type:'episode-add',project_id:'p',data:{number:2}},admin);
  const e=s.episodes[0];e.pendingStages=['casting'];if(manual)e.stageModes.recording='manual';
  act(s,{type:'episode-start',project_id:'p',data:{number:2,stage:'casting'}},admin);
  const t=s.tasks.find(t=>t.stage==='casting');s.takes.push({id:'sub',task_id:t.id,filename:'a.srt'});
  act(s,{type:'cast-batch',task_id:t.id,data:{batch_id:'gate-test',files:[{take_id:'sub',users:['a','b','c']}]}},caster);
  const assigned=s.tasks.filter(t=>t.stage==='recording');assert.equal(assigned.length,3);
  for(const a of assigned){assert.equal(a.status,manual?'planned':'todo');assert.equal(s.notifications.some(n=>n.user_id===a.assignee&&n.key==='task:'+a.id),!manual);}
 }
});

import {subtitleLines,castingSummary,castingLabels} from '../server/casting.mjs';
test('subtitle cue counts and group summary use nicknames without mentions',()=>{
 assert.equal(subtitleLines('1\n00:00:01,000 --> 00:00:02,000\nHello\nworld\n\n2\n00:00:03,000 --> 00:00:04,000\nHi','a.srt'),2);
 assert.equal(subtitleLines('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\nComment: x','a.ass'),1);
 assert.equal(subtitleLines('WEBVTT\n\n00:01.000 --> 00:02.000\nHi','a.vtt'),1);
 assert.equal(subtitleLines('binary','a.zip'),null);
 const p={title:'Хибні спогади',code:'Spohady',season:1},t={stage:'casting',episode:7},users=[{id:'a',name:'ActorA'},{id:'b',name:'ActorB'}];
 const summary=castingSummary(p,t,[{users:['a'],lines:73},{users:['b'],lines:63}],users).join('');assert.match(summary,/ActorA — 73/);assert.match(summary,/ActorB — 63/);assert.ok(!summary.includes('@'));assert.match(summary,/#Хибні_спогади_S01E07/);
 assert.equal(castingLabels(p,t,[users[0]],'.srt').filename,'ActorA_S01E07_Spohady_Roles.srt');
});

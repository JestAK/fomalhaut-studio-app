import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {migrate,readWorkflow,command} from '../server/workflow-store.mjs';
import {PIPELINE,assertProjectCode,allowedUpload,reviewActors,priorityCompare,matchSubtitle,act,normalizeState,deadlineDays} from '../dist/workflow.js';
function seed(){return normalizeState({users:[{id:'a',role:'admin'},{id:'tr',role:'translator'},{id:'ed',role:'editor'},{id:'new',role:'editor'},{id:'x',role:'actor'}].map(u=>({...u,name:u.id})),projects:[{id:'p',title:'Project',code:'P',description:''}],memberships:[{project_id:'p',user_id:'tr',role:'translator'},{project_id:'p',user_id:'ed',role:'editor'}]});}
test('deadline precedence, manual date, replacement and idempotent stage handoff',()=>{
 let s=seed(),admin=s.users[0];
 for(const [scope,scope_id,days] of [['global','*',10],['project','p',8],['user','tr',6]])act(s,{type:'rule',data:{scope,scope_id,role:'translator',days}},admin);
 act(s,{type:'episode',project_id:'p',data:{number:1}},admin,'2026-01-01T00:00:00.000Z');
 let tr=s.tasks[0];assert.equal(tr.deadline,'2026-01-07T00:00:00.000Z');
 act(s,{type:'rule',data:{scope:'episode',scope_id:'p:1',role:'translator',days:2}},admin);assert.equal(deadlineDays(s,tr),2);assert.equal(tr.deadline,'2026-01-07T00:00:00.000Z');
 act(s,{type:'task-edit',task_id:tr.id,data:{deadline:'2026-01-20T00:00:00Z'}},admin);assert.equal(tr.deadline_manual,1);
 act(s,{type:'complete',task_id:tr.id,data:{output_url:'https://example.com/subs'}},s.users[1]);
 const editing=s.tasks.find(t=>t.stage==='editing');assert.equal(editing.assignee,'ed');
 act(s,{type:'complete',task_id:tr.id},s.users[1]);assert.equal(s.tasks.filter(t=>t.stage==='editing').length,1);
 act(s,{type:'members',project_id:'p',data:{members:[{user_id:'tr',role:'translator'},{user_id:'new',role:'editor'}]}},admin);assert.equal(editing.assignee,'new');assert.equal(tr.status,'approved');
 assert.throws(()=>act(s,{type:'user',user_id:'a',data:{access:'blocked'}},admin));
 assert.throws(()=>act(s,{type:'complete',task_id:editing.id,data:{output_url:'https://example.com'}},s.users.find(u=>u.id==='ed')));
});
test('legacy migration is transactional and repeatable; SQLite backup/restore preserves users, roles, deadlines and file IDs',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-migrate-'));let db,restored;
 try{
   const src=await readFile(new URL('../server/index.mjs',import.meta.url),'utf8');const ddl=src.slice(src.indexOf('db.exec(`PRAGMA')+9,src.indexOf('`);',src.indexOf('db.exec(`PRAGMA')));
   db=new DatabaseSync(path.join(dir,'old.sqlite'));db.exec(ddl);
   db.exec(`INSERT INTO users(id,name,role) VALUES('a','Admin','admin'),('x','Actor','actor');INSERT INTO projects(id,title,code) VALUES('p','Old project','Old');INSERT INTO tasks(id,project_id,episode,character,assignee,deadline,status) VALUES('t','p',1,'Voice','x','2026-12-01T00:00:00Z','approved');INSERT INTO takes VALUES('f','t',1,'old.flac','telegram-old-file',11,'-100123',42,100,'{}','2026-10-01');`);
   migrate(db);migrate(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,2);
   command(db,{type:'user',user_id:'x',data:{roles:['actor','editor']}},{id:'a'});
   command(db,{type:'project',project_id:'p',data:{title:'Old project',code:'Old',description:'',paid:1}},{id:'a'});
   assert.equal(readWorkflow(db).projects[0].paid,1);
   command(db,{type:'project-plan',project_id:'p',data:{count:2}},{id:'a'});command(db,{type:'reminders',data:{interval:48,ahead:2}},{id:'a'});
   const old=readWorkflow(db);assert.equal(old.projects[0].episode_count,2);assert.equal(old.episodes[0].controlled,true);assert.equal(old.profiles[0].reminder_hours,48);assert.equal(old.takes[0].file_id,'telegram-old-file');assert.equal(old.tasks[0].deadline,'2026-12-01T00:00:00Z');assert.equal(old.users.find(u=>u.id==='x').access,'active');
   // WAL stays open while backing up; committed changes must survive in a standalone file.
   const target=path.join(dir,'backup.sqlite');await backup(db,target);restored=new DatabaseSync(target);migrate(restored);
   assert.deepEqual(readWorkflow(restored),old);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   restored.prepare("INSERT INTO schema_migrations VALUES(999,'future')").run();assert.throws(()=>migrate(restored),/новіша/);
 }finally{db?.close();restored?.close();await rm(dir,{recursive:true,force:true});}
});

test('guests have no identity login and admin changes notify only other admins',()=>{
 const s=seed(),admin=s.users[0];s.users.push({id:'admin2',name:'Other',roles:['admin'],access:'active'});
 act(s,{type:'guest',data:{name:'Guest actor'}},admin);
 const guest=s.users.find(u=>u.id.startsWith('guest:'));assert.equal(guest.name,'Guest actor');assert.equal(guest.notify,0);
 assert.equal(s.notifications.filter(n=>n.user_id==='admin2').length,1);
 assert.equal(s.notifications.filter(n=>n.user_id===admin.id).length,0);
 assert.throws(()=>act(s,{type:'guest',data:{name:'No'}},s.users.find(u=>u.id==='x')));
 assert.throws(()=>act(s,{type:'read-notices'},guest));
});

test('manual tasks and subtitle batches: required mapping, shared files, aliases, idempotency',()=>{
 const s=seed(),a=s.users[0];a.roles=['admin','casting'];s.memberships.push({project_id:'p',user_id:'x',role:'actor'});
 act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'other',assignee:'x',character:'Poster',note:'Prepare poster'}},a);
 const manual=s.tasks.at(-1);act(s,{type:'complete',task_id:manual.id},s.users.find(u=>u.id==='x'));assert.equal(manual.status,'approved');assert.equal(s.episodes.length,0);
 act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'casting',assignee:'a',character:'Subs',note:'Distribute'}},a);
 const casting=s.tasks.at(-1);s.takes.push({id:'sub',task_id:casting.id,filename:'Short_P_01.ass',metadata:{original_name:'Short_P_01.ass'}});
 const action={type:'cast-batch',task_id:casting.id,data:{batch_id:'batch',files:[{take_id:'sub',users:[]}]}};
 assert.throws(()=>act(s,action,a),/Кожному/);assert.equal(s.tasks.length,2);
 action.data.files[0]={take_id:'sub',users:['x'],alias:'Short'};act(s,action,a);
 assert.equal(s.tasks.at(-1).script_take_ids[0],'sub');assert.equal(s.tasks.at(-1).independent,1);
 assert.deepEqual(matchSubtitle(s,'SHORT_Project_01.ass','p'),['x']);
 const count=s.tasks.length;act(s,action,a);assert.equal(s.tasks.length,count);
});

test('paid projects default to unpaid and sort ahead without changing deadlines',()=>{
 const s=seed();s.projects.push({id:'paid',title:'Paid',code:'Paid',description:''});normalizeState(s);assert.equal(s.projects[0].paid,0);
 act(s,{type:'project',project_id:'paid',data:{title:'Paid',code:'Paid',description:'',paid:1}},s.users[0]);
 const unpaid={id:'u',project_id:'p',deadline:'2026-01-01'},paid={id:'p',project_id:'paid',deadline:'2026-12-01'};
 assert.deepEqual([paid,unpaid].sort((a,b)=>priorityCompare(s,a,b)),[unpaid,paid]);assert.deepEqual([unpaid,paid].sort((a,b)=>priorityCompare(s,a,b,true)),[paid,unpaid]);assert.ok(priorityCompare(s,{...unpaid,deadline:'2026-12-01T08:00:00'},{...paid,deadline:'2026-12-01T20:00:00'})>0);assert.equal(unpaid.deadline,'2026-01-01');
});

test('repeated fixes reopen mixing and notify following roles about changed completed files',()=>{
 const s=seed(),a=s.users[0];s.users.push({id:'sound',name:'Sound',roles:['engineer'],access:'active'},{id:'checker',name:'Checker',roles:['reviewer'],access:'active'});
 s.memberships.push({project_id:'p',user_id:'sound',role:'engineer'},{project_id:'p',user_id:'checker',role:'reviewer'});
 s.episodes.push({id:'e',project_id:'p',number:1,stage:'done',review_done:1,ready_notified:1});
 s.tasks.push({id:'record',project_id:'p',episode:1,character:'Voice',stage:'recording',assignee:'x',status:'approved',deadline:'2026-11-01'});
 s.takes.push({id:'take',task_id:'record'});
 act(s,{type:'request-fix',task_id:'record',data:{note:'Repeat line',take_id:'take'}},s.users.find(u=>u.id==='sound'));
 const fix=s.tasks.at(-1);assert.equal(fix.fix_iteration,1);assert.equal(s.episodes[0].ready_notified,0);
 s.takes.push({id:'fix-take',task_id:fix.id});act(s,{type:'uploaded',task_id:fix.id,take_id:'fix-file'},s.users.find(u=>u.id==='x'));
 act(s,{type:'request-fix',task_id:fix.id,data:{note:'Again'}},a);assert.equal(s.tasks.at(-1).fix_iteration,2);
 assert.throws(()=>act(s,{type:'request-fix',task_id:'record',data:{note:'No'}},s.users.find(u=>u.id==='x')));
 act(s,{type:'uploaded',task_id:'record',take_id:'replacement'},s.users.find(u=>u.id==='x'));
 assert.ok(s.notifications.some(n=>n.user_id==='checker'&&n.key==='material:replacement'));assert.equal(s.tasks.find(t=>t.id==='record').status,'approved');
});


test('review batches notify only checked actors, create fixes only when needed, reject stale snapshots and replay safely',()=>{
 const s=seed(),admin=s.users[0];s.users.push({id:'y',name:'Y',roles:['actor'],access:'active'},{id:'z',name:'Z',roles:['actor'],access:'active'},{id:'r',name:'Reviewer',roles:['reviewer'],access:'active'});
 const reviewer=s.users.at(-1);
 for(const uid of ['x','y','z']){act(s,{type:'task-create',data:{project_id:'p',episode:7,stage:'recording',assignee:uid,character:uid}},admin);const t=s.tasks.at(-1);t.status='review';s.takes.push({id:'file-'+uid,task_id:t.id,filename:uid+'.flac',metadata:{}});}
 act(s,{type:'task-create',data:{project_id:'p',episode:7,stage:'review',assignee:'r',character:'Review'}},admin);const review=s.tasks.at(-1);
 const entries=reviewActors(s,review).filter(r=>r.user_id!=='z').map(r=>({user_id:r.user_id,status:r.user_id==='x'?'fix':'clear',take_ids:r.take_ids}));
 entries.find(e=>e.user_id==='x').notion_snapshot_id='snapshot-x';
 const action={type:'review-notify',task_id:review.id,data:{entries}};
 assert.throws(()=>act(s,action,s.users.find(u=>u.id==='x')),/іншого/);
 act(s,action,reviewer);const count=s.notifications.length;act(s,action,reviewer);assert.equal(s.notifications.length,count);
 assert.equal(s.tasks.filter(t=>t.stage==='correction').length,1);assert.equal(s.tasks.find(t=>t.stage==='correction').assignee,'x');assert.equal(s.tasks.find(t=>t.stage==='correction').notion_snapshot_id,'snapshot-x');assert.ok(!s.tasks.some(t=>t.assignee==='y'&&t.notion_snapshot_id));
 assert.equal(review.status,'working');assert.deepEqual(reviewActors(s,review).filter(r=>r.notified).map(r=>r.user_id),['x','y']);
 assert.ok(s.notifications.some(n=>n.user_id==='y'&&n.message.includes('правок немає')));assert.ok(!s.notifications.some(n=>n.user_id==='z'&&n.key.startsWith('review:')));
 const row=reviewActors(s,review).find(r=>r.user_id==='z');s.takes.push({id:'new-z',task_id:row.tasks[0].id,filename:'z-new.flac',metadata:{replaces:'file-z'}});
 assert.throws(()=>act(s,{...action,data:{entries:[{user_id:'z',status:'clear',take_ids:row.take_ids}]}},reviewer),/змінилися/);
 act(s,{...action,data:{entries:[{user_id:'z',status:'clear',take_ids:['new-z']}]}},reviewer);assert.equal(review.status,'approved');
 const x=s.tasks.find(t=>t.stage==='recording'&&t.assignee==='x');s.takes.push({id:'extra-x',task_id:x.id,filename:'extra.flac',metadata:{}});
 act(s,{type:'uploaded',task_id:x.id,take_id:'extra-x'},s.users.find(u=>u.id==='x'));assert.equal(review.status,'working');assert.equal(reviewActors(s,review).find(r=>r.user_id==='x').notified,false);
});


test('subtitle-only stages, manual Telegram attachments and changing a notified review result',()=>{
 for(const stage of ['translation','editing','casting']){assert.ok(allowedUpload(stage,'Nick.ass'));assert.ok(allowedUpload(stage,'Pack.ZIP'));assert.equal(allowedUpload(stage,'audio.flac'),false);assert.equal(allowedUpload(stage,'movie.mp4'),false);}
 const s=seed(),admin=s.users[0];s.users.push({id:'cast',name:'Cast',roles:['casting'],access:'active'},{id:'rev',name:'Rev',roles:['reviewer'],access:'active'});s.memberships.push({project_id:'p',user_id:'x',role:'actor'});
 act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'casting',assignee:'cast',character:'Subs'}},admin);const c=s.tasks.at(-1);
 act(s,{type:'cast-batch',task_id:c.id,data:{batch_id:'manual',files:[{link:'https://t.me/c/1234567890/42/200',filename:'x_Project_1.ass',users:['x']}]}},s.users.find(u=>u.id==='cast'));
 const recording=s.tasks.at(-1);assert.equal(recording.character,'Запис · x');assert.equal(recording.script_links.length,1);s.takes.push({id:'rfile',task_id:recording.id,metadata:{}});recording.status='review';
 act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'review',assignee:'rev',character:'Review'}},admin);const review=s.tasks.at(-1),rev=s.users.at(-1),entry={user_id:'x',take_ids:['rfile'],status:'fix'};
 act(s,{type:'review-notify',task_id:review.id,data:{entries:[entry]}},rev);const fix=s.tasks.find(t=>t.stage==='correction');assert.ok(fix);assert.equal(fix.fix_iteration,1);assert.equal(fix.script_links.length,1);
 act(s,{type:'review-reopen',task_id:review.id,data:{user_id:'x'}},rev);assert.equal(reviewActors(s,review)[0].notified,false);
 act(s,{type:'review-notify',task_id:review.id,data:{entries:[{...entry,status:'clear'}]}},rev);assert.equal(fix.status,'approved');assert.equal(s.tasks.filter(t=>t.stage==='correction').length,1);assert.equal(review.review_results.x.status,'clear');
 const n=s.notifications.length;act(s,{type:'review-notify',task_id:review.id,data:{entries:[{...entry,status:'clear'}]}},rev);assert.equal(s.notifications.length,n);
});

test('blocking role change exposes the actual task IDs',()=>{const s=seed(),a=s.users[0];act(s,{type:'task-create',data:{project_id:'p',episode:1,stage:'editing',assignee:'ed',character:'Edit'}},a);const id=s.tasks.at(-1).id;assert.throws(()=>act(s,{type:'user',user_id:'ed',data:{roles:['actor']}},a),e=>e.task_ids.includes(id));});

test('planned episodes, isolated stages, general tasks and admin status controls',()=>{
 const s=seed(),a=s.users[0];
 act(s,{type:'project-plan',project_id:'p',data:{count:3}},a);
 assert.equal(s.episodes.length,3);assert.equal(s.tasks.length,6);assert.ok(s.tasks.every(t=>t.status==='planned'&&!t.deadline));
 const tr=s.tasks.find(t=>t.episode===1&&t.stage==='translation');
 assert.throws(()=>act(s,{type:'start',task_id:tr.id},s.users[1]));
 assert.throws(()=>act(s,{type:'episode-start',project_id:'p',data:{number:1,mode:'single',stage:'translation'}},s.users[1]));
 act(s,{type:'episode-settings',project_id:'p',data:{number:1,nextMode:'manual',modes:Object.fromEntries(PIPELINE.map(k=>[k,k==='editing'?'manual':'auto']))}},a);
 act(s,{type:'episode-start',project_id:'p',data:{number:1,stage:'translation'}},a,'2026-01-01T00:00:00Z');
 assert.equal(tr.status,'todo');assert.equal(tr.deadline,'2026-01-04T00:00:00.000Z');
 act(s,{type:'complete',task_id:tr.id,data:{output_url:'https://example.com/sub.ass'}},s.users[1]);
 assert.equal(s.tasks.find(t=>t.episode===1&&t.stage==='editing').status,'planned');
 act(s,{type:'episode-start',project_id:'p',data:{number:1,stage:'editing'}},a);
 assert.equal(s.tasks.find(t=>t.episode===1&&t.stage==='editing').status,'todo');
 const last=s.tasks.find(t=>t.episode===3);act(s,{type:'episode-start',project_id:'p',data:{number:3,stage:'translation',mode:'single'}},a);
 act(s,{type:'task-status',task_id:last.id,data:{status:'approved'}},a);
 assert.throws(()=>act(s,{type:'project-plan',project_id:'p',data:{count:2}},a),e=>e.task_ids.includes(last.id));
 act(s,{type:'task-delete',task_id:last.id},a);act(s,{type:'project-plan',project_id:'p',data:{count:2}},a);assert.equal(s.episodes.length,2);
 act(s,{type:'task-create',data:{project_id:'general',stage:'other',character:'Пост для команди',assignee:'x'}},a);const general=s.tasks.at(-1);assert.equal(general.episode,0);
 assert.throws(()=>act(s,{type:'task-status',task_id:general.id,data:{status:'approved'}},s.users.at(-1)));
 act(s,{type:'task-status',task_id:general.id,data:{status:'approved'}},a);assert.equal(general.status,'approved');
 act(s,{type:'task-status',task_id:general.id,data:{status:'todo'}},a);assert.equal(general.completed_at,null);
 act(s,{type:'reminders',data:{interval:48,ahead:3}},s.users.at(-1));assert.equal(s.profiles.at(-1).reminder_hours,48);assert.equal(s.profiles.at(-1).reminder_days,3);
});

test('stage gates resume automatically, next episode can start early, codes are unique',()=>{
 const s=seed(),a=s.users[0],modes=Object.fromEntries(PIPELINE.map(k=>[k,'auto']));
 s.users.push({id:'cast',name:'Cast',roles:['casting'],access:'active'},{id:'mix',name:'Mix',roles:['engineer'],access:'active'});
 s.memberships.push({project_id:'p',user_id:'cast',role:'casting'},{project_id:'p',user_id:'mix',role:'engineer'});
 act(s,{type:'project-plan',project_id:'p',data:{count:3}},a);
 act(s,{type:'episode-settings',project_id:'p',data:{number:1,modes:{...modes,editing:'manual'},nextMode:'auto'}},a);
 act(s,{type:'episode-start',project_id:'p',data:{number:1}},a);
 const task=(n,k)=>s.tasks.find(t=>t.episode===n&&t.stage===k);
 act(s,{type:'complete',task_id:task(1,'translation').id,data:{output_url:'https://example.com/t'}},s.users[1]);
 assert.equal(task(1,'editing').status,'planned');assert.ok(s.episodes[0].pendingStages.includes('editing'));
 assert.throws(()=>act(s,{type:'episode-start',project_id:'p',data:{number:1,stage:'casting'}},a));
 act(s,{type:'episode-start',project_id:'p',data:{number:1,stage:'editing'}},a);
 act(s,{type:'complete',task_id:task(1,'editing').id,data:{output_url:'https://example.com/e'}},s.users[2]);assert.equal(task(1,'casting').status,'todo');
 act(s,{type:'episode-start',project_id:'p',data:{number:2}},a);const deadline=task(2,'translation').deadline;
 // Finishing prior series must not reset an already running next episode.
 task(1,'mixing').status='working';s.episodes[0].ready_notified=1;
 act(s,{type:'complete',task_id:task(1,'mixing').id},s.users.find(u=>u.id==='mix'));assert.equal(task(2,'translation').deadline,deadline);
 act(s,{type:'episode-settings',project_id:'p',data:{number:2,modes,nextMode:'auto'}},a);
 task(2,'mixing').status='working';s.episodes[1].ready_notified=1;
 act(s,{type:'complete',task_id:task(2,'mixing').id},s.users.find(u=>u.id==='mix'));assert.equal(task(3,'translation').status,'todo');
 s.projects.push({id:'q',title:'Other',code:'Other'});assert.throws(()=>act(s,{type:'project',project_id:'q',data:{title:'Other',code:'p'}},a),/код/);assert.throws(()=>assertProjectCode(s,'P'),/код/);assert.doesNotThrow(()=>assertProjectCode(s,'p','p'));
});

test('birthdays have no year, validate dates and handle year rollover and leap day',async()=>{
 const {birthdayNotices}=await import('../dist/workflow.js');const s=seed(),a=s.users[0],x=s.users.at(-1);
 act(s,{type:'birthday',data:{day:1,month:1,enabled:'0',ahead:1}},x);
 act(s,{type:'birthday',data:{day:'',month:'',enabled:'1',ahead:1}},a);
 const notices=birthdayNotices(s,'2026-12-31');assert.equal(notices.length,1);assert.equal(notices[0].user_id,a.id);assert.equal(notices[0].key,`birthday:${x.id}:2027:1`);
 assert.throws(()=>act(s,{type:'birthday',data:{day:31,month:2,ahead:1}},x));
 act(s,{type:'birthday',data:{day:29,month:2,enabled:'0',ahead:0}},x);assert.equal(birthdayNotices(s,'2027-02-27').length,1);assert.equal(birthdayNotices(s,'2028-02-28').length,1);
 assert.deepEqual(s.profiles.find(p=>p.user_id===x.id).birthday,{month:2,day:29});
 act(s,{type:'birthday',data:{day:'',month:'',enabled:'0',ahead:1}},x);assert.equal(birthdayNotices(s,'2027-02-27').length,0);
});

test('onboarding is marked once per account and cannot mark another account',()=>{
 const s=seed(),actor=s.users.find(u=>u.id==='x');
 act(s,{type:'onboarding-seen',user_id:'a'},actor);
 assert.equal(s.profiles.find(p=>p.user_id==='x').onboarding_seen,true);
 assert.equal(s.profiles.find(p=>p.user_id==='a')?.onboarding_seen,undefined);
 act(s,{type:'profile',data:{name:'New nick'}},actor);
 act(s,{type:'onboarding-seen'},actor);
 const restored=normalizeState(JSON.parse(JSON.stringify(s)));
 assert.equal(restored.profiles.find(p=>p.user_id==='x').onboarding_seen,true);
 assert.equal(restored.profiles.filter(p=>p.user_id==='x').length,1);
});

test('subtitle uploads complete work, respect gates and never repeat handoff on replacements',()=>{
 for(const manual of [false,true]){
  const s=seed(),a=s.users[0];
  s.users.push({id:'cast',name:'Cast',roles:['casting'],access:'active'});
  s.memberships.push({project_id:'p',user_id:'cast',role:'casting'});
  act(s,{type:'project-plan',project_id:'p',data:{count:1}},a);
  act(s,{type:'episode-settings',project_id:'p',data:{number:1,nextMode:'manual',modes:Object.fromEntries(PIPELINE.map(k=>[k,manual&&k==='editing'?'manual':'auto']))}},a);
  act(s,{type:'episode-start',project_id:'p',data:{number:1}},a);
  const tr=s.tasks.find(t=>t.stage==='translation'),ed=s.tasks.find(t=>t.stage==='editing');
  assert.equal(tr.status,'todo');
  act(s,{type:'uploaded',task_id:tr.id,take_id:'translation-file'},s.users[1],'2026-11-08T10:00:00Z');
  assert.equal(tr.status,'approved');assert.equal(tr.completed_at,'2026-11-08T10:00:00Z');
  assert.equal(ed.status,manual?'planned':'todo');
  if(manual)act(s,{type:'episode-start',project_id:'p',data:{number:1,stage:'editing'}},a);
  act(s,{type:'uploaded',task_id:ed.id,take_id:'editing-file'},s.users[2]);
  assert.equal(ed.status,'approved');assert.equal(s.tasks.find(t=>t.stage==='casting').status,'todo');
  const deadline=ed.deadline,count=s.tasks.length;
  act(s,{type:'uploaded',task_id:tr.id,take_id:'replacement'},s.users[1],'2026-11-09T10:00:00Z');
  assert.equal(tr.completed_at,'2026-11-08T10:00:00Z');assert.equal(ed.status,'approved');assert.equal(ed.deadline,deadline);assert.equal(s.tasks.length,count);
  assert.ok(s.notifications.some(n=>n.user_id==='ed'&&n.key==='material:replacement'));
 }
});
test('subtitle handoff waits for all assignees; independent tasks only complete themselves',()=>{
 const s=seed(),a=s.users[0];
 s.users.find(u=>u.id==='new').roles=['translator'];
 s.memberships.push({project_id:'p',user_id:'new',role:'translator'});
 act(s,{type:'episode',project_id:'p',data:{number:1}},a);
 const translators=s.tasks.filter(t=>t.stage==='translation');assert.equal(translators.length,2);
 act(s,{type:'uploaded',task_id:translators[0].id,take_id:'one'},a);
 assert.ok(!s.tasks.some(t=>t.stage==='editing'&&t.status==='todo'));
 act(s,{type:'uploaded',task_id:translators[1].id,take_id:'two'},a);
 assert.equal(s.tasks.find(t=>t.stage==='editing').status,'todo');
 for(const stage of ['translation','editing']){
  act(s,{type:'task-create',data:{project_id:'p',episode:9,stage,assignee:stage==='translation'?'tr':'ed',character:'Subs'}},a);
  const t=s.tasks.at(-1),count=s.tasks.length;
  act(s,{type:'uploaded',task_id:t.id,take_id:stage},a);
  assert.equal(t.status,'approved');assert.equal(s.tasks.length,count);
 }
});

test('manual voice credits are admin-only, editable and separate from workflow',()=>{
 const s=seed(),a=s.users[0],data={user_id:'x',project_id:'p',character:'Мамі Томое',note:'Сезон 1'};
 assert.throws(()=>act(s,{type:'credit-save',data},s.users[1]));
 act(s,{type:'credit-save',data},a);assert.equal(s.voiceCredits.length,1);assert.equal(s.tasks.length,0);
 const id=s.voiceCredits[0].id;act(s,{type:'credit-save',data:{...data,id,character:'Інший персонаж'}},a);assert.equal(s.voiceCredits.length,1);assert.equal(s.voiceCredits[0].character,'Інший персонаж');
 assert.throws(()=>act(s,{type:'credit-delete',data:{id}},s.users[1]));
 act(s,{type:'credit-delete',data:{id}},a);assert.equal(s.voiceCredits.length,0);
});

test('external credit titles never create projects or tasks, and can switch to existing projects',()=>{
 const s=seed(),a=s.users[0],before=JSON.stringify(s.projects),data={user_id:'x',project_id:'external',project_title:'Старе аніме',character:'Герой'};
 assert.throws(()=>act(s,{type:'credit-save',data:{...data,project_title:'  '}},a));assert.equal(s.voiceCredits.length,0);
 act(s,{type:'credit-save',data},a);const id=s.voiceCredits[0].id;
 assert.equal(s.voiceCredits[0].project_id,null);assert.equal(s.voiceCredits[0].project_title,'Старе аніме');assert.equal(JSON.stringify(s.projects),before);assert.equal(s.tasks.length,0);assert.equal(s.episodes.length,0);
 act(s,{type:'credit-save',data:{...data,id,project_title:'Інша назва'}},a);assert.equal(s.voiceCredits.length,1);
 act(s,{type:'credit-save',data:{...data,id,project_id:'p'}},a);assert.equal(s.voiceCredits[0].project_title,'');assert.equal(s.voiceCredits[0].project_id,'p');assert.equal(JSON.stringify(s.projects),before);
});

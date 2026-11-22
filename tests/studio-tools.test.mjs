import test from 'node:test';import assert from 'node:assert/strict';
import {act,normalizeState,reviewActors} from '../dist/workflow.js';
import {analytics,continuationRows} from '../dist/studio-tools.js';
const seed=()=>normalizeState({users:[['admin','admin'],['tr','translator'],['ed','editor'],['cast','casting'],['review','reviewer'],['mix','engineer'],['a','actor'],['b','actor']].map(([id,role])=>({id,role,name:id})),projects:[{id:'p',title:'P',code:'P'}]});
const stages=()=>Object.fromEntries(Object.entries({translation:'tr',editing:'ed',casting:'cast',review:'review',mixing:'mix'}).map(([k,assignee])=>[k,{assignee,links:[]}]));
test('optional materials are independently assigned, restricted to responsible user, and do not launch episode',()=>{
 const s=seed(),a=s.users[0];act(s,{type:'episode-add',project_id:'p',data:{number:1}},a);const action={type:'material-assign',project_id:'p',data:{number:1,kind:'original',assignee:'a'}};
 assert.throws(()=>act(s,action,s.users.at(-1)));act(s,action,a);const t=s.tasks.find(t=>t.material_kind);assert.equal(t.independent,1);assert.equal(t.deadline,'');assert.equal(s.episodes[0].stage,'planned');
 const link={type:'material-link',task_id:t.id,data:{name:'Original',url:'https://fex.net/file'}};assert.throws(()=>act(s,link,s.users.at(-1)));act(s,link,s.users.find(u=>u.id==='a'));assert.equal(t.status,'material');assert.equal(s.episodes[0].stage,'planned');assert.equal(s.episodeMaterials.length,1);assert.throws(()=>act(s,{...link,data:{name:'bad',url:'javascript:alert(1)'}},a));
 act(s,{...action,data:{...action.data,assignee:'b'}},a);assert.equal(s.tasks.filter(t=>t.material_kind).length,1);assert.deepEqual(t.material_editors,['b']);
});
test('guided import creates per-actor continuation, only active notifications, no duplicate on replay; subsequent review resumes pipeline',()=>{
 const s=seed(),a=s.users[0],rows=continuationRows(s,'p','review',stages(),[{id:'a',include:true,status:'unchecked',recordings:['https://t.me/c/123/42/91']},{id:'b',include:true,status:'fix',recordings:['https://t.me/c/123/42/92'],iteration:2}]);
 const action={type:'progress-import',project_id:'p',data:{guided:true,number:7,current:'review',rows,import_id:'import-one'}};act(s,action,a);const count=s.tasks.length;act(s,action,a);assert.equal(s.tasks.length,count);
 const ep=s.episodes[0],rec=s.tasks.find(t=>t.stage==='recording'&&t.assignee==='a'),review=s.tasks.find(t=>t.stage==='review'),fix=s.tasks.find(t=>t.stage==='correction');assert.equal(rec.status,'review');assert.equal(fix.status,'todo');assert.equal(fix.fix_iteration,2);assert.equal(ep.stageModes.mixing,'auto');assert.ok(reviewActors(s,review).find(r=>r.user_id==='a').ready);assert.ok(reviewActors(s,review).find(r=>r.user_id==='b').notified);
 assert.deepEqual(s.notifications.filter(n=>n.key.startsWith('import-active:')).map(n=>n.user_id).sort(),['b','review']);
 act(s,{type:'review-notify',task_id:review.id,data:{entries:[{user_id:'a',status:'clear',take_ids:[]}]}},s.users.find(u=>u.id==='review'));assert.equal(review.status,'approved');assert.equal(ep.review_done,1);
 act(s,{type:'uploaded',task_id:fix.id,take_id:'fixed'},s.users.find(u=>u.id==='b'));assert.equal(fix.status,'approved');assert.equal(ep.ready_notified,1);assert.equal(s.tasks.find(t=>t.stage==='mixing').status,'todo');
});
test('guided import rejects contradictory late-stage progress and preserves existing episode',()=>{
 const s=seed();assert.throws(()=>continuationRows(s,'p','mixing',stages(),[{id:'a',include:true,status:'fix'}]));
 act(s,{type:'episode-add',project_id:'p',data:{number:1}},s.users[0]);act(s,{type:'episode-start',project_id:'p',data:{number:1}},s.users[0]);
 // Active independent material tasks can coexist with import; active production cannot.
 const rows=continuationRows(s,'p','translation',stages(),[]);act(s,{type:'progress-import',project_id:'p',data:{guided:true,number:2,current:'translation',rows,import_id:'two'}},s.users[0]);
 assert.throws(()=>act(s,{type:'progress-import',project_id:'p',data:{guided:true,number:2,current:'translation',rows,import_id:'again'}},s.users[0]));
});
test('analytics excludes planned and review from executable work, drill-down scopes by project',()=>{
 const s=seed();s.tasks=[['todo','2026-01-01','p'],['working','2026-01-03','p'],['review','2026-01-01','p'],['planned','2026-01-01','p'],['approved','2026-01-01','p'],['todo','2026-01-01','q']].map(([status,deadline,project_id],i)=>({id:String(i),status,deadline,project_id,assignee:'a',stage:'recording'}));const a=analytics(s,'p',Date.parse('2026-01-02'));assert.equal(a.active.length,2);assert.equal(a.late.length,1);assert.equal(a.review.length,1);assert.equal(a.soon.length,1);assert.equal(a.people[0].active.length,2);
});

test('import with completed review and no outstanding fixes immediately makes mixing actionable',()=>{const s=seed(),rows=continuationRows(s,'p','correction',stages(),[{id:'a',include:true,status:'clear'}]);act(s,{type:'progress-import',project_id:'p',data:{guided:true,current:'correction',number:1,import_id:'clear-import',rows}},s.users[0]);assert.equal(s.tasks.find(t=>t.stage==='mixing').status,'todo');assert.equal(s.episodes[0].ready_notified,1);assert.equal(s.episodes[0].stage,'mixing');});
test('independent actor uploads create reviewer work once, including legacy episodes; manual gates remain',()=>{
 for(const controlled of [false,true]){
 const s=seed();s.memberships.push({project_id:'p',role:'reviewer',user_id:'review'});
 if(controlled)s.episodes.push({id:'ep',project_id:'p',number:9,stageModes:{review:'manual'},released:[]});
 s.tasks.push({id:'rec',project_id:'p',episode:9,stage:'recording',assignee:'a',status:'review',independent:1});
 const upload={type:'uploaded',task_id:'rec',take_id:'one'};
 act(s,upload,s.users.find(u=>u.id==='a'));act(s,{...upload,take_id:'two'},s.users.find(u=>u.id==='a'));
 const checks=s.tasks.filter(t=>t.stage==='review');assert.equal(checks.length,controlled?0:1);
 if(!controlled){assert.equal(checks[0].assignee,'review');assert.ok(['todo','working'].includes(checks[0].status));assert.ok(s.notifications.some(n=>n.user_id==='review'&&n.key==='task:'+checks[0].id));}
 else assert.ok(s.episodes[0].pendingStages.includes('review'));
 }
});
test('mixing is available early without deadline, starts clock only after all fixes, preserves manual dates',()=>{
 const s=seed(),a=s.users.find(u=>u.id==='a');s.memberships.push({project_id:'p',role:'engineer',user_id:'mix'});s.episodes.push({id:'ep',project_id:'p',number:1,review_done:0});
 s.tasks.push({id:'rec',project_id:'p',episode:1,stage:'recording',status:'review',assignee:'a'});
 act(s,{type:'uploaded',task_id:'rec',take_id:'one'},a,'2026-11-01T12:00:00Z');const mix=s.tasks.find(t=>t.stage==='mixing');assert.equal(mix.status,'todo');assert.equal(mix.deadline,'');assert.ok(!s.notifications.find(n=>n.key==='task:'+mix.id).message.includes('Дедлайн:'));
 s.episodes[0].review_done=1;s.tasks[0].status='approved';s.tasks.push({id:'fix',project_id:'p',episode:1,stage:'correction',status:'todo',assignee:'a'});
 normalizeState(s);assert.equal(mix.deadline,'');act(s,{type:'uploaded',task_id:'fix',take_id:'two'},a,'2026-11-02T12:00:00Z');assert.ok(Date.parse(mix.deadline)>Date.parse('2026-11-02T12:00:00Z'));
 mix.deadline_manual=1;const deadline=mix.deadline;s.episodes[0].review_done=0;normalizeState(s);assert.equal(mix.deadline,deadline);mix.deadline_manual=0;normalizeState(s);assert.equal(mix.deadline,'');
});

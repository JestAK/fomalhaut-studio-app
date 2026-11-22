import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeProgress} from '../dist/studio-tools.js';
test('production progress distinguishes overdue work, review and manual gates',()=>{
 const tasks=[
 {id:'late',stage:'recording',status:'working',deadline:'2026-01-01'},
 {id:'submitted',stage:'recording',status:'review',deadline:'2026-01-01'},
 {id:'future',stage:'editing',status:'planned',deadline:'2026-01-01'},
 {id:'closed',stage:'recording',status:'approved',admin_closed:true},
 {id:'material',stage:'recording',status:'todo',material_kind:'original',deadline:'2026-01-01'},
 {id:'deleted',stage:'recording',status:'todo',deadline:'2026-01-01'}
 ].map(t=>({...t,project_id:'p',episode:1}));
 const s={tasks,deletedTaskIds:['deleted'],episodes:[{project_id:'p',number:1,stage:'waiting:mixing',stageModes:{editing:'manual'},released:[]}]};
 const rows=episodeProgress(s,'p',1,Date.parse('2026-02-01'));
 const rec=rows.find(r=>r.stage==='recording');
 assert.deepEqual(rec.late.map(t=>t.id),['late']);
 assert.deepEqual(rec.submitted.map(t=>t.id),['submitted']);
 assert.equal(rec.tasks.length,3);
 assert.equal(rows.find(r=>r.stage==='editing').manual,true);
 assert.equal(rows.find(r=>r.stage==='mixing').missing,true);
 assert.equal(rows.find(r=>r.stage==='editing').late.length,0);
 assert.equal(episodeProgress(s,'other',1).flatMap(r=>r.tasks).length,0);
 s.episodes[0].released=['editing'];
 assert.equal(episodeProgress(s,'p',1).find(r=>r.stage==='editing').manual,false);
});

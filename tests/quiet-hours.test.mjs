import test from 'node:test';
import assert from 'node:assert/strict';
import {quietMode} from '../dist/timezone.js';
import {act,normalizeState} from '../dist/workflow.js';
test('recipient-local daily hours, midnight, boundaries, overlaps and DST',()=>{
 const s={profiles:[{user_id:'u',timezone:'Europe/Kyiv',quiet_hours:{enabled:true,ranges:[{start:'22:00',end:'08:00',mode:'silent'},{start:'07:00',end:'09:00',mode:'pause'}]}}]};
 assert.equal(quietMode(s,'u','2026-11-08T20:00:00Z'),'silent');
 assert.equal(quietMode(s,'u','2026-11-09T05:30:00Z'),'pause');
 assert.equal(quietMode(s,'u','2026-11-09T07:00:00Z'),null);
 assert.equal(quietMode(s,'u','2026-07-08T19:00:00Z'),'silent');
 assert.equal(quietMode(s,'other','2026-11-08T20:00:00Z'),null);
 s.profiles[0].quiet_hours.enabled=false;assert.equal(quietMode(s,'u','2026-11-08T20:00:00Z'),null);
});
test('settings are validated, scoped to signed-in user and survive normalization',()=>{
 const s=normalizeState({users:[{id:'u',name:'U',role:'actor'},{id:'v',name:'V',role:'actor'}]});
 const data={enabled:true,ranges:[{start:'22:00',end:'08:00',mode:'pause'}]};
 act(s,{type:'quiet-hours',user_id:'v',data},s.users[0]);
 assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(s))).profiles[0].quiet_hours,data);
 assert.equal(s.profiles[0].user_id,'u');
 for(const range of [{start:'25:00',end:'08:00',mode:'pause'},{start:'08:00',end:'08:00',mode:'silent'},{start:'22:00',end:'08:00',mode:'bad'}])assert.throws(()=>act(s,{type:'quiet-hours',data:{enabled:true,ranges:[range]}},s.users[0]));
 assert.throws(()=>act(s,{type:'quiet-hours',data:{enabled:true,ranges:[]}},s.users[0]));
});

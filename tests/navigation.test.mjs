import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeRoute,encodeRoute,searchStudio} from '../dist/navigation.js';
test('project and task routes survive refresh including Ukrainian search text',()=>{
  const route={page:'project',projectId:'Madoka / special',tab:'episodes',filter:'all',q:'Мамі Томое'};
  assert.deepEqual(decodeRoute(encodeRoute(route)),route);
  const tasks={page:'tasks',projectId:null,tab:'tasks',filter:'review',q:''};
  assert.deepEqual(decodeRoute(encodeRoute(tasks)),tasks);
});
test('malformed or old links fall back to valid screens',()=>{
  assert.equal(decodeRoute('#overview').page,'overview');
  assert.equal(decodeRoute('#/no-such-screen').page,'overview');
  assert.equal(decodeRoute('#/project/%E0%A4').page,'projects');
  assert.equal(decodeRoute('#/tasks?filter=unknown').filter,'all');
  assert.equal(decodeRoute('#/project/123?tab=unknown').tab,'tasks');
});
test('global search matches words across fields including all team files for actors',()=>{
  const state={user:{id:'a',role:'actor'},users:[{id:'a',name:'Софія',username:'sofia'},{id:'b',name:'Марія',username:'maria'}],projects:[{id:'p',title:'Мадока Маґіка',code:'Madoka'}],tasks:[{id:'ta',project_id:'p',assignee:'a',character:'Мамі Томое',episode:3},{id:'tb',project_id:'p',assignee:'b',character:'Мамі Томое',episode:4}],takes:[{id:'fa',task_id:'ta',filename:'Madoka_mami.flac'},{id:'fb',task_id:'tb',filename:'Madoka_mami.flac'}]};
  const found=searchStudio(state,'МАДОКА Мамі');
  assert.deepEqual(found.tasks.map(t=>t.id),['ta','tb']);
  assert.deepEqual(found.takes.map(t=>t.id),['fa','fb']);
  assert.equal(searchStudio(state,'no-match').takes.length,0);
  assert.equal(searchStudio(state,'sofia').users[0].id,'a');
  state.user.role='engineer';assert.equal(searchStudio(state,'Мамі').takes.length,2);
});

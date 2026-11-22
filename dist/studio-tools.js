import {PIPELINE,STAGE_ROLE} from './workflow.js';
export const MATERIAL_KINDS={original:'Оригінальний файл серії',subtitles:'Оригінальні субтитри',hardsub:'Відео з українськими хардсабами'};
export function analytics(s,pid='all',now=Date.now()){
 const tasks=s.tasks.filter(t=>!t.material_kind&&t.status!=='planned'&&(pid==='all'||t.project_id===pid));
 const active=tasks.filter(t=>['todo','working'].includes(t.status)),late=active.filter(t=>Date.parse(t.deadline)<now),soon=active.filter(t=>Date.parse(t.deadline)>=now&&Date.parse(t.deadline)<=now+3*86400000);
 const stages=PIPELINE.map(stage=>({stage,active:active.filter(t=>t.stage===stage),late:late.filter(t=>t.stage===stage),review:tasks.filter(t=>t.stage===stage&&t.status==='review')}));
 const people=s.users.map(u=>({user:u,active:active.filter(t=>t.assignee===u.id),late:late.filter(t=>t.assignee===u.id),review:tasks.filter(t=>t.assignee===u.id&&t.status==='review'),done:tasks.filter(t=>t.assignee===u.id&&t.status==='approved')})).filter(p=>p.active.length+p.review.length+p.done.length).sort((a,b)=>b.late.length-a.late.length||b.active.length-a.active.length);
 const episodes=s.episodes.filter(e=>pid==='all'||e.project_id===pid).map(e=>({episode:e,tasks:s.tasks.filter(t=>t.project_id===e.project_id&&t.episode===e.number&&!t.independent)}));
 return {tasks,active,late,soon,stages,people,episodes,review:tasks.filter(t=>t.status==='review'),done:tasks.filter(t=>t.status==='approved')};
}
// Build a reviewable continuation plan. No publication or mutation happens here.
export function continuationRows(s,pid,current,stages,actors){
 const index=current==='done'?PIPELINE.length:PIPELINE.indexOf(current);if(index<0)throw new Error('Оберіть поточний етап.');const rows=[];
 for(const stage of ['translation','editing','casting','review','mixing']){
  const item=stages[stage];if(!item?.assignee)throw new Error('Призначте відповідального за '+stage+'.');
  rows.push({stage,assignee:item.assignee,status:PIPELINE.indexOf(stage)<index?'approved':PIPELINE.indexOf(stage)===index?'todo':'planned',links:item.links||[]});
 }
 for(const a of actors){
  if(!a.include)continue;
  const status=index<3?'planned':a.status==='missing'?'todo':a.status==='unchecked'?'review':'approved';
  rows.push({stage:'recording',assignee:a.id,status,links:a.recordings||[],scripts:a.scripts||[]});
  if(['fix','fixed'].includes(a.status))rows.push({stage:'correction',assignee:a.id,status:a.status==='fixed'?'approved':'todo',links:a.fixes||[],scripts:a.scripts||[],iteration:a.iteration||1});
 }
 const rec=rows.filter(r=>r.stage==='recording');
 if(index>=3&&!rec.length)throw new Error('Оберіть хоча б одного актора.');
 if(index>=5&&rec.some(r=>['todo','review'].includes(r.status)))throw new Error('Для цього етапу спочатку позначте результат перевірки кожного актора.');
 if(index>=6&&rows.some(r=>r.stage==='correction'&&r.status!=='approved'))throw new Error('Для зведення позначте здані правки.');
 if(index===3&&rec.some(r=>r.status!=='todo'&&r.status!=='planned'))rows.find(r=>r.stage==='review').status='working';
 for(const row of rows){if(!s.users.some(u=>u.id===row.assignee&&u.access==='active'&&(u.roles||[u.role]).includes(STAGE_ROLE[row.stage])))throw new Error('Перевірте ролі та доступ відповідальних.');}
 return rows;
}

// A submitted recording is distinct from a completed stage and an administrative closure.
export function contributionHistory(s,{project='all',episode='all',person='all',stage='all',status='all'}={}){
 const deleted=new Set(s.deletedTaskIds||[]),removed=new Set(s.deletedTakeIds||[]),files=new Map();
 for(const take of s.takes||[]){if(take.local||removed.has(take.id))continue;let meta=take.metadata||{};try{if(typeof meta==='string')meta=JSON.parse(meta);}catch{meta={};}if(meta.imported)continue;const time=Date.parse(take.created_at);if(Number.isFinite(time)&&time>(files.get(take.task_id)||0))files.set(take.task_id,time);}
 return s.tasks.filter(t=>!t.material_kind&&!deleted.has(t.id)&&['approved','review'].includes(t.status)&&(project==='all'||t.project_id===project)&&(episode==='all'||t.episode===Number(episode))&&(person==='all'||t.assignee===person)&&(stage==='all'||t.stage===stage)).map(task=>{
  const outcome=task.import_id?'imported':task.admin_closed?'closed':task.status==='review'?'submitted':'completed';
  const timestamp=outcome==='imported'?null:task.status==='approved'?Date.parse(task.completed_at):files.get(task.id);
  return {task,outcome,date:Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp).toISOString():null};
 }).filter(r=>status==='all'||r.outcome===status).sort((a,b)=>(Date.parse(b.date)||0)-(Date.parse(a.date)||0)||a.task.project_id.localeCompare(b.task.project_id)||a.task.episode-b.task.episode||a.task.assignee.localeCompare(b.task.assignee)||a.task.id.localeCompare(b.task.id));
}

// One row per episode; missing work must never become a completed checkbox.
export function contributionMatrix(s,{project='all',episode='all',person='all'}={}){
 const deleted=new Set(s.deletedTaskIds||[]);
 const tasks=s.tasks.filter(t=>!deleted.has(t.id)&&!t.material_kind&&PIPELINE.includes(t.stage));
 const rows=new Map();
 const add=(pid,number)=>{if(pid==='general'||(project!=='all'&&pid!==project)||(episode!=='all'&&Number(number)!==Number(episode)))return;const key=pid+':'+number;if(!rows.has(key))rows.set(key,{project_id:pid,number:Number(number)});};
 for(const e of s.episodes||[])add(e.project_id,e.number);
 for(const t of tasks)add(t.project_id,t.episode);
 return [...rows.values()].map(row=>{
  const all=tasks.filter(t=>t.project_id===row.project_id&&Number(t.episode)===row.number);
  const cells=PIPELINE.map(stage=>{const ts=all.filter(t=>t.stage===stage&&(person==='all'||t.assignee===person)).sort((a,b)=>String(a.assignee).localeCompare(String(b.assignee))||(a.fix_iteration||1)-(b.fix_iteration||1));return {stage,tasks:ts,complete:ts.length>0&&ts.every(t=>t.status==='approved'&&!t.admin_closed)};});
  const done=all.filter(t=>t.status==='approved'&&!t.admin_closed).length;
  return {...row,cells,done,total:all.length,percent:all.length?Math.round(done/all.length*100):0};
 }).filter(r=>person==='all'||r.cells.some(c=>c.tasks.length)).sort((a,b)=>a.project_id.localeCompare(b.project_id)||a.number-b.number);
}

// Read-only production overview; submitted recordings await review, not actor work.
export function episodeProgress(s,pid,number,now=Date.now()){
 const deleted=new Set(s.deletedTaskIds||[]);
 const tasks=s.tasks.filter(t=>t.project_id===pid&&Number(t.episode)===Number(number)&&!t.material_kind&&!deleted.has(t.id));
 const episode=(s.episodes||[]).find(e=>e.project_id===pid&&Number(e.number)===Number(number));
 const active=t=>['todo','working','revision'].includes(t.status);
 return PIPELINE.map(stage=>{
  const rows=tasks.filter(t=>t.stage===stage);
  const late=rows.filter(t=>active(t)&&Date.parse(t.deadline)<now);
  const manual=Boolean(episode?.pendingStages?.includes(stage)||(episode?.stageModes?.[stage]==='manual'&&!episode?.released?.includes(stage)&&!rows.some(t=>t.status!=='planned')));
  const missing=episode?.stage==='waiting:'+stage;
  return {stage,tasks:rows,late,manual,missing,active:rows.filter(active),submitted:rows.filter(t=>t.status==='review'),done:rows.filter(t=>t.status==='approved').length};
 });
}

import {validZone,userZone,noticeDates} from './timezone.js';
import {parseTelegramLink} from './telegram-link.js';
// Shared production rules: the demo and the server execute the same transitions.
export const ROLES={translator:'Перекладач',editor:'Редактор',casting:'Рольовик',actor:'Актор',reviewer:'Правкер',engineer:'Звукорежисер',admin:'Адмін'};
export const STAGES={translation:'Переклад',editing:'Редактура',casting:'Розподіл ролей',recording:'Запис',review:'Виписування правок',correction:'Запис правок',mixing:'Зведення',other:'Інше'};
export const PIPELINE=['translation','editing','casting','recording','review','correction','mixing'];
export function assertProjectCode(s,code,except){if(s.projects.some(p=>p.id!==except&&p.code.toLowerCase()===String(code).trim().toLowerCase()))error('Цей код файлів уже використовується іншим проєктом.');}
export const STAGE_ROLE={translation:'translator',editing:'editor',casting:'casting',recording:'actor',review:'reviewer',correction:'actor',mixing:'engineer'};
export const DEFAULT_DAYS={translator:3,editor:2,casting:1,actor:3,reviewer:2,engineer:3,admin:1};
export const roles=u=>u?.roles||[u?.role||'actor'];
export const isAdmin=u=>roles(u).includes('admin');
export const active=u=>u?.access==='active';
const error=(s,status=400,task_ids=[])=>{throw Object.assign(new Error(s),{status,task_ids});};
export const SUBTITLE_EXTENSIONS=['.ass','.ssa','.srt','.vtt','.sub','.sbv','.ttml','.dfxp','.txt','.zip'];
export const subtitleFile=name=>SUBTITLE_EXTENSIONS.some(ext=>String(name).toLowerCase().endsWith(ext));
export function allowedUpload(stage,name){const ext='.'+String(name).split('.').at(-1).toLowerCase();return ['translation','editing','casting'].includes(stage)?SUBTITLE_EXTENSIONS.includes(ext):['recording','correction'].includes(stage)?['.wav','.flac'].includes(ext):[...SUBTITLE_EXTENSIONS,'.wav','.flac','.mp4','.mkv'].includes(ext);}
export const newID=()=>crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const id=newID;
const str=(v,max=500)=>String(v??'').trim().slice(0,max);
export function mixingReady(s,pid,number){
 const e=s.episodes?.find(e=>e.project_id===pid&&e.number===Number(number));
 const ts=s.tasks.filter(t=>t.project_id===pid&&t.episode===Number(number)&&!t.independent);
 const recordings=ts.filter(t=>t.stage==='recording');
 return !!e?.review_done&&recordings.length>0&&recordings.every(t=>['review','approved'].includes(t.status))&&!ts.some(t=>t.stage==='correction'&&t.status!=='approved');
}
export function normalizeState(s){
  for(const key of ['users','projects','tasks','takes','jobs','episodes','memberships','cast','deadlineRules','notifications','aliases','batches','profiles','episodeMaterials','voiceCredits'])s[key]??=[];
  if(!s.projects.some(p=>p.id==='general'))s.projects.push({id:'general',title:'Загальне',code:'General',description:'Завдання студії без проєкту',paid:0});
  s.deletedEpisodeKeys??=[];s.importIds??=[];s.deletedTakeIds??=[];s.takes=s.takes.filter(v=>!s.deletedTakeIds.includes(v.id));s.deletedTaskIds??=[];s.tasks=s.tasks.filter(t=>!s.deletedTaskIds.includes(t.id));
  s.projects.forEach(p=>{p.season=Number(p.season)||1;p.paid=Number(p.paid)===1?1:0;});
  for(const t of s.tasks.filter(t=>t.material_kind)){t.material_editors??=[t.assignee];t.status='material';t.deadline='';t.completed_at=null;}
  s.notifications=s.notifications.filter(n=>!s.tasks.some(t=>t.material_kind&&(n.key==='task:'+t.id||n.key==='activate:'+t.id)));
  s.users.forEach(u=>{const profile=s.profiles.find(p=>p.user_id===u.id);if(profile){u.name=profile.name||u.name;u.avatar=profile.avatar||'';}u.roles??=[u.role||'actor'];u.access??='active';});
  s.episodes.forEach(e=>{e.stageModes??=Object.fromEntries(PIPELINE.map(k=>[k,'auto']));e.nextMode??='manual';e.pendingStages??=[];e.released??=[];e.started??=e.stage!=='planned';});
  s.tasks.forEach(t=>{t.stage??='recording';t.output_url??='';t.completed_at??=null;t.deadline_manual??=0;if(t.stage==='mixing'&&t.status!=='approved'&&!t.deadline_manual&&!mixingReady(s,t.project_id,t.episode))t.deadline='';});
  if(s.user)s.user=s.users.find(u=>u.id===s.user.id)||s.user;
  return s;
}
export function deadlineDays(s,t){
  let days=DEFAULT_DAYS[STAGE_ROLE[t.stage]]||3;
  for(const scope of ['global','project','user','episode']){
    const key=scope==='global'?'*':scope==='project'?t.project_id:scope==='user'?t.assignee:`${t.project_id}:${t.episode}`;
    const rule=s.deadlineRules.find(r=>r.scope===scope&&r.scope_id===key&&r.role===STAGE_ROLE[t.stage]);
    if(rule)days=rule.days;
  }
  return days;
}
export function act(s,action,actor,now=new Date().toISOString()){
  normalizeState(s);
  if(actor?.id?.startsWith('guest:'))error('Гостьовим профілем керує лише адміністратор.',403);
  if(!active(actor))error('Доступ очікує схвалення або заблокований.',403);
  const admin=()=>{if(!isAdmin(actor))error('Доступно адміністраторам.',403);};
  const findUser=uid=>{const u=s.users.find(u=>u.id===uid);if(!u)error('Учасника не знайдено.');return u;};
  const project=pid=>{const p=s.projects.find(p=>p.id===pid);if(!p)error('Проєкт не знайдено.');return p;};
  const ep=(pid,n)=>s.episodes.find(e=>e.project_id===pid&&e.number===Number(n));
  const tasks=e=>s.tasks.filter(t=>t.project_id===e.project_id&&t.episode===e.number&&!t.independent);
  const members=(pid,role)=>s.memberships.filter(m=>m.project_id===pid&&m.role===role).map(m=>findUser(m.user_id)).filter(u=>active(u)&&roles(u).includes(role));
  const notify=(uid,key,message)=>{if(!s.notifications.some(n=>n.key===key&&n.user_id===uid))s.notifications.push({id:id(),key,user_id:uid,message:noticeDates(message,userZone(s,uid)),status:'pending',error:null,created_at:now,read_at:null,attempts:0,next_attempt:0});};
  const notifyRole=(e,role,key,msg)=>members(e.project_id,role).forEach(u=>notify(u.id,key,msg));
  const label=e=>e.project_id==='general'?'Загальне':`${project(e.project_id).title} · серія ${e.number}`;
  const gated=(e,stage)=>e.stageModes?.[stage]==='manual'&&!e.released?.includes(stage);
  const earlierGate=(e,stage)=>PIPELINE.slice(0,PIPELINE.indexOf(stage)).some(k=>gated(e,k)&&!(tasks(e).filter(t=>t.stage===k).length&&tasks(e).filter(t=>t.stage===k).every(t=>t.status==='approved'))&&!(k==='correction'&&e.review_done&&!tasks(e).some(t=>t.stage==='correction')));
  const pause=(e,stage)=>{e.pendingStages=[...new Set([...(e.pendingStages||[]),stage])];};
  const createTask=(e,stage,uid,character=STAGES[stage],note='')=>{
    const t={id:id(),project_id:e.project_id,episode:e.number,stage,assignee:uid,character,note,status:'todo',output_url:'',completed_at:null,deadline_manual:0};
    t.deadline=stage==='mixing'&&!mixingReady(s,e.project_id,e.number)?'':new Date(Date.parse(now)+deadlineDays(s,t)*86400000).toISOString();s.tasks.push(t);
    notify(uid,`task:${t.id}`,`${label(e)}\nМожна починати: ${STAGES[stage]} · ${character}${t.deadline?'\nДедлайн: '+t.deadline:'\nДедлайн зведення почнеться після перевірки всіх записів і здавання всіх правок.'}`);return t;
  };
  const openStage=(e,stage)=>{
    if(gated(e,stage)||earlierGate(e,stage)){pause(e,stage);return;}
    e.pendingStages=(e.pendingStages||[]).filter(x=>x!==stage);
    const existing=tasks(e).filter(t=>t.stage===stage);if(existing.length){for(const task of existing.filter(t=>t.status==='planned')){task.status='todo';if(!task.deadline_manual)task.deadline=stage==='mixing'&&!mixingReady(s,e.project_id,e.number)?'':new Date(Date.parse(now)+deadlineDays(s,task)*86400000).toISOString();notify(task.assignee,'activate:'+task.id,`${label(e)}: можна починати ${STAGES[stage]}.${task.deadline?' Дедлайн: '+task.deadline:' Дедлайн зведення почнеться після перевірки всіх записів і здавання всіх правок.'}`);}if(stage!=='mixing')e.stage=stage;return;}
    if(['recording','correction'].includes(stage))return;
    const people=members(e.project_id,STAGE_ROLE[stage]);
    if(!people.length){if(stage!=='mixing')e.stage=`waiting:${stage}`;s.users.filter(u=>active(u)&&isAdmin(u)).forEach(u=>notify(u.id,`missing:${e.id}:${stage}`,`${label(e)}: призначте відповідального — ${STAGES[stage]}.`));return;}
    people.forEach(u=>createTask(e,stage,u.id));
    if(stage!=='mixing')e.stage=stage;
  };
  const planTasks=e=>{if(!e.controlled)return;for(const stage of ['translation','editing','casting','review','mixing'])for(const u of members(e.project_id,STAGE_ROLE[stage])){if(tasks(e).some(t=>t.stage===stage&&t.assignee===u.id))continue;const task=createTask(e,stage,u.id);task.status='planned';task.deadline='';s.notifications=s.notifications.filter(n=>n.key!==`task:${task.id}`);}};
  const holdTask=(e,task)=>{if(e&&gated(e,task.stage)){pause(e,task.stage);task.status='planned';task.deadline='';s.notifications=s.notifications.filter(n=>n.key!==`task:${task.id}`);}};
  const finishEpisode=e=>{e.stage='done';if(e.nextMode==='auto'){const next=s.episodes.filter(x=>x.project_id===e.project_id&&x.number>e.number).sort((a,b)=>a.number-b.number)[0];if(next&&!next.started){next.started=true;openStage(next,'translation');}}};
  const allRecorded=e=>{const ts=tasks(e).filter(t=>t.stage==='recording');return ts.length>0&&ts.every(t=>['review','approved'].includes(t.status));};
  const ready=e=>{
    if(!e.review_done||!allRecorded(e)||tasks(e).some(t=>t.stage==='correction'&&t.status!=='approved'))return;
    openStage(e,'mixing');e.stage='mixing';
    if(!tasks(e).some(t=>t.stage==='mixing'&&t.status!=='planned')){e.stage='waiting:mixing';return;}
    if(!e.ready_notified){
      e.ready_notified=1;
      tasks(e).filter(t=>t.stage==='mixing'&&t.status!=='approved').forEach(t=>{if(!t.deadline_manual)t.deadline=new Date(Date.parse(now)+deadlineDays(s,t)*86400000).toISOString();});
      notifyRole(e,'engineer',`ready:${e.id}`,`${label(e)}: усі записи та правки здано. Усе готово до зведення серії.`);
    }
  };
  const t=action.task_id?s.tasks.find(t=>t.id===action.task_id):null;
  if(action.task_id&&!t)error('Завдання не знайдено.',404);
  const own=()=>{if(t.material_kind){if(!isAdmin(actor)&&!(t.material_editors||[t.assignee]).includes(actor.id))error('Немає дозволу редагувати матеріали.',403);return;}if(t.status==='planned')error('Адмін ще не запустив цей етап.');if(!isAdmin(actor)&&(t.assignee!==actor.id||(t.stage!=='other'&&!roles(actor).includes(STAGE_ROLE[t.stage]))))error('Це завдання іншого виконавця.',403);};
  const b=action.data||{};
  if(action.type==='credit-save'){
    admin();const u=findUser(b.user_id),external=b.project_id==='external';const projectTitle=external?str(b.project_title,200):'';if(external&&!projectTitle)error('Вкажіть назву проєкту для статистики.');if(!external)project(b.project_id);const character=str(b.character,200).trim();if(!character)error('Вкажіть персонажа.');
    let credit=b.id?s.voiceCredits.find(x=>x.id===b.id):null;if(b.id&&!credit)error('Запис не знайдено.',404);
    if(!credit){credit={id:crypto.randomUUID()};s.voiceCredits.push(credit);}Object.assign(credit,{user_id:u.id,project_id:external?null:b.project_id,project_title:projectTitle,character,note:str(b.note||'',1000),updated_at:now,updated_by:actor.id});
  }else if(action.type==='credit-delete'){
    admin();if(!s.voiceCredits.some(x=>x.id===b.id))error('Запис не знайдено.',404);s.voiceCredits=s.voiceCredits.filter(x=>x.id!==b.id);
  }else if(action.type==='quiet-hours'){
    if(typeof b.enabled!=='boolean'||!Array.isArray(b.ranges)||b.ranges.length>12)error('Додайте не більше 12 проміжків.');
    const time=/^([01]\d|2[0-3]):[0-5]\d$/;
    const ranges=b.ranges.map(r=>{if(!r||!time.test(r.start)||!time.test(r.end)||r.start===r.end||!['silent','pause'].includes(r.mode))error('Перевірте час початку, завершення та режим.');return {start:r.start,end:r.end,mode:r.mode};});
    if(b.enabled&&!ranges.length)error('Додайте хоча б один проміжок.');
    let profile=s.profiles.find(p=>p.user_id===actor.id);if(!profile){profile={user_id:actor.id};s.profiles.push(profile);}profile.quiet_hours={enabled:b.enabled,ranges};
  }else if(action.type==='timezone'){if(!validZone(b.zone))error('Невідомий часовий пояс.');let p=s.profiles.find(p=>p.user_id===actor.id);if(!p){p={user_id:actor.id};s.profiles.push(p);}p.timezone=b.zone;
  }else if(action.type==='birthday'){
    const month=Number(b.month),day=Number(b.day),ahead=Number(b.ahead);if((month||day)&&(!Number.isInteger(month)||month<1||month>12||!Number.isInteger(day)||day<1||day>new Date(Date.UTC(2000,month,0)).getUTCDate()))error('Перевірте день і місяць народження.');if(!Number.isInteger(ahead)||ahead<0||ahead>30)error('Нагадування: від 0 до 30 днів.');let profile=s.profiles.find(p=>p.user_id===actor.id);if(!profile){profile={user_id:actor.id};s.profiles.push(profile);}Object.assign(profile,{birthday:month?{month,day}:null,birthday_enabled:b.enabled==='1',birthday_ahead:ahead});
  }else if(action.type==='reminders'){
    const interval=Number(b.interval),ahead=Number(b.ahead);if(![0,6,12,24,48,72,168].includes(interval)||!Number.isInteger(ahead)||ahead<0||ahead>30)error('Перевірте частоту і кількість днів.');
    let profile=s.profiles.find(p=>p.user_id===actor.id);if(!profile){profile={user_id:actor.id};s.profiles.push(profile);}profile.reminder_hours=interval;profile.reminder_days=ahead;
  }else if(action.type==='material-assign'){
    admin();const e=ep(action.project_id,b.number)||{project_id:action.project_id,number:Number(b.number)};project(e.project_id);if(!Number.isInteger(e.number)||e.number<1||(!ep(e.project_id,e.number)&&!s.tasks.some(t=>t.project_id===e.project_id&&t.episode===e.number)))error('Серію не знайдено.');
    const names={original:'Оригінальний файл серії',subtitles:'Оригінальні субтитри',hardsub:'Відео з українськими хардсабами'};
    if(!names[b.kind])error('Оберіть тип матеріалу.');const editors=[...new Set(b.editors||[b.assignee])];for(const uid of editors)if(!active(findUser(uid)))error('Учасник не має доступу.');
    let task=s.tasks.find(x=>x.project_id===e.project_id&&x.episode===e.number&&x.material_kind===b.kind);
    const previous=task?.material_editors||[];
    if(!task){task={id:id(),project_id:e.project_id,episode:e.number,stage:'other',assignee:actor.id,character:names[b.kind],note:'',output_url:'',material_kind:b.kind,independent:1,deadline_manual:0};s.tasks.push(task);}
    Object.assign(task,{material_editors:editors,status:'material',deadline:'',completed_at:null});
    for(const uid of editors.filter(uid=>!previous.includes(uid)))notify(uid,'material-access:'+task.id+':'+now,`${label(e)}: надано доступ до редагування «${names[b.kind]}».`);
  }else if(action.type==='material-link'){
    own();if(!t.material_kind)error('Оберіть матеріал серії.');validURL(b.url);if(!str(b.name,200))error('Вкажіть назву.');
    if(s.episodeMaterials.some(x=>x.task_id===t.id&&x.url===b.url))error('Це посилання вже додано.');
    s.episodeMaterials.push({id:id(),task_id:t.id,url:str(b.url,2000),name:str(b.name,200),created_by:actor.id,created_at:now});t.status='material';t.completed_at=null;
    for(const uid of new Set(s.memberships.filter(m=>m.project_id===t.project_id).map(m=>m.user_id)))if(uid!==actor.id)notify(uid,'material-link:'+t.id+':'+now,`${label({project_id:t.project_id,number:t.episode})}: додано матеріал «${str(b.name,200)}».`);
  }else if(action.type==='material-link-delete'){
    own();if(!t.material_kind)error('Оберіть матеріал серії.');s.episodeMaterials=s.episodeMaterials.filter(x=>x.task_id!==t.id||x.id!==b.id);if(!s.episodeMaterials.some(x=>x.task_id===t.id)&&!s.takes.some(x=>x.task_id===t.id)){t.status='material';t.completed_at=null;}
  }else if(action.type==='task-status'){
    admin();if(t.status==='planned')error('Спочатку запустіть етап серії.');if(!['todo','working','review','approved'].includes(b.status))error('Невідомий статус.');t.status=b.status;t.completed_at=b.status==='approved'?now:null;t.admin_closed=b.status==='approved';
    notify(t.assignee,'status:'+t.id+':'+now,`${label({project_id:t.project_id,number:t.episode})}: адмін змінив статус завдання «${t.character}».`);
    const e=ep(t.project_id,t.episode);if(e&&!t.independent){if(b.status!=='approved'){e.ready_notified=0;e.stage=t.stage;for(const mix of tasks(e).filter(x=>x.stage==='mixing'&&x.status==='approved')){mix.status='working';mix.completed_at=null;}if(t.stage==='recording'){e.review_done=0;for(const check of tasks(e).filter(x=>x.stage==='review')){if(check.review_results?.[t.assignee])check.review_results[t.assignee].editing=true;check.status='working';}}}else {if(t.stage==='mixing'&&tasks(e).filter(x=>x.stage==='mixing').every(x=>x.status==='approved'))finishEpisode(e);else ready(e);}}
  }else if(action.type==='task-delete'){
    admin();if(s.jobs.some(j=>j.task_id===t.id&&['uploading','queued','processing','publishing'].includes(j.status)))error('Дочекайтеся завершення завантаження.');s.deletedTaskIds.push(t.id);s.tasks=s.tasks.filter(x=>x.id!==t.id);
  }else if(action.type==='episode-settings'){
    admin();const e=ep(action.project_id,b.number);if(!e)error('Серію не знайдено.');
    if(!['auto','manual'].includes(b.nextMode)||!b.modes||PIPELINE.some(k=>!['auto','manual'].includes(b.modes[k])))error('Перевірте режими запуску.');
    e.stageModes=Object.fromEntries(PIPELINE.map(k=>[k,b.modes[k]]));e.nextMode=b.nextMode;
    for(const stage of [...e.pendingStages])if(!gated(e,stage))openStage(e,stage);
    if(e.stage==='done')finishEpisode(e);else ready(e);
  }else if(action.type==='episode-start'){
    admin();const e=ep(action.project_id,b.number);if(!e)error('Серію не знайдено.');const stage=b.stage||'translation';if(!PIPELINE.includes(stage))error('Оберіть етап.');
    if(stage!=='translation'&&!e.pendingStages.includes(stage))error('Цей етап ще не готовий до запуску або вже запущений.');
    if(stage==='translation'&&e.started&&!e.pendingStages.includes(stage))error('Серію вже запущено.');
    if(earlierGate(e,stage))error('Спочатку дозвольте попередній ручний етап.');e.started=true;e.released=[...new Set([...e.released,stage])];openStage(e,stage);for(const next of PIPELINE.filter(k=>e.pendingStages.includes(k)))if(!gated(e,next))openStage(e,next);ready(e);
  }else if(action.type==='project-plan'){
    admin();const p=project(action.project_id),n=Number(b.count);if(b.season!==undefined){const season=Number(b.season);if(!Number.isInteger(season)||season<1||season>999)error('Перевірте номер сезону.');p.season=season;}if(!Number.isInteger(n)||n<1||n>9999)error('Кількість серій: від 1 до 9999.');
    const removed=s.tasks.filter(t=>t.project_id===p.id&&t.episode>n);if(removed.some(t=>t.status==='approved'||t.completed_at)||s.jobs.some(j=>removed.some(t=>t.id===j.task_id)&&['uploading','queued','processing','publishing'].includes(j.status)))error('Спочатку вручну видаліть усі завдання серій, які прибираєте.',400,removed.map(t=>t.id));
    s.deletedTaskIds.push(...removed.map(t=>t.id));s.tasks=s.tasks.filter(t=>!s.deletedTaskIds.includes(t.id));s.episodes=s.episodes.filter(e=>e.project_id!==p.id||e.number<=n);
    for(let number=1;number<=n;number++)if(!ep(p.id,number)&&!s.deletedEpisodeKeys.includes(p.id+':'+number))s.episodes.push({id:id(),project_id:p.id,number,stage:'planned',controlled:true,autorun:false,enabled:[],review_done:0,ready_notified:0});p.episode_count=n;for(const e of s.episodes.filter(e=>e.project_id===p.id))planTasks(e);
  }else if(action.type==='episode-add'){
    admin();const p=project(action.project_id),number=Number(b.number);
    if(!Number.isInteger(number)||number<1||number>9999)error('Номер серії: від 1 до 9999.');
    if(ep(p.id,number))error('Така серія вже існує.');
    const e={id:id(),project_id:p.id,number,stage:'planned',controlled:true,review_done:0,ready_notified:0};
    s.deletedEpisodeKeys=s.deletedEpisodeKeys.filter(x=>x!==p.id+':'+number);s.episodes.push(e);normalizeState(s);planTasks(e);p.episode_count=Math.max(p.episode_count||0,number);
  }else if(action.type==='episode-delete'){
    admin();const e=ep(action.project_id,b.number);if(!e)error('Серію не знайдено.');
    const ts=s.tasks.filter(x=>x.project_id===e.project_id&&x.episode===e.number);
    if(s.jobs.some(j=>ts.some(x=>x.id===j.task_id)&&['uploading','queued','processing','publishing'].includes(j.status)))error('Дочекайтеся завершення надсилання файлів серії.');
    if(b.confirm!==e.id)error('Підтвердьте видалення саме цієї серії.');
    s.deletedTaskIds.push(...ts.map(x=>x.id));s.tasks=s.tasks.filter(x=>!s.deletedTaskIds.includes(x.id));s.episodes=s.episodes.filter(x=>x.id!==e.id);s.deletedEpisodeKeys.push(e.project_id+':'+e.number);
    s.cast=s.cast.filter(x=>x.project_id!==e.project_id||x.episode!==e.number);for(const n of s.notifications)if(ts.some(t=>n.key==='task:'+t.id||n.key==='activate:'+t.id))n.read_at=now;
  }else if(action.type==='progress-import'){
    admin();if(s.importIds.includes(b.import_id))return s;if(b.guided&&![...PIPELINE,'done'].includes(b.current))error('Оберіть поточний етап.');
    const p=project(action.project_id),number=Number(b.number);
    if(!b.import_id||!Number.isInteger(number)||number<1||number>9999||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>100)error('Перевірте дані імпорту.');
    const existing=s.tasks.filter(x=>x.project_id===p.id&&x.episode===number&&!x.independent);
    if(existing.some(x=>x.status!=='planned')||s.takes.some(v=>existing.some(x=>x.id===v.task_id)))error('Імпорт доступний для нової серії або серії без розпочатих завдань.',409,existing.map(x=>x.id));
    const keys=new Set();
    for(const row of b.rows){
      const u=findUser(row.assignee),key=row.stage+':'+row.assignee;
      if(!PIPELINE.includes(row.stage)||!roles(u).includes(STAGE_ROLE[row.stage])||!active(u)||!['planned','todo','working','review','approved'].includes(row.status)||keys.has(key))error('Перевірте виконавців, етапи та статуси.');
      keys.add(key);if(!Array.isArray(row.links)||row.links.length>50)error('Не більше 50 посилань на етап.');for(const link of row.links)validURL(link);if(row.scripts){if(!Array.isArray(row.scripts)||row.scripts.length>50)error('Не більше 50 посилань на субтитри.');for(const link of row.scripts)validURL(link);}if(row.iteration!==undefined&&(!Number.isInteger(row.iteration)||row.iteration<1||row.iteration>99))error('Ітерація фіксів: від 1 до 99.');
    }
    s.deletedTaskIds.push(...existing.map(x=>x.id));s.tasks=s.tasks.filter(x=>!s.deletedTaskIds.includes(x.id));
    let e=ep(p.id,number);if(!e){e={id:id(),project_id:p.id,number,controlled:true,stage:'planned',review_done:0,ready_notified:0};s.episodes.push(e);}
    normalizeState(s);e.stageModes=Object.fromEntries(PIPELINE.map(k=>[k,'manual']));e.nextMode='manual';e.started=b.rows.some(x=>x.status!=='planned');e.stage='imported';e.released=PIPELINE.filter(k=>!b.rows.some(x=>x.stage===k)||b.rows.filter(x=>x.stage===k).every(x=>x.status==='approved'));
    for(const row of b.rows){const task=createTask({project_id:p.id,number},row.stage,row.assignee);task.status=row.status;task.completed_at=row.status==='approved'?now:null;task.deadline=row.status==='planned'?'':task.deadline;task.legacy_links=row.links;task.note='Перенесено з попередньої роботи команди.';s.notifications=s.notifications.filter(n=>n.key!=='task:'+task.id);if(!s.memberships.some(m=>m.project_id===p.id&&m.user_id===row.assignee&&m.role===STAGE_ROLE[row.stage]))s.memberships.push({project_id:p.id,user_id:row.assignee,role:STAGE_ROLE[row.stage]});}
    e.review_done=Number(b.rows.some(x=>x.stage==='review')&&b.rows.filter(x=>x.stage==='review').every(x=>x.status==='approved'));
    const pending=PIPELINE.find(stage=>b.rows.some(x=>x.stage===stage&&x.status==='planned'));e.pendingStages=pending?[pending]:[];
    s.deletedEpisodeKeys=s.deletedEpisodeKeys.filter(x=>x!==p.id+':'+number);p.episode_count=Math.max(p.episode_count||0,number);s.importIds.push(b.import_id);
    if(b.guided){
      const imported=tasks(e);for(const task of imported){const row=b.rows.find(r=>r.stage===task.stage&&r.assignee===task.assignee);task.import_id=b.import_id;if(task.stage==='recording')task.source_cast_task_id=imported.find(x=>x.stage==='casting')?.id;task.admin_closed=task.status==='approved';task.script_links=(row?.scripts||[]).map((url,i)=>({url,name:'Індивідуальні субтитри '+(i+1)}));if(task.stage==='correction'){const root=imported.find(x=>x.stage==='recording'&&x.assignee===task.assignee);task.root_task_id=root?.id;task.fix_iteration=Number(row?.iteration)||1;}}
      e.stageModes=Object.fromEntries(PIPELINE.map(k=>[k,'auto']));e.nextMode='manual';e.released=[];e.pendingStages=[];
      for(const task of imported.filter(x=>x.stage==='review')){task.review_results={};for(const rec of imported.filter(x=>x.stage==='recording'&&x.status==='approved')){const hasFix=imported.some(x=>x.stage==='correction'&&x.assignee===rec.assignee);task.review_results[rec.assignee]={status:hasFix?'fix':'clear',correction_id:imported.find(x=>x.stage==='correction'&&x.assignee===rec.assignee)?.id||null,take_ids:[],editing:false};}}
      e.review_done=Number(imported.some(x=>x.stage==='review'&&x.status==='approved'));e.stage=imported.every(x=>x.status==='approved')?'done':b.current||'imported';e.ready_notified=Number(e.review_done&&imported.filter(x=>['recording','correction'].includes(x.stage)).every(x=>x.status==='approved'));if(e.ready_notified&&e.stage!=='done'){for(const mix of imported.filter(x=>x.stage==='mixing'&&x.status==='planned')){mix.status='todo';mix.deadline=new Date(Date.parse(now)+deadlineDays(s,mix)*86400000).toISOString();}e.stage='mixing';}
      for(const task of imported.filter(x=>['todo','working'].includes(x.status)))notify(task.assignee,'import-active:'+task.id,`${label(e)}: продовжіть ${STAGES[task.stage]}. Попередній прогрес перенесено адміністратором.`);
    }

  }else if(action.type==='take-delete'){
    own();const take=s.takes.find(v=>v.id===b.take_id&&v.task_id===t.id);if(!take)error('Файл не знайдено.');
    s.deletedTakeIds.push(take.id);s.takes=s.takes.filter(v=>v.id!==take.id);
    for(const x of s.tasks)if(x.script_take_ids?.includes(take.id)){x.script_take_ids=x.script_take_ids.filter(v=>v!==take.id);notify(x.assignee,'removed:'+take.id,`${label({project_id:x.project_id,number:x.episode})}: рольовик вилучив файл. Перевірте субтитри.`);}
    if(t.material_kind&&!s.episodeMaterials.some(x=>x.task_id===t.id)&&!s.takes.some(x=>x.task_id===t.id)){t.status='material';t.completed_at=null;}
    if(['recording','correction'].includes(t.stage)&&!s.takes.some(v=>v.task_id===t.id)){t.status='working';t.completed_at=null;}
    const e=ep(t.project_id,t.episode);if(e&&['recording','correction'].includes(t.stage)){e.review_done=0;e.ready_notified=0;for(const x of tasks(e).filter(x=>['review','mixing'].includes(x.stage)&&x.status!=='planned')){x.status='working';x.completed_at=null;}}
    notifyRole({project_id:t.project_id,number:t.episode},'reviewer','removed:'+take.id,'Вилучено файл: '+take.filename);
    notifyRole({project_id:t.project_id,number:t.episode},'engineer','removed:'+take.id,'Вилучено файл: '+take.filename);
  }else if(action.type==='onboarding-seen'){
    let profile=s.profiles.find(p=>p.user_id===actor.id);if(!profile){profile={user_id:actor.id};s.profiles.push(profile);}
    profile.onboarding_seen=true;
  }else if(action.type==='profile'||action.type==='profile-avatar'){
    let profile=s.profiles.find(p=>p.user_id===actor.id);if(!profile){profile={user_id:actor.id};s.profiles.push(profile);}
    if(action.type==='profile'){if(!str(b.name,80))error('Вкажіть нік.');profile.name=str(b.name,80);actor.name=profile.name;}
    else{profile.avatar=b.avatar||'';actor.avatar=profile.avatar;}
  }else if(action.type==='request-fix'){
    if(!roles(actor).some(r=>['admin','engineer','reviewer'].includes(r)))error('Правки запитує адмін, правкер або звукорежисер.',403);
    if(!['recording','correction'].includes(t.stage)||!s.takes.some(v=>v.task_id===t.id&&!v.local))error('Оберіть зданий запис.');
    if(b.url)validURL(b.url);
    if(b.take_id&&!s.takes.some(v=>v.id===b.take_id&&v.task_id===t.id))error('Файл не належить запису.');
    const root=t.root_task_id||t.id;const iteration=Math.max(0,...s.tasks.filter(x=>x.root_task_id===root).map(x=>x.fix_iteration||1))+1;
    const fix=createTask({project_id:t.project_id,number:t.episode},'correction',t.assignee,t.character,str(b.note,2000));fix.script_links=t.script_links||[];fix.script_take_ids=t.script_take_ids||[];fix.requested_take_id=b.take_id||null;fix.root_task_id=root;fix.fix_iteration=iteration;fix.output_url=b.url||'';fix.requested_by=actor.id;fix.independent=t.independent||!ep(t.project_id,t.episode)?1:0;
    const e=ep(t.project_id,t.episode);if(e&&!fix.independent){holdTask(e,fix);e.ready_notified=0;e.stage='correction';tasks(e).filter(x=>x.stage==='mixing'&&x.status!=='planned').forEach(x=>{x.status='working';x.completed_at=null;});}
    notifyRole({project_id:t.project_id,number:t.episode},'engineer','fix:'+fix.id,`Запитані ${iteration===1?'FIX':'FIX'+iteration}: ${t.character}`);
  }else if(action.type==='review-reopen'){
    own();if(t.stage!=='review'||!t.review_results?.[b.user_id])error('Результат перевірки не знайдено.');
    const result=t.review_results[b.user_id];result.editing=true;t.status='working';t.completed_at=null;
    const e=ep(t.project_id,t.episode);if(e&&!t.independent){e.review_done=0;e.ready_notified=0;e.stage='review';tasks(e).filter(x=>x.stage==='mixing'&&x.status!=='planned').forEach(x=>{x.status='working';x.completed_at=null;});}
  }else if(action.type==='review-notify'){
    own();if(t.stage!=='review')error('Потрібне завдання правкера.');
    const rows=reviewActors(s,t), entries=b.entries;
    if(!Array.isArray(entries)||!entries.length||new Set(entries.map(x=>x.user_id)).size!==entries.length)error('Оберіть перевірених акторів.');
    for(const entry of entries){
      const row=rows.find(x=>x.user_id===entry.user_id);
      if(!row||!row.ready||!['fix','clear'].includes(entry.status))error('Спершу дочекайтеся записів актора та оберіть статус.',400,row?.tasks.map(x=>x.id)||[t.id]);
      if(!Array.isArray(entry.take_ids)||[...entry.take_ids].sort().join('|')!==row.take_ids.join('|'))error('Файли змінилися. Оновіть завдання та перевірте їх знову.',409);
    }
    t.review_results??={};
    for(const entry of entries){
      const row=rows.find(x=>x.user_id===entry.user_id);if(row.notified)continue;
      const previous=t.review_results[entry.user_id],revision=(previous?.revision||0)+1;const key=`review:${t.id}:${entry.user_id}:${row.take_ids.join(',')}:${revision}`;
      let correction=previous?.correction_id?s.tasks.find(x=>x.id===previous.correction_id):null;
      if(entry.status==='clear'&&correction&&correction.status!=='approved'){correction.status='approved';correction.completed_at=now;correction.note+='\nПравкер скасував необхідність цих правок.';}
      if(entry.status==='fix'&&(!correction||previous?.status!=='fix'||(correction.status==='approved'&&(previous.take_ids||[]).join('|')!==row.take_ids.join('|')))){
        const original=row.tasks[0], root=original.id;
        correction=createTask({project_id:t.project_id,number:t.episode},'correction',entry.user_id,'Правки · '+findUser(entry.user_id).name,'Є правки після вислуховування. Перевірте спільний список правок команди.');
        correction.root_task_id=root;correction.fix_iteration=Math.max(0,...s.tasks.filter(x=>x.id!==correction.id&&x.root_task_id===root).map(x=>x.fix_iteration||1))+1;
        correction.script_links=row.tasks.flatMap(x=>x.script_links||[]);correction.requested_by=actor.id;correction.reviewed_take_ids=row.take_ids;correction.script_take_ids=[...new Set(row.tasks.flatMap(x=>x.script_take_ids||[]))];correction.independent=t.independent||!ep(t.project_id,t.episode)?1:0;
        const e=ep(t.project_id,t.episode);if(e&&!correction.independent){holdTask(e,correction);e.ready_notified=0;tasks(e).filter(x=>x.stage==='mixing'&&x.status!=='planned').forEach(x=>{x.status='working';x.completed_at=null;});}
      }
      if(entry.status==='fix'&&correction&&entry.notion_snapshot_id){correction.notion_snapshot_id=entry.notion_snapshot_id;correction.note='Правки з Notion збережено в цьому завданні. Натисніть «Переглянути правки».';}
      notify(entry.user_id,key,`${label({project_id:t.project_id,number:t.episode})}: ${entry.status==='fix'?'є правки — створено завдання на виправлення.':'правок немає. Дякуємо за запис!'}`);
      t.review_results[entry.user_id]={status:entry.status,take_ids:row.take_ids,notified_at:now,revision,editing:false,correction_id:correction?.id||null};
    }
    const complete=reviewActors(s,t).every(x=>x.notified)&&rows.length>0;
    t.status=complete?'approved':'working';t.completed_at=complete?now:null;
    const e=ep(t.project_id,t.episode);
    if(e&&!t.independent){e.review_done=Number(tasks(e).filter(x=>x.stage==='review').every(x=>x.status==='approved'));if(e.review_done){tasks(e).filter(x=>x.stage==='recording').forEach(x=>{x.status='approved';x.completed_at=now;});e.stage='correction';ready(e);}}
  }else if(action.type==='task-create'){
    admin();project(b.project_id);const u=findUser(b.assignee);
    if(!STAGES[b.stage]||!active(u)||(b.stage!=='other'&&!roles(u).includes(STAGE_ROLE[b.stage])))error('Оберіть активного виконавця відповідного напрямку.');
    if(!str(b.character,80))error('Вкажіть назву завдання.');
    const number=b.project_id==='general'?0:Number(b.episode);if(!Number.isInteger(number)||(number<1&&b.project_id!=='general')||number>9999)error('Перевірте номер серії.');
    const task=createTask({project_id:b.project_id,number},b.stage,u.id,str(b.character,80),str(b.note,2000));task.independent=1;
    if(b.deadline){if(!Number.isFinite(Date.parse(b.deadline)))error('Перевірте дедлайн.');task.deadline=new Date(b.deadline).toISOString();task.deadline_manual=1;const notice=s.notifications.find(n=>n.key===`task:${task.id}`);if(notice)notice.message=`${project(b.project_id).title} · ${task.character}\nДедлайн: ${task.deadline}`;}
  }else if(action.type==='cast-batch'){
    own();if(t.stage!=='casting')error('Потрібне завдання рольовика.');
    if(s.batches.includes(b.batch_id))return s;

    const e=ep(t.project_id,t.episode);if(!t.independent&&!e)error('Серія не доступна для розподілу.');
    if(!b.batch_id||!Array.isArray(b.files)||!b.files.length||b.files.length>100)error('Оберіть від 1 до 100 файлів.');
    if(new Set(b.files.map(f=>f.take_id||f.link)).size!==b.files.length)error('Файл повторюється.');
    const pendingAliases=new Map();
    for(const f of b.files){
      const take=s.takes.find(v=>v.id===f.take_id&&v.task_id===t.id&&!v.local);if(f.link){try{parseTelegramLink(f.link);}catch{error('Вкажіть посилання на файл у Telegram.');}if(!subtitleFile(f.filename))error('Вкажіть назву файла субтитрів або ZIP.');}else if(!take)error('Спершу дочекайтеся завантаження всіх субтитрів.');
      if(take&&!subtitleFile(take.filename))error('Потрібні субтитри або ZIP.');
      if(!Array.isArray(f.users)||!f.users.length||new Set(f.users).size!==f.users.length)error('Кожному файлу потрібен хоча б один унікальний виконавець.');
      for(const uid of f.users){const u=findUser(uid);if(!active(u)||!roles(u).includes('actor')||!s.memberships.some(m=>m.project_id===t.project_id&&m.user_id===uid&&m.role==='actor'))error('Оберіть активних акторів команди проєкту.');}
      if(f.alias){const key=aliasKey(f.alias);if(pendingAliases.has(key)&&pendingAliases.get(key)!==f.users[0])error('Один аліас не може належати різним акторам.');pendingAliases.set(key,f.users[0]);if(f.users.length!==1||!key||key.length>80)error('Аліас можна зберегти лише для одного актора.');if(s.users.some(u=>u.id!==f.users[0]&&[u.name,u.username].some(v=>aliasKey(v)===key))||s.aliases.some(a=>a.key===key&&a.user_id!==f.users[0]))error('Цей аліас уже належить іншій людині.');}
    }
    const allTakeIds=new Set(s.takes.filter(v=>v.task_id===t.id).map(v=>v.id));
    const affected=s.tasks.filter(x=>x.stage==='recording'&&x.project_id===t.project_id&&x.episode===t.episode&&(x.source_cast_task_id===t.id||x.script_take_ids?.some(v=>allTakeIds.has(v))));
    const recipients=[...new Set(b.files.flatMap(f=>f.users))];
    for(const uid of recipients){
      let task=affected.find(x=>x.assignee===uid);
      if(!task){task=createTask({project_id:t.project_id,number:t.episode},'recording',uid,'Запис · '+findUser(uid).name,'Запишіть репліки з прикріплених індивідуальних субтитрів.');if(!t.independent)holdTask(e,task);if(t.independent)task.independent=1;}
      else notify(uid,'scripts:'+b.batch_id+':'+uid,`${label({project_id:t.project_id,number:t.episode})}: оновлено ваші субтитри. Перевірте файли завдання.`);
      task.source_cast_task_id=t.id;task.script_take_ids=b.files.filter(f=>f.users.includes(uid)&&f.take_id).map(f=>f.take_id);task.script_links=b.files.filter(f=>f.users.includes(uid)&&f.link).map(f=>({url:f.link,name:str(f.filename,200)}));
    }
    for(const task of affected.filter(x=>!recipients.includes(x.assignee))){
      task.script_take_ids=[];task.script_links=[];
      if(!s.takes.some(v=>v.task_id===task.id)&&task.status!=='approved'){s.deletedTaskIds.push(task.id);s.tasks=s.tasks.filter(x=>x.id!==task.id);}
      notify(task.assignee,'unassigned:'+b.batch_id+':'+task.id,`${label({project_id:t.project_id,number:t.episode})}: ваш розподіл субтитрів змінено рольовиком.`);
    }
    for(const f of b.files)if(f.alias&&!s.aliases.some(a=>a.key===aliasKey(f.alias)))s.aliases.push({key:aliasKey(f.alias),user_id:f.users[0]});
    s.batches.push(b.batch_id);t.status='approved';t.completed_at=now;if(e&&!t.independent&&!e.review_done){e.stage='recording';openStage(e,'recording');}
  }else if(action.type==='guest'){
    admin();const name=str(b.name,80);if(!name)error('Вкажіть ім’я гостя.');s.users.push({id:'guest:'+id(),name,username:'',role:'actor',roles:['actor'],access:'active',notify:0});
  }else if(action.type==='user'){
    admin();const u=findUser(action.user_id);const nextRoles=b.roles??u.roles,nextAccess=b.access??u.access;
    if(!Array.isArray(nextRoles)||!nextRoles.length||nextRoles.some(r=>!ROLES[r])||!['active','pending','blocked'].includes(nextAccess))error('Перевірте ролі та доступ.');
    if(u.id===actor.id&&(!nextRoles.includes('admin')||nextAccess!=='active'))error('Не можна заблокувати себе або забрати власну роль адміна.');
    const removed=u.roles.filter(r=>!nextRoles.includes(r));
    if(s.tasks.some(t=>t.assignee===u.id&&t.status!=='approved'&&removed.includes(STAGE_ROLE[t.stage])))error('Спершу перепризначте відкриті завдання цієї ролі.',400,s.tasks.filter(t=>t.assignee===u.id&&t.status!=='approved'&&removed.includes(STAGE_ROLE[t.stage])).map(t=>t.id));
    u.roles=[...new Set(nextRoles)];u.role=u.roles.includes('admin')?'admin':u.roles[0];u.access=nextAccess;
    s.memberships=s.memberships.filter(m=>m.user_id!==u.id||u.roles.includes(m.role));
  }else if(action.type==='project'){
    admin();const p=project(action.project_id);assertProjectCode(s,b.code,p.id);if(!str(b.title,100)||!/^[A-Za-z0-9_-]{1,30}$/.test(b.code))error('Вкажіть назву і код латиницею.');
    if(b.season!==undefined&&(!Number.isInteger(Number(b.season))||Number(b.season)<1||Number(b.season)>999))error('Перевірте номер сезону.');Object.assign(p,{season:Number(b.season)||p.season||1,title:str(b.title,100),code:b.code,description:str(b.description),paid:b.paid===undefined?p.paid:Number(b.paid)===1?1:0});if(b.episode_count!==undefined&&Number(b.episode_count)!==p.episode_count)act(s,{type:'project-plan',project_id:p.id,data:{count:Number(b.episode_count)}},actor,now);
  }else if(action.type==='members'){
    admin();const p=project(action.project_id);if(!Array.isArray(b.members))error('Потрібен список команди.');
    const entries=b.members.map(m=>{const u=findUser(m.user_id);if(!ROLES[m.role]||!active(u)||!roles(u).includes(m.role))error('Учасник має бути активним і мати обрану роль.');return {project_id:p.id,user_id:u.id,role:m.role};});
    if(new Set(entries.map(m=>m.user_id+':'+m.role)).size!==entries.length)error('Повторне призначення.');
    for(const task of s.tasks.filter(t=>t.project_id===p.id&&t.status!=='approved'&&!t.independent)){
      const role=STAGE_ROLE[task.stage];if(entries.some(m=>m.user_id===task.assignee&&m.role===role))continue;
      const replacement=b.replacements?.[task.id]||entries.filter(m=>m.role===role).length===1&&entries.find(m=>m.role===role).user_id;
      if(!replacement||!entries.some(m=>m.user_id===replacement&&m.role===role))error(`Спершу перепризначте завдання «${task.character}» або залиште одного нового виконавця цієї ролі.`,400,s.tasks.filter(x=>x.project_id===p.id&&x.assignee===task.assignee&&x.status!=='approved').map(x=>x.id));
      task.assignee=replacement;
      notify(replacement,`reassign:${task.id}:${replacement}:${now}`,`${p.title}: вам передано завдання «${task.character}». Історію файлів збережено.`);
    }
    s.memberships=s.memberships.filter(m=>m.project_id!==p.id).concat(entries);
    for(const e of s.episodes.filter(e=>e.project_id===p.id)){
      planTasks(e);
      if(e.stage.startsWith('waiting:'))openStage(e,e.stage.slice(8));
      if(tasks(e).some(t=>t.stage==='recording'&&['review','approved'].includes(t.status))){openStage(e,'mixing');if(!e.review_done)openStage(e,'review');}
      ready(e);
    }
  }else if(action.type==='episode'){
    admin();project(action.project_id);const n=Number(b.number);if(!Number.isInteger(n)||n<1||n>9999||ep(action.project_id,n)||s.tasks.some(t=>t.project_id===action.project_id&&t.episode===n))error('Перевірте номер серії: він має бути унікальним у проєкті.');
    const e={id:id(),project_id:action.project_id,number:n,stage:'translation',review_done:0,ready_notified:0};s.episodes.push(e);openStage(e,'translation');
  }else if(action.type==='cast'){
    const e=ep(action.project_id,b.episode);if(!e)error('Спочатку створіть серію.');
    const permitted=isAdmin(actor)||tasks(e).some(t=>t.stage==='casting'&&t.assignee===actor.id&&t.status!=='approved');
    if(!permitted)error('Розподіл доступний призначеному рольовику або адміну.',403);
    const recordingStarted=tasks(e).some(t=>t.stage==='recording');
    if(recordingStarted&&!isAdmin(actor))error('Після початку запису розподіл змінює адміністратор.');
    if(e.review_done)error('Вислуховування вже завершене. Для додаткової роботи створіть окреме завдання.');
    if(!Array.isArray(b.cast)||!b.cast.length)error('Додайте хоча б одну роль.');
    const entries=b.cast.map(c=>{const u=findUser(c.user_id);if(!active(u)||!roles(u).includes('actor')||!s.memberships.some(m=>m.project_id===e.project_id&&m.user_id===u.id&&m.role==='actor'))error('Оберіть актора з команди проєкту.');if(!str(c.character,80))error('Вкажіть персонажа.');if(c.script_url)validURL(c.script_url);return {id:id(),project_id:e.project_id,episode:e.number,user_id:u.id,character:str(c.character,80),script_url:str(c.script_url,2000)};});
    if(new Set(entries.map(c=>c.character.toLowerCase())).size!==entries.length)error('Персонажі не мають повторюватися.');
    if(recordingStarted){
      const existing=tasks(e).filter(t=>t.stage==='recording');
      if(existing.some(t=>!entries.some(c=>c.character===t.character)))error('Після початку запису не можна прибирати персонажів; історія зберігається.');
      for(const c of entries){const task=existing.find(t=>t.character===c.character);if(!task)createTask(e,'recording',c.user_id,c.character,c.script_url?`Субтитри: ${c.script_url}`:'Субтитри — у файлах серії.');else if(task.assignee!==c.user_id){task.assignee=c.user_id;notify(c.user_id,`reassign:${task.id}:${now}`,`${label(e)}: вам передано роль ${c.character}. Історія записів збережена.`);}}
    }
    s.cast=s.cast.filter(c=>!(c.project_id===e.project_id&&c.episode===e.number)).concat(entries);
  }else if(action.type==='rule'){
    admin();if(!['global','project','user','episode'].includes(b.scope)||!ROLES[b.role]||!Number.isInteger(Number(b.days))||Number(b.days)<1||Number(b.days)>365)error('Тривалість: від 1 до 365 днів.');
    const key=str(b.scope_id,200);if(b.scope==='global'&&key!=='*')error('Некоректне глобальне правило.');if(b.scope==='project')project(key);if(b.scope==='user')findUser(key);if(b.scope==='episode'&&!s.episodes.some(e=>`${e.project_id}:${e.number}`===key))error('Серію не знайдено.');
    s.deadlineRules=s.deadlineRules.filter(r=>!(r.scope===b.scope&&r.scope_id===key&&r.role===b.role));s.deadlineRules.push({id:id(),scope:b.scope,scope_id:key,role:b.role,days:Number(b.days)});
  }else if(action.type==='task-edit'){
    admin();if(b.assignee){const u=findUser(b.assignee);if(!active(u)||(t.stage!=='other'&&!roles(u).includes(STAGE_ROLE[t.stage]))||!t.independent&&!s.memberships.some(m=>m.project_id===t.project_id&&m.user_id===u.id&&m.role===STAGE_ROLE[t.stage]))error('Виконавець має бути в команді проєкту з потрібною роллю.');if(t.assignee!==u.id){t.assignee=u.id;notify(u.id,`reassign:${t.id}:${now}`,`Вам передано «${t.character}» · ${project(t.project_id).title}`);}}
    if(b.deadline){if(!Number.isFinite(Date.parse(b.deadline)))error('Некоректна дата.');t.deadline=new Date(b.deadline).toISOString();t.deadline_manual=1;notify(t.assignee,`deadline:${t.id}:${t.deadline}`,`Оновлено дедлайн: ${t.character}\n${t.deadline}`);}
  }else if(action.type==='start'){
    own();if(t.status!=='todo')error('Завдання вже в роботі або завершене.');t.status='working';
  }else if(action.type==='complete'){
    own();if(t.status==='approved')return s;
    if(t.stage==='review')error('Позначте статуси та натисніть «Сповістити акторів».');
    if(['recording','correction'].includes(t.stage))error('Для здавання запису завантажте файл.');
    const e=ep(t.project_id,t.episode);if(t.independent){if(b.output_url){validURL(b.output_url);t.output_url=b.output_url;}t.status='approved';t.completed_at=now;audit();return s;}if(!e)error('Серія не має виробничого процесу.');
    if(b.output_url){validURL(b.output_url);t.output_url=str(b.output_url,2000);}
    if(['translation','editing'].includes(t.stage)&&!t.output_url&&!t.legacy_links?.length&&!s.takes.some(v=>v.task_id===t.id&&!v.local))error('Додайте файл або HTTPS-посилання на результат.',400,[t.id]);
    if(t.stage==='casting'){
      const cast=s.cast.filter(c=>c.project_id===e.project_id&&c.episode===e.number);if(!cast.length)error('Спершу прикріпіть або роздайте файли акторам.',400,[t.id]);
      if(cast.some(c=>!active(findUser(c.user_id))||!roles(findUser(c.user_id)).includes('actor')))error('У розподілі є недоступний актор.');
      if(!s.takes.some(v=>v.task_id===t.id&&!v.local)&&!t.output_url&&cast.some(c=>!c.script_url))error('Додайте субтитри або посилання для акторів.');
    }
    if(t.stage==='mixing'&&!e.ready_notified)error('Ще не здано всі записи та правки. Почати зведення можна, завершити — після повної готовності.',400,tasks(e).filter(x=>x.stage!=='mixing'&&x.status!=='approved').map(x=>x.id));
    t.status='approved';t.completed_at=now;
    if(tasks(e).filter(x=>x.stage===t.stage).every(x=>x.status==='approved')){
      if(t.stage==='translation')openStage(e,'editing');
      if(t.stage==='editing')openStage(e,'casting');
      if(t.stage==='casting'){
        for(const c of s.cast.filter(c=>c.project_id===e.project_id&&c.episode===e.number))createTask(e,'recording',c.user_id,c.character,c.script_url?`Субтитри: ${c.script_url}`:'Субтитри — у файлах серії.');e.stage='recording';
      }
      if(t.stage==='review'){e.review_done=1;tasks(e).filter(x=>x.stage==='recording').forEach(x=>{x.status='approved';x.completed_at=now;});e.stage='correction';ready(e);}
      if(t.stage==='mixing')finishEpisode(e);
    }
  }else if(action.type==='uploaded'){
    // Called by the trusted upload worker only, never exposed as a public command.
    notify(actor.id,'upload-done:'+action.take_id,`${label({project_id:t.project_id,number:t.episode})}: файл успішно надіслано — ${t.character}.`);
    if(t.material_kind){t.status='material';t.completed_at=null;for(const uid of new Set(s.memberships.filter(m=>m.project_id===t.project_id).map(m=>m.user_id)))if(uid!==actor.id)notify(uid,'episode-file:'+action.take_id,`${label({project_id:t.project_id,number:t.episode})}: додано матеріали серії «${t.character}».`);audit();return s;}
    const context={project_id:t.project_id,number:t.episode};
    const nextRoles={translation:['editor'],editing:['casting'],casting:[],recording:['reviewer','engineer'],correction:['reviewer','engineer'],review:['actor','engineer'],mixing:['admin'],other:['admin']}[t.stage]||[];
    const recipients=new Set();for(const role of nextRoles)for(const u of role==='admin'?s.users.filter(isAdmin):members(t.project_id,role))recipients.add(u.id);
    for(const x of s.tasks.filter(x=>x.project_id===t.project_id&&x.episode===t.episode&&nextRoles.includes(STAGE_ROLE[x.stage])))recipients.add(x.assignee);
    if(t.requested_by)recipients.add(t.requested_by);
    for(const uid of recipients)if(uid!==actor.id)notify(uid,'material:'+action.take_id,`${label(context)}: додано або замінено матеріали «${t.character}». Перевірте актуальні файли.`);
    // Successful publication completes subtitle work; failed uploads never reach this action.
    if(['translation','editing'].includes(t.stage)){
      if(t.status!=='approved'){
        t.status='approved';t.completed_at=now;
        const e=ep(t.project_id,t.episode);
        if(e&&!t.independent&&tasks(e).filter(x=>x.stage===t.stage).every(x=>x.status==='approved'))
          openStage(e,t.stage==='translation'?'editing':'casting');
      }
      audit();return s;
    }
    // Manual actor tasks also need a reviewer; do this before the independent-task return.
    if(t.stage==='recording'&&t.project_id!=='general'){
      const reviewContext=ep(t.project_id,t.episode)||{...context,id:t.project_id+':'+t.episode};
      openStage(reviewContext,'review');
    }
    if(t.stage==='recording')for(const check of s.tasks.filter(x=>x.stage==='review'&&x.project_id===t.project_id&&x.episode===t.episode)){
      if(check.status!=='planned'&&reviewActors(s,check).some(x=>!x.notified)){check.status='working';check.completed_at=null;const e=ep(t.project_id,t.episode);if(e&&!check.independent){e.review_done=0;e.ready_notified=0;e.stage='review';tasks(e).filter(x=>x.stage==='mixing'&&x.status==='approved').forEach(x=>{x.status='working';x.completed_at=null;});}}
    }
    const e=ep(t.project_id,t.episode);if(!e||t.independent){if(t.stage==='correction'){t.status='approved';t.completed_at=now;}audit();return s;}
    if(t.status==='approved'&&t.stage!=='correction'){audit();return s;}
    if(t.stage==='recording'){
      openStage(e,'mixing');openStage(e,'review');e.stage='recording';
      notifyRole(e,'reviewer',`take:${action.take_id}`,`${label(e)}: новий запис — ${t.character}. Можна вислуховувати.`);
      notifyRole(e,'engineer',`take:${action.take_id}`,`${label(e)}: новий запис — ${t.character}. Можна починати роботу з наявними файлами.`);
      if(allRecorded(e)){e.stage='review';notifyRole(e,'reviewer',`all-recorded:${e.id}`,`${label(e)}: усі перші записи здано. Завершіть вислуховування та надішліть правки.`);}
    }else if(t.stage==='correction'){
      t.status='approved';t.completed_at=now;
      notifyRole(e,'engineer',`take:${action.take_id}`,`${label(e)}: здано правки — ${t.character}.`);ready(e);
    }
  }else if(action.type==='read-notice'){const notice=s.notifications.find(n=>n.id===b.id&&n.user_id===actor.id);if(!notice)error('Сповіщення не знайдено.',404);notice.read_at??=now;
  }else if(action.type==='read-notices')s.notifications.filter(n=>n.user_id===actor.id).forEach(n=>n.read_at=now);
  else error('Невідома дія.');
  audit();
  function audit(){if(isAdmin(actor)&&!['quiet-hours','read-notice','read-notices','profile','profile-avatar','onboarding-seen'].includes(action.type)){
    const names={'material-assign':'Призначено відповідального за матеріали серії','material-link':'Додано посилання на матеріал серії','material-link-delete':'Вилучено посилання на матеріал','progress-import':'Перенесено попередній прогрес','task-create':'Створено завдання','cast-batch':'Роздано субтитри',guest:'Створено гостя',user:'Змінено ролі або доступ',project:'Змінено проєкт',members:'Змінено команду',episode:'Створено серію',cast:'Змінено розподіл ролей',rule:'Змінено строки', 'task-edit':'Змінено завдання',start:'Розпочато роботу',complete:'Завершено етап',uploaded:'Завантажено файл'};
    const detail=t?`${project(t.project_id).title} · серія ${t.episode} · ${t.character} · ${findUser(t.assignee).name}`:action.user_id?findUser(action.user_id).name:action.project_id?project(action.project_id).title:b.name||'';
    Object.assign(names,{'birthday':'Оновлено день народження та нагадування','reminders':'Оновлено нагадування про дедлайни','task-status':'Змінено статус завдання','task-delete':'Видалено завдання','episode-settings':'Змінено запуск етапів серії','project-episodes':'Змінено кількість серій'});
    const accessNames={active:'Доступ дозволено',pending:'Очікує схвалення',blocked:'Доступ заблоковано'};
    const statusNames={todo:'Очікується',working:'У роботі',review:'На перевірці',approved:'Завершено',revision:'Потрібні правки',planned:'Заплановано'};
    const parts=[];
    if(action.type==='user'){
      const target=findUser(action.user_id);
      parts.push('Ролі: '+roles(target).map(r=>ROLES[r]).join(', '),accessNames[target.access]);
    }else if(action.type==='birthday'){
      parts.push(b.month&&b.day?'День народження: '+String(b.day).padStart(2,'0')+'.'+String(b.month).padStart(2,'0'):'День народження не вказано');
      parts.push(b.enabled==='1'?'Нагадування за '+Number(b.ahead)+' дн.':'Нагадування вимкнено');
    }else if(action.type==='reminders'){
      parts.push(Number(b.interval)?'Повтор нагадувань: кожні '+Number(b.interval)+' год.':'Повторні нагадування вимкнено');
      parts.push(Number(b.ahead)?'Про найближчий дедлайн: за '+Number(b.ahead)+' дн.':'Попередні нагадування вимкнено');
    }else{
      if(b.title)parts.push('Назва: '+String(b.title).slice(0,150));
      if(b.code)parts.push('Код проєкту: '+String(b.code).slice(0,40));
      if(b.status&&statusNames[b.status])parts.push('Статус: '+statusNames[b.status]);
      if(b.days!==undefined)parts.push('Строк: '+Number(b.days)+' дн.');
    }
    const summary=parts.filter(Boolean).join('\n');
    s.users.filter(u=>active(u)&&isAdmin(u)&&u.id!==actor.id).forEach(u=>notify(u.id,'admin:'+id(),`${actor.name}: ${names[action.type]||'Оновлено налаштування студії'}${detail?'\n'+detail:''}${summary?'\n'+summary:''}`));
  }
  }
  return s;
}
export function validURL(raw,notion=false){let u;try{u=new URL(raw);}catch{error('Вкажіть повне HTTPS-посилання.');}if(u.protocol!=='https:'||u.username||u.password)error('Потрібне HTTPS-посилання.');if(notion&&!['notion.so','notion.site'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))error('Вкажіть посилання на сторінку Notion.');return u.href;}

export const aliasKey=value=>String(value||'').normalize('NFKC').trim().replace(/^@/,'').toLocaleLowerCase('uk-UA');
export function matchSubtitle(s,filename,projectId){
 const nick=aliasKey(filename.replace(/\.[^.]+$/,'').split('_')[0]);
 return s.users.filter(u=>active(u)&&roles(u).includes('actor')&&s.memberships.some(m=>m.project_id===projectId&&m.user_id===u.id&&m.role==='actor')&&([u.name,u.username].some(v=>aliasKey(v)===nick)||s.aliases.some(a=>a.key===nick&&a.user_id===u.id))).map(u=>u.id);
}

export function priorityCompare(s,a,b,overdue=false){
 const paid=id=>Number(s.projects.find(p=>p.id===id)?.paid)||0;
 const day=t=>{const d=new Date(t.deadline);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 return (overdue?paid(b.project_id)-paid(a.project_id):day(a).localeCompare(day(b)))||paid(b.project_id)-paid(a.project_id)||String(a.deadline).localeCompare(String(b.deadline))||a.id.localeCompare(b.id);
}
export function reviewActors(s,review){
 const recordings=s.tasks.filter(x=>x.project_id===review.project_id&&x.episode===review.episode&&x.stage==='recording');
 const meta=v=>{try{return typeof v.metadata==='string'?JSON.parse(v.metadata):v.metadata||{};}catch{return {};}};
 const superseded=new Set(s.takes.map(x=>meta(x).replaces).filter(Boolean));
 return [...new Set(recordings.map(x=>x.assignee))].map(user_id=>{
   const tasks=recordings.filter(x=>x.assignee===user_id),files=s.takes.filter(v=>tasks.some(x=>x.id===v.task_id)&&!v.local&&!superseded.has(v.id));
   const take_ids=files.map(x=>x.id).sort(),result=review.review_results?.[user_id];
   return {user_id,tasks,files,take_ids,ready:tasks.every(x=>x.admin_closed||files.some(v=>v.task_id===x.id)||(x.import_id&&['review','approved'].includes(x.status)&&x.legacy_links?.length)),result,notified:!!result&&!result.editing&&result.take_ids.join('|')===take_ids.join('|')};
 });
}

export function birthdayNotices(s,today){const [year,month,day]=today.split('-').map(Number),base=Date.UTC(year,month-1,day),out=[];for(const receiver of s.users.filter(active)){const pref=s.profiles.find(p=>p.user_id===receiver.id);if(!pref?.birthday_enabled)continue;for(const person of s.users.filter(active)){if(person.id===receiver.id)continue;const birth=s.profiles.find(p=>p.user_id===person.id)?.birthday;if(!birth)continue;for(const y of [year,year+1]){const last=new Date(Date.UTC(y,birth.month,0)).getUTCDate(),date=Date.UTC(y,birth.month-1,Math.min(birth.day,last)),left=Math.round((date-base)/86400000);if(left===pref.birthday_ahead)out.push({user_id:receiver.id,key:`birthday:${person.id}:${y}:${left}`,message:`${person.name}: ${left===0?'сьогодні день народження!':'день народження через '+left+' дн.'} (${birth.day}.${birth.month})`});}}}return out;}

import {notionService} from './notion.mjs';
import {userZone,zonedDate,noticeDates,quietMode} from '../dist/timezone.js';
import {hashFile,duplicateCandidates,takeMetadata} from './upload-checks.mjs';
import {MAX_UPLOAD_BYTES} from '../dist/file-checks.js';
import {castingLabels,castingSummary,subtitleLines} from './casting.mjs';
import {act} from '../dist/workflow.js';
import {fileLabels} from './file-labels.mjs';
import {buildNoticeBatches,noticeBatchText} from './notice-batches.mjs';
import {verifyBrowserToken,telegramKeys} from './browser-auth.mjs';
import {log} from './logger.mjs';
import {birthdayNotices} from '../dist/workflow.js';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,stat,rm,readdir,copyFile,realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {validateInitData,hashToken} from './auth.mjs';
import {normalizeAudio,run} from './audio.mjs';
import {migrate,readWorkflow,command} from './workflow-store.mjs';
import {allowedUpload,subtitleFile,roles,isAdmin,STAGE_ROLE,STAGES} from '../dist/workflow.js';
import {parseTelegramLink,parseTelegramTopicLink} from '../dist/telegram-link.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.resolve(process.env.DATA_DIR || path.join(ROOT,'data'));
const TEMP=path.join(DATA,'tmp');
const STAGED=path.join(DATA,'staged');
const deleting=new Set();
const BOT_TOKEN=process.env.BOT_TOKEN;
const GROUP_ID=process.env.TEAM_CHAT_ID;
const ADMINS=(process.env.ADMIN_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const BOT_API=(process.env.BOT_API_URL || 'http://telegram-bot-api:8081').replace(/\/$/,'');
const BOT_FILES=path.resolve(process.env.BOT_FILES_DIR || '/var/lib/telegram-bot-api');
const APP_URL=process.env.APP_URL;
const MAX_FILE=MAX_UPLOAD_BYTES;
if(new URL(BOT_API).hostname==='api.telegram.org')throw new Error('Цей реліз потребує локального Bot API для файлів до 2000 МБ.');
if(!BOT_TOKEN || !/^-100\d+$/.test(GROUP_ID || '') || ADMINS.length<1 || new Set(ADMINS).size!==ADMINS.length || ADMINS.some(id=>!/^\d+$/.test(id)) || !/^https:\/\//.test(APP_URL || '')) {
  throw new Error('Заповніть BOT_TOKEN, TEAM_CHAT_ID, один або більше різних ADMIN_IDS і HTTPS APP_URL у .env.');
}
await mkdir(TEMP,{recursive:true});await mkdir(STAGED,{recursive:true});
const db=new DatabaseSync(path.join(DATA,'studio.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT,role TEXT NOT NULL DEFAULT 'actor',notify INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS browser_challenges(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,code TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',chat_id TEXT,thread_id INTEGER,link TEXT);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),episode INTEGER NOT NULL,character TEXT NOT NULL,assignee TEXT NOT NULL REFERENCES users(id),deadline TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'todo',note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS takes(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL,filename TEXT NOT NULL,file_id TEXT NOT NULL,message_id INTEGER NOT NULL,chat_id TEXT NOT NULL,thread_id INTEGER NOT NULL,bytes INTEGER NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,version));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),user_id TEXT NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL,output TEXT,filename TEXT,error TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_documents(chat_id TEXT,message_id INTEGER,thread_id INTEGER,filename TEXT,file_id TEXT,bytes INTEGER,PRIMARY KEY(chat_id,message_id));
CREATE TABLE IF NOT EXISTS seen_messages(chat_id TEXT,message_id INTEGER,thread_id INTEGER,PRIMARY KEY(chat_id,message_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notices(key TEXT PRIMARY KEY,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_upload ON jobs(task_id) WHERE status IN ('uploading','queued','processing','publishing');
`);
// Sending to Telegram cannot be transactionally committed with SQLite: do not blindly resend after a crash.
db.prepare("UPDATE jobs SET status='queued' WHERE status='processing'").run();
db.prepare("UPDATE jobs SET status='uncertain',error='Перервано під час надсилання. Перевірте гілку перед повторним завантаженням.' WHERE status='publishing'").run();
db.prepare("UPDATE jobs SET status='failed',error='Завантаження перерване перезапуском сервера.' WHERE status='uploading'").run();
migrate(db);
const notion=notionService(db);
const notionImports=new Set();
// Bootstrap missing admins only. Subsequent role/access changes belong to the database.
for(const id of ADMINS) db.prepare(`INSERT OR IGNORE INTO users(id,name,role,roles,access) VALUES(?,?,'admin','["admin"]','active')`).run(id,`Адмін · ${id.slice(-4)}`);
const q=(sql,...args)=>db.prepare(sql).all(...args);
const one=(sql,...args)=>db.prepare(sql).get(...args);
const execute=(sql,...args)=>db.prepare(sql).run(...args);
const iso=()=>new Date().toISOString();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(value,max=100)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw fail(`Текст має містити від 1 до ${max} символів.`);return value.trim();};
const integer=(v,min=1,max=9999)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw fail('Некоректне число.');return n;};
const admin=u=>{if(!isAdmin(u))throw fail('Доступно адміністраторам.',403);};
const engineer=u=>{if(!roles(u).some(r=>['admin','reviewer','engineer'].includes(r)))throw fail('Доступно звукарям та адміністраторам.',403);};
const safeName=s=>s.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'_').slice(0,60)||'recording';
async function tg(method,body,timeout=30000){
  let response;
  try {response=await fetch(`${BOT_API}/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});} catch {throw fail('Telegram тимчасово недоступний.',502);}
  const data=await response.json(); if(!data.ok) throw fail(`Telegram: ${data.description || 'невідома помилка'}`,502);return data.result;
}
async function takeLocation(take){
  const metadata=typeof take.metadata==='string'?JSON.parse(take.metadata):take.metadata;
  const staged=metadata?.staged_path;
  const location=await realpath(staged|| (await tg('getFile',{file_id:take.file_id},120000)).file_path);
  const root=await realpath(staged?STAGED:BOT_FILES);if(!location.startsWith(root+path.sep))throw fail('Файл недоступний.',502);return location;
}
async function member(id){
  let m;try{m=await tg('getChatMember',{chat_id:GROUP_ID,user_id:Number(id)});}catch(e){if(/PARTICIPANT_ID_INVALID|USER_NOT_PARTICIPANT/.test(e.message))throw fail('Не вдалося підтвердити участь у групі студії. Приєднайтеся до групи своїм Telegram-акаунтом, натисніть Start у боті та спробуйте знову. Якщо ви вже в групі, зверніться до адміністратора: потрібно перевірити групу й права бота.',403);throw e;}
  if(!['creator','administrator','member'].includes(m.status) && !(m.status==='restricted'&&m.is_member))throw fail('Доступ лише для учасників команди.',403);
}
async function auth(req){
  const token=req.headers.authorization?.replace(/^Bearer /,'');
  if(!token&&!req.downloadSessionHash)throw fail('Відкрийте застосунок через Telegram.',401);
  const u=one('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.token=? AND sessions.expires>?',(req.downloadSessionHash||hashToken(token)),Date.now());
  if(!u)throw fail('Сесія завершилась. Відкрийте застосунок заново.',401);
  if(u.access!=='active')throw fail(u.access==='blocked'?'Доступ заблокований адміністратором.':'Очікуйте схвалення адміністратора.',403);
  u.roles=JSON.parse(u.roles);await member(u.id);return u;
}
async function loginIdentity(identity){
      execute("INSERT INTO users(id,name,username,role,roles,access) VALUES(?,?,?,'actor','[\"actor\"]','pending') ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username",String(identity.id),[identity.first_name,identity.last_name].filter(Boolean).join(' '),identity.username||'');
      const registered=one('SELECT * FROM users WHERE id=?',String(identity.id));
      if(registered.access==='pending')for(const admin of q("SELECT id FROM users WHERE access='active' AND role='admin'"))await sendNotice(admin.id,'access-request:'+registered.id,`${registered.name}: нова заявка на доступ. Відкрийте Команда → Заявки на доступ.`);
      if(registered.access!=='active')throw fail(registered.access==='blocked'?'Доступ заблокований адміністратором.':'Заявку отримано. Адміністратор має надати доступ.',403);
      await member(identity.id);
      const token=randomBytes(32).toString('hex');execute('DELETE FROM sessions WHERE expires<?',Date.now());execute('INSERT INTO sessions VALUES(?,?,?)',hashToken(token),String(identity.id),Date.now()+12*3600000);
      return {token,...state(one('SELECT * FROM users WHERE id=?',String(identity.id)))};
}
async function json(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>65536)throw fail('Запит завеликий.',413);}try{return JSON.parse(s||'{}');}catch{throw fail('Некоректний JSON.');}}
function respond(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function taskFor(id,u){const t=readWorkflow(db).tasks.find(t=>t.id===id);if(!t)throw fail('Завдання не знайдено.',404);return t;}
function state(u){
  const data=readWorkflow(db);const me=data.users.find(x=>x.id===u.id);
  return {...data,notion_enabled:notion.configured(),mode:'live',user:me,takes:data.takes.map(t=>({...t,metadata:JSON.parse(t.metadata)})),jobs:q('SELECT id,task_id,status,error,created_at FROM jobs ORDER BY created_at DESC LIMIT 200'),notifications:data.notifications.filter(n=>isAdmin(me)||n.user_id===me.id),upload_limit:MAX_FILE,notificationErrors:isAdmin(me)?data.notifications.filter(n=>n.status==='failed'||n.status==='uncertain'):[]};
}
function uploadAllowed(t,u){if(t.material_kind){if(!isAdmin(u)&&!(t.material_editors||[t.assignee]).includes(u.id))throw fail('Немає дозволу редагувати матеріали.',403);return;}if(t.status==='planned')throw fail('Адмін ще не запустив етап.');
  if(!isAdmin(u)&&(u.id!==t.assignee||(t.stage!=='other'&&!roles(u).includes(STAGE_ROLE[t.stage]))))throw fail('Завантажувати може виконавець потрібної ролі або адміністратор.',403);

}
async function resolveBinding(link,manualThread){
  const parsed=parseTelegramTopicLink(link);
  const chat=await tg('getChat',{chat_id:parsed.chatId});
  if(String(chat.id)!==GROUP_ID || chat.type!=='supergroup' || !chat.is_forum)throw fail('Оберіть гілку форуму вашої командної групи.');
  let threadId=parsed.threadId;
  if(!threadId)threadId=one('SELECT thread_id FROM seen_messages WHERE chat_id=? AND message_id=?',GROUP_ID,parsed.messageId)?.thread_id;
  if(!threadId&&manualThread)threadId=integer(manualThread,1,2147483647);
  if(!threadId)return {...parsed,chatId:GROUP_ID,chatTitle:chat.title,needsThread:true};
  return {...parsed,chatId:GROUP_ID,chatTitle:chat.title,threadId,needsThread:false};
}
async function sendNotice(userId,key,message){
  execute("INSERT OR IGNORE INTO notifications(id,key,user_id,message,status,created_at) VALUES(?,?,?,?,'pending',?)",randomUUID(),key,userId,message,iso());
}

db.exec('CREATE TABLE IF NOT EXISTS download_tickets(token TEXT PRIMARY KEY,session_hash TEXT NOT NULL,route TEXT NOT NULL,expires INTEGER NOT NULL)');
let uploads=0;let zipBusy=false;
const server=http.createServer(async(req,res)=>{
  const requestId=randomUUID(),started=Date.now();
  res.setHeader('X-Request-ID',requestId);
  let finished=false;
  res.on('finish',()=>{finished=true;if(req.url!=='/api/health'||res.statusCode>=400)log(res.statusCode>=500?'error':res.statusCode>=400?'warn':'info','http.complete',{request_id:requestId,method:req.method,status:res.statusCode,duration_ms:Date.now()-started});});
  res.on('close',()=>{if(!finished)log('warn','http.aborted',{request_id:requestId,method:req.method,duration_ms:Date.now()-started});});
  try{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    let url=new URL(req.url,'http://localhost');let p=url.pathname;
    if(p.startsWith('/download/')&&req.method==='GET'){
      const ticket=one('SELECT * FROM download_tickets WHERE token=? AND expires>?',hashToken(p.slice(10)),Date.now());
      if(!ticket)throw fail('Посилання завершило дію. Створіть нове в застосунку.',401);
      req.downloadSessionHash=ticket.session_hash;url=new URL(ticket.route,'http://localhost');p=url.pathname;
    }
    if(p==='/api/health')return respond(res,200,{ok:true,mode:'live',release:'2026.11.10.34'});
    if(p==='/api/browser-auth'&&req.method==='GET'){
      const clientId=process.env.TELEGRAM_LOGIN_CLIENT_ID;
      if(!/^\d+$/.test(clientId||''))return respond(res,200,{enabled:false});
      execute('DELETE FROM browser_challenges WHERE expires<?',Date.now());
      if(one('SELECT COUNT(*) AS n FROM browser_challenges').n>=1000)throw fail('Забагато спроб входу. Спробуйте пізніше.',429);
      const nonce=randomBytes(32).toString('hex');execute('INSERT INTO browser_challenges VALUES(?,?)',hashToken(nonce),Date.now()+300000);
      res.setHeader('Set-Cookie',`__Host-studio-login=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300`);
      return respond(res,200,{enabled:true,client_id:clientId,nonce});
    }
    if(p==='/api/browser-auth'&&req.method==='POST'){
      if(req.headers.origin!==new URL(APP_URL).origin)throw fail('Недоступне джерело входу.',403);
      const nonce=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-studio-login='))?.split('=')[1];
      if(!/^[a-f0-9]{64}$/.test(nonce||'')||!one('SELECT nonce FROM browser_challenges WHERE nonce=? AND expires>?',hashToken(nonce),Date.now()))throw fail('Спробу входу завершено. Оновіть сторінку.',401);
      const b=await json(req);let identity;
      try{identity=verifyBrowserToken(b.id_token,process.env.TELEGRAM_LOGIN_CLIENT_ID,nonce,await telegramKeys());}catch{throw fail('Не вдалося підтвердити вхід Telegram. Спробуйте знову.',401);}
      if(execute('DELETE FROM browser_challenges WHERE nonce=? AND expires>?',hashToken(nonce),Date.now()).changes!==1)throw fail('Цю спробу входу вже використано. Оновіть сторінку.',401);
      res.setHeader('Set-Cookie','__Host-studio-login=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return respond(res,200,await loginIdentity(identity));
    }
    if(p==='/api/logout'&&req.method==='POST'){
      const bearer=req.headers.authorization?.replace(/^Bearer /,'');if(bearer)execute('DELETE FROM sessions WHERE token=?',hashToken(bearer));
      return respond(res,200,{ok:true});
    }
    if(p==='/api/auth'&&req.method==='POST'){
      const b=await json(req);let identity;try{identity=validateInitData(b.initData,BOT_TOKEN);}catch(e){throw fail(e.message,401);}
      return respond(res,200,await loginIdentity(identity));
    }
    if(p.startsWith('/api/')){
      const u=await auth(req);
      if(isAdmin(u)&&req.method!=='GET'&&!['/api/workflow','/api/notifications','/api/download-link','/api/resolve-link'].includes(p))res.once('finish',()=>{if(res.statusCode<300)for(const other of q('SELECT id,roles,access FROM users'))if(other.id!==u.id&&other.access==='active'&&JSON.parse(other.roles).includes('admin'))void sendNotice(other.id,'admin:'+randomUUID(),`${u.name}: ${p==='/api/profile/avatar'?'Оновлено аватарку':p.includes('binding')?'Оновлено прив’язку Telegram':p==='/api/projects'?'Створено проєкт':'Збережено зміни в студії'}.`);});
      if(req.method!=='GET'&&one("SELECT value FROM settings WHERE key='maintenance'")?.value==='1')throw fail('Триває оновлення. Перегляд доступний; збереження відновиться за кілька хвилин.',503);
      if(req.method==='POST'&&p==='/api/download-link'){
        const b=await json(req),route=String(b.route||'');
        if(route.length>20000||!/^\/(?:takes\/[^/?#]+\/download|materials\/archive|projects\/[^/?#]+\/episodes\/\d+\/archive)(?:\?[^#]*)?$/.test(route))throw fail('Недоступне завантаження.');
        const ticket=randomBytes(32).toString('hex');execute('DELETE FROM download_tickets WHERE expires<?',Date.now());
        execute('INSERT INTO download_tickets VALUES(?,?,?,?)',hashToken(ticket),hashToken(req.headers.authorization.replace(/^Bearer /,'')),'/api'+route,Date.now()+600000);
        return respond(res,200,{url:new URL('/download/'+ticket,APP_URL).href});
      }
      if(p.startsWith('/api/notion/')){
        const permitted=()=>{if(!isAdmin(u)&&!roles(u).includes('reviewer'))throw fail('Доступно правкеру або адміну.',403);};
        if(req.method==='GET'&&p==='/api/notion/views'){permitted();return respond(res,200,{views:await notion.views()});}
        if(req.method==='POST'&&p==='/api/notion/import'){
          permitted();const b=await json(req),s=readWorkflow(db),task=s.tasks.find(t=>t.id===b.task_id);
          if(!task||task.stage!=='review'||task.status==='planned'||!isAdmin(u)&&task.assignee!==u.id)throw fail('Оберіть власне активне завдання правкера.',403);
          if(!s.tasks.some(t=>t.project_id===task.project_id&&t.episode===task.episode&&t.stage==='recording'&&t.assignee===b.actor_id))throw fail('Актор не бере участі у цій серії.');
          const key=task.id+':'+b.actor_id;if(notionImports.has(key)||notionImports.size>=2)throw fail('Імпорт уже виконується. Дочекайтеся завершення.',409);notionImports.add(key);
          try{return respond(res,200,await notion.collect(b,task,b.actor_id,u));}finally{notionImports.delete(key);}
        }
        const snapshotMatch=p.match(/^\/api\/notion\/snapshots\/([a-zA-Z0-9-]+)$/);
        if(req.method==='GET'&&snapshotMatch){const snap=notion.snapshot(snapshotMatch[1]);if(!snap.published&&snap.created_by!==u.id&&!isAdmin(u))throw fail('Копія правок ще не надіслана.',403);return respond(res,200,{id:snap.id,...JSON.parse(snap.body)});}
        const assetMatch=p.match(/^\/api\/notion\/assets\/([a-f0-9]{64})$/);
        if(req.method==='GET'&&assetMatch){const a=one('SELECT a.mime,a.bytes FROM notion_assets a WHERE a.id=? AND EXISTS(SELECT 1 FROM notion_snapshot_assets sa JOIN notion_snapshots s ON s.id=sa.snapshot_id WHERE sa.asset_id=a.id AND (s.published=1 OR s.created_by=? OR ?=1))',assetMatch[1],u.id,isAdmin(u)?1:0);if(!a)throw fail('Зображення не знайдено.',404);res.writeHead(200,{'Content-Type':a.mime,'Content-Length':a.bytes.length,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(a.bytes);}
        throw fail('Невідомий запит Notion.',404);
      }
      if(req.method==='GET'&&p==='/api/state')return respond(res,200,state(u));
      if(req.method==='GET'&&p==='/api/import-documents'){admin(u);return respond(res,200,{files:q('SELECT chat_id,message_id,thread_id,filename,bytes FROM telegram_documents WHERE chat_id=? UNION SELECT chat_id,message_id,thread_id,filename,bytes FROM takes WHERE chat_id=? AND message_id>0 ORDER BY message_id DESC LIMIT 500',GROUP_ID,GROUP_ID)});}
      if(req.method==='POST'&&p==='/api/workflow'){
        const action=await json(req);
        if(!['credit-save','credit-delete','quiet-hours','timezone','material-assign','material-link','material-link-delete','episode-add','episode-delete','progress-import','take-delete','onboarding-seen','birthday','episode-settings','reminders','task-status','task-delete','project-plan','episode-start','review-reopen','review-notify','profile','request-fix','task-create','cast-batch','guest','user','project','members','episode','cast','rule','task-edit','start','complete','read-notice','read-notices'].includes(action.type))throw fail('Недоступна дія.');
        if(action.type==='cast-batch'&&readWorkflow(db).batches.includes(action.data?.batch_id)){const check=readWorkflow(db);act(check,action,check.users.find(v=>v.id===u.id));return respond(res,200,{ok:true});}
        if(action.task_id&&readWorkflow(db).takes.some(v=>v.task_id===action.task_id&&deleting.has(v.id)))throw fail('Зачекайте видалення файла.',409);
        if(action.task_id&&one("SELECT id FROM jobs WHERE task_id=? AND status IN ('uploading','queued','processing','publishing')",action.task_id))throw fail('Зачекайте завершення завантаження.',409);
        if(action.type==='complete'&&action.task_id){const task=taskFor(action.task_id,u);if(one("SELECT jobs.id FROM jobs JOIN tasks ON tasks.id=jobs.task_id WHERE tasks.project_id=? AND tasks.episode=? AND jobs.status IN ('uploading','queued','processing','publishing')",task.project_id,task.episode))throw fail('Зачекайте завершення завантажень цієї серії.',409);}
        if(['user','members','cast'].includes(action.type)&&one("SELECT id FROM jobs WHERE status IN ('uploading','queued','processing','publishing')"))throw fail('Зачекайте завершення черги перед зміною команди.',409);
        if(action.type==='cast-batch'){
          if(!Array.isArray(action.data?.files)||action.data.files.some(f=>!f.take_id))throw fail('Розподіляйте завантажені файли.');
          const before=readWorkflow(db);if(before.batches.includes(action.data.batch_id))return respond(res,200,{ok:true});
          db.exec('BEGIN IMMEDIATE');try{command(db,action,u,true);execute('INSERT INTO jobs(id,task_id,user_id,status,input,filename,created_at) VALUES(?,?,?,?,?,?,?)',randomUUID(),action.task_id,u.id,'queued','',JSON.stringify({cast_batch:action.data}),iso());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
          return respond(res,200,{ok:true});
        }
        if(action.type==='take-delete'){
          const snapshot=readWorkflow(db),take=snapshot.takes.find(v=>v.id===action.data.take_id);act(snapshot,action,snapshot.users.find(v=>v.id===u.id));
          if(deleting.has(take.id))throw fail('Файл уже видаляється.',409);deleting.add(take.id);
          try{if(action.data.delete_telegram&&take.message_id){try{await tg('deleteMessage',{chat_id:take.chat_id,message_id:take.message_id});}catch(e){if(!/message to delete not found/i.test(e.message))throw fail('Telegram не видалив повідомлення. Файл залишено у застосунку. '+e.message,502);}}
            command(db,action,u);
            const m=JSON.parse(take.metadata);if(m.staged_path)await rm(path.join(STAGED,take.id),{recursive:true,force:true});
          }finally{deleting.delete(take.id);}return respond(res,200,{ok:true});
        }
        if(action.type==='progress-import'&&action.data?.guided){
          admin(u);if(readWorkflow(db).importIds.includes(action.data.import_id))return respond(res,200,{ok:true});
          const docs=[];for(const row of action.data.rows||[])for(const link of row.links||[]){try{const p=parseTelegramLink(link);if(p.chatId!==GROUP_ID)continue;const doc=one('SELECT * FROM telegram_documents WHERE chat_id=? AND message_id=?',p.chatId,p.messageId)||one('SELECT * FROM takes WHERE chat_id=? AND message_id=?',p.chatId,p.messageId);if(doc){if(!allowedUpload(row.stage,doc.filename))throw fail('Формат не відповідає етапу: '+doc.filename);docs.push({row,doc});}}catch(err){if(err.message.startsWith('Формат'))throw err;}}
          db.exec('BEGIN IMMEDIATE');try{
            const imported=command(db,action,u,true);
            for(const {row,doc} of docs){const task=imported.tasks.find(t=>t.import_id===action.data.import_id&&t.stage===row.stage&&t.assignee===row.assignee);const version=Number(one('SELECT MAX(version) AS v FROM takes WHERE task_id=?',task.id).v||0)+1;execute('INSERT INTO takes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),task.id,version,doc.filename,doc.file_id,doc.message_id,doc.chat_id,doc.thread_id||1,doc.bytes||0,JSON.stringify({imported:true,kind:['recording','correction'].includes(task.stage)?'audio':'document',original_name:doc.filename,uploaded_by:u.id}),iso(),task.assignee);}
            // Bind completed review decisions to the actual imported take IDs.
            const extra=JSON.parse(one("SELECT value FROM workflow_extras WHERE key='state'").value);
            for(const task of imported.tasks.filter(t=>t.import_id===action.data.import_id&&t.stage==='review'))for(const [uid,result] of Object.entries(extra.tasks[task.id].review_results||{}))result.take_ids=q("SELECT takes.id FROM takes JOIN tasks ON tasks.id=takes.task_id WHERE tasks.project_id=? AND tasks.episode=? AND tasks.stage='recording' AND tasks.assignee=?",task.project_id,task.episode,uid).map(x=>x.id).sort();
            execute("UPDATE workflow_extras SET value=? WHERE key='state'",JSON.stringify(extra));db.exec('COMMIT');
          }catch(e){db.exec('ROLLBACK');throw e;}return respond(res,200,{ok:true,attached:docs.length});
        }
        if(action.type==='review-notify'){
          notion.validateEntries(action,u);
          db.exec('BEGIN IMMEDIATE');try{const result=command(db,action,u,true);for(const task of result.tasks)if(task.notion_snapshot_id)execute('UPDATE notion_snapshots SET published=1 WHERE id=?',task.notion_snapshot_id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
          return respond(res,200,{ok:true});
        }
        command(db,action,u);return respond(res,200,{ok:true});
      }
      if(req.method==='POST'&&p==='/api/profile/avatar'){
        const photos=await tg('getUserProfilePhotos',{user_id:Number(u.id),offset:0,limit:1});let avatar='';
        if(photos.photos?.[0]?.length){const photo=photos.photos[0][0];const f=await tg('getFile',{file_id:photo.file_id});const location=await realpath(f.file_path),root=await realpath(BOT_FILES);if(!location.startsWith(root+path.sep))throw fail('Недоступний файл аватара.');const info=await stat(location);if(info.size>500000)throw fail('Аватар завеликий.');avatar='data:image/jpeg;base64,'+(await readFile(location)).toString('base64');}
        command(db,{type:'profile-avatar',data:{avatar}},u);return respond(res,200,{ok:true});
      }
      if(req.method==='POST'&&p==='/api/notifications'){
        const b=await json(req);execute('UPDATE users SET notify=? WHERE id=?',b.enabled?1:0,u.id);return respond(res,200,{ok:true});
      }
      if(req.method==='POST'&&p==='/api/resolve-link'){admin(u);const b=await json(req);return respond(res,200,await resolveBinding(text(b.link,500),b.threadId));}
      if(req.method==='POST'&&p==='/api/projects'){
        admin(u);const b=await json(req);const id=randomUUID();const title=text(b.title);const code=text(b.code,30);if(!/^[A-Za-z0-9_-]+$/.test(code))throw fail('Код проєкту: латинські літери, цифри, _ або -.');
        db.exec('BEGIN IMMEDIATE');try{if(code.toLowerCase()==='general'||one('SELECT id FROM projects WHERE lower(code)=lower(?)',code))throw fail('Цей код файлів уже використовується іншим проєктом.');execute('INSERT INTO projects(id,title,code,description,paid) VALUES(?,?,?,?,?)',id,title,code,String(b.description||'').slice(0,500),Number(b.paid)===1?1:0);command(db,{type:'project-plan',project_id:id,data:{count:b.episode_count||1,season:b.season||1}},u,true);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return respond(res,201,{id});
      }
      let match=p.match(/^\/api\/projects\/([^/]+)\/binding$/);
      if(req.method==='POST'&&match){
        admin(u);const b=await json(req);const r=await resolveBinding(text(b.link,500),b.threadId);
        if(r.needsThread)throw fail('У цьому посиланні немає ID гілки. Скопіюйте посилання з її заголовка або зазначте ID вручну.');
        if(!one('SELECT id FROM projects WHERE id=?',match[1]))throw fail('Проєкт не знайдено.',404);
        execute('UPDATE projects SET chat_id=?,thread_id=?,link=? WHERE id=?',r.chatId,r.threadId,r.url,match[1]);return respond(res,200,r);
      }
      if(req.method==='POST'&&p==='/api/tasks'){
        admin(u);const b=await json(req);const id=randomUUID();const deadline=new Date(b.deadline);if(!Number.isFinite(deadline.getTime()))throw fail('Оберіть дедлайн.');
        const project=one('SELECT * FROM projects WHERE id=?',b.project_id);if(!project||!one("SELECT id FROM users WHERE id=? AND access='active'",b.assignee))throw fail('Оберіть проєкт і учасника.');
        if(one('SELECT id FROM episodes WHERE project_id=? AND number=?',project.id,integer(b.episode)))throw fail('У цій серії завдання створюються виробничим процесом.');
        if(!JSON.parse(one('SELECT roles FROM users WHERE id=?',b.assignee).roles).includes('actor'))throw fail('Виконавець повинен мати роль актора.');
        execute("INSERT OR IGNORE INTO memberships VALUES(?,?,'actor')",project.id,b.assignee);
        execute('INSERT INTO tasks(id,project_id,episode,character,assignee,deadline,note) VALUES(?,?,?,?,?,?,?)',id,project.id,integer(b.episode),text(b.character,80),b.assignee,deadline.toISOString(),String(b.note||'').slice(0,1000));
        void sendNotice(b.assignee,`new:${id}`,`Нове завдання: ${project.title} · серія ${b.episode}\n${b.character}\nДедлайн: ${zonedDate(deadline,userZone(readWorkflow(db),b.assignee))}`);
        return respond(res,201,{id});
      }
      match=p.match(/^\/api\/tasks\/([^/]+)$/);
      if(req.method==='PATCH'&&match){
        const t=taskFor(match[1],u),b=await json(req);
        if(one('SELECT id FROM episodes WHERE project_id=? AND number=?',t.project_id,t.episode))throw fail('Використайте дію виробничого процесу.');
        if(b.status){
          if(b.status==='working'){if(t.assignee!==u.id&&u.role!=='admin')throw fail('Взяти завдання може виконавець або адміністратор.',403);if(t.status!=='todo'&&t.status!=='revision')throw fail('Це завдання вже здано або взято в роботу.');}
          else if(['approved','revision'].includes(b.status)){engineer(u);if(!one('SELECT id FROM takes WHERE task_id=?',t.id))throw fail('Спочатку потрібен запис.');}
          else throw fail('Недоступний статус.');
          if(one("SELECT id FROM jobs WHERE task_id=? AND status IN ('queued','processing','publishing')",t.id))throw fail('Зачекайте завершення обробки запису.',409);
          execute('UPDATE tasks SET status=? WHERE id=?',b.status,t.id);
        }
        if(b.deadline){admin(u);if(!Number.isFinite(Date.parse(b.deadline)))throw fail('Некоректний дедлайн.');execute('UPDATE tasks SET deadline=? WHERE id=?',new Date(b.deadline).toISOString(),t.id);}
        return respond(res,200,{ok:true});
      }
      match=p.match(/^\/api\/tasks\/([^/]+)\/telegram-files$/);
      if(req.method==='POST'&&match){
        const t=taskFor(match[1],u);uploadAllowed(t,u);if(t.stage!=='casting')throw fail('Доступно у завданні рольовика.');
        const b=await json(req);if(!Array.isArray(b.links)||!b.links.length||b.links.length>100)throw fail('Вкажіть від 1 до 100 посилань.');
        const docs=[];
        for(const link of b.links){let parsed;try{parsed=parseTelegramLink(link);}catch(e){throw fail(e.message);}
          let chatId=parsed.chatId;if(chatId.startsWith('@'))chatId=String((await tg('getChat',{chat_id:chatId})).id);
          if(chatId!==GROUP_ID)throw fail('Оберіть файли з командної групи.');
          const known=one('SELECT * FROM takes WHERE chat_id=? AND message_id=?',chatId,parsed.messageId);
          const doc=known?{...known,filename:JSON.parse(known.metadata)?.original_name||known.filename}:one('SELECT * FROM telegram_documents WHERE chat_id=? AND message_id=?',chatId,parsed.messageId);
          if(!doc)throw fail('Бот ще не бачив цей файл. Перешліть його у командну групу й вставте нове посилання, завантажте файл або скористайтеся ручним прикріпленням.');
          if(!subtitleFile(doc.filename))throw fail('Посилання має вести на субтитри або ZIP.');docs.push({...doc,link});
        }
        const files=[];db.exec('BEGIN IMMEDIATE');try{for(const doc of docs){let take=one('SELECT * FROM takes WHERE task_id=? AND chat_id=? AND message_id=?',t.id,doc.chat_id,doc.message_id);if(!take){const tid=randomUUID(),version=Number(one('SELECT MAX(version) AS v FROM takes WHERE task_id=?',t.id).v||0)+1;execute('INSERT INTO takes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',tid,t.id,version,doc.filename,doc.file_id,doc.message_id,doc.chat_id,doc.thread_id||1,doc.bytes||0,JSON.stringify({kind:'document',original_name:doc.filename,source_link:doc.link,uploaded_by:u.id}),iso(),t.assignee);take=one('SELECT * FROM takes WHERE id=?',tid);}files.push({take_id:take.id,name:doc.filename,size:doc.bytes||0});}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return respond(res,200,{files});
      }
      match=p.match(/^\/api\/tasks\/([^/]+)\/upload$/);
      if(req.method==='POST'&&match){
        const t=taskFor(match[1],u);uploadAllowed(t,u);const replaces=String(req.headers['x-replaces-take']||'');if(replaces&&!one('SELECT id FROM takes WHERE id=? AND task_id=?',replaces,t.id))throw fail('Файл для заміни не належить завданню.');
        const project=one('SELECT * FROM projects WHERE id=?',t.project_id);if(!project.thread_id)throw fail('Адміністратор має прив’язати гілку Telegram.');
        if(uploads>=2 || q("SELECT id FROM jobs WHERE status IN ('queued','processing','publishing')").length>=10)throw fail('Черга зайнята. Спробуйте трохи пізніше.',429);
        if(one("SELECT id FROM jobs WHERE task_id=? AND status IN ('queued','processing','publishing','uploading')",t.id))throw fail('Запис для цього завдання вже обробляється.',409);
        const size=Number(req.headers['content-length']);if(!Number.isFinite(size)||size<=0||size>MAX_FILE)throw fail('Файл має бути до 2000 МБ.',413);
        const id=randomUUID(),dir=path.join(TEMP,id);await mkdir(dir);const original=decodeURIComponent(String(req.headers['x-file-name']||'recording.wav'));const ext=path.extname(original).toLowerCase();
        if(!allowedUpload(t.stage,original))throw fail(['translation','editing','casting'].includes(t.stage)?'Для цього етапу дозволено лише субтитри та ZIP.':'Недозволений формат файла для цього етапу.');
        const input=path.join(dir,'input'+(['recording','correction'].includes(t.stage)?'.audio':ext));
        execute('INSERT INTO jobs(id,task_id,user_id,status,input,created_at) VALUES(?,?,?,?,?,?)',id,t.id,u.id,'uploading',input,iso());uploads++;
        try{
          const sourceHasher=createHash('sha256');let received=0;const limit=new Transform({transform(chunk,encoding,callback){received+=chunk.length;sourceHasher.update(chunk);callback(received>MAX_FILE?fail('Файл завеликий.',413):null,chunk);}});
          await pipeline(req,limit,createWriteStream(input,{flags:'wx'}));if(received!==size)throw fail('Файл отримано не повністю.');
          const source_hash=sourceHasher.digest('hex');const duplicate=duplicateCandidates(readWorkflow(db),t).find(v=>takeMetadata(v).source_hash===source_hash);if(duplicate)throw fail('Файл дублюється: вміст збігається з '+duplicate.filename+'. Приберіть дублікат або оберіть виправлений файл.',409);
          execute("UPDATE jobs SET status='queued',filename=? WHERE id=?",JSON.stringify({name:original,replaces,source_hash,staged:t.stage==='casting'&&req.headers['x-stage-casting']==='1',unsplit:t.stage==='casting'&&req.headers['x-unsplit']==='1'}),id);respond(res,202,{id});
        }catch(e){execute("UPDATE jobs SET status='failed',error=? WHERE id=?",e.message,id);await rm(dir,{recursive:true,force:true});throw e;}finally{uploads--;}
        return;
      }
      match=p.match(/^\/api\/takes\/([^/]+)\/download$/);
      if(req.method==='GET'&&match){
        const take=readWorkflow(db).takes.find(v=>v.id===match[1]);if(!take)throw fail('Файл не знайдено.',404);
        const location=await takeLocation(take);
        const info=await stat(location);res.writeHead(200,{'content-type':'application/octet-stream','content-length':info.size,'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(take.filename)}`});await pipeline(createReadStream(location),res);return;
      }
      match=p.match(/^\/api\/projects\/([^/]+)\/episodes\/(\d+)\/archive$/);
      if(req.method==='GET'&&(match||p==='/api/materials/archive')){
        const materialMode=p==='/api/materials/archive';const fileIds=[...new Set(url.searchParams.getAll('file'))];if(materialMode&&(!fileIds.length||fileIds.length>500))throw fail('Оберіть від 1 до 500 файлів.');
        const reviewMode=url.searchParams.get('mode')==='review';
        if(!materialMode&&(reviewMode?!roles(u).some(r=>['reviewer','admin'].includes(r)):!roles(u).some(r=>['engineer','admin'].includes(r))))throw fail('Архів доступний відповідальним за вислуховування або зведення.',403);
        const actorIds=url.searchParams.getAll('actor');
        if(zipBusy)throw fail('Інший архів уже збирається. Спробуйте за хвилину.',429);zipBusy=true;
        const dir=path.join(TEMP,randomUUID());
        try{
          const project=materialMode?{code:'Materials'}:one('SELECT * FROM projects WHERE id=?',match[1]);if(!project)throw fail('Проєкт не знайдено.',404);
          const allTakes=materialMode?q(`SELECT takes.*,tasks.stage,tasks.assignee FROM takes JOIN tasks ON tasks.id=takes.task_id WHERE takes.id IN (${fileIds.map(()=>'?').join(',')})`,...fileIds):q(`SELECT takes.*,tasks.stage,tasks.assignee FROM takes JOIN tasks ON tasks.id=takes.task_id WHERE tasks.project_id=? AND tasks.episode=? AND tasks.stage IN ('recording','correction')`,project.id,Number(match[2]));
          if(fileIds.some(id=>!allTakes.some(t=>t.id===id)))throw fail('Один із файлів не належить вибраному архіву.');
          const deleted=new Set(readWorkflow(db).deletedTakeIds);const superseded=new Set(allTakes.map(t=>JSON.parse(t.metadata).replaces).filter(Boolean));const takes=allTakes.filter(t=>!deleted.has(t.id)&&(materialMode||!superseded.has(t.id))&&(!fileIds.length||fileIds.includes(t.id))&&(!reviewMode||t.stage==='recording')&&(!actorIds.length||actorIds.includes(t.assignee)));
          if(actorIds.some(id=>!allTakes.some(t=>t.assignee===id)))throw fail('Актор не має записів у цій серії.');
          if(!takes.length)throw fail('У серії ще немає записів.');
          if(takes.reduce((s,t)=>s+t.bytes,0)>5*1024**3)throw fail('Архів перевищує 5 ГіБ. Завантажте файли з гілки окремо.');
          await mkdir(dir);const names=[];
          for(const take of takes){const location=await takeLocation(take);const folder=materialMode?'Матеріали':take.stage==='recording'?'Перші записи':'Фікси';await mkdir(path.join(dir,folder),{recursive:true});const name=`${folder}/${take.id.slice(0,8)}_${take.filename}`;await copyFile(location,path.join(dir,name));names.push(name);}
          const archive=path.join(dir,'recordings.zip');await run('zip',['-0','-q',archive,...names],{cwd:dir});const info=await stat(archive);
          res.writeHead(200,{'content-type':'application/zip','content-length':info.size,'content-disposition':`attachment; filename="${safeName(project.code)}${materialMode?'':'_E'+match[2]}.zip"`});await pipeline(createReadStream(archive),res);
        }finally{zipBusy=false;await rm(dir,{recursive:true,force:true});}
        return;
      }
      throw fail('Маршрут не знайдено.',404);
    }
    if(req.method!=='GET'&&req.method!=='HEAD')throw fail('Метод не підтримується.',405);
    const allowed={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/navigation.js':'navigation.js','/workflow.js':'workflow.js','/production.css':'production.css','/style.css':'style.css','/mobile.css':'mobile.css','/telegram-link.js':'telegram-link.js','/file-checks.js':'file-checks.js','/studio-tools.js':'studio-tools.js','/timezone.js':'timezone.js','/notion-render.js':'notion-render.js'};
    const brandedAsset=/^\/assets\/(logo-on-dark|logo-on-light|mark-red|mark-white|mark-black|orbit-red|orbit-charcoal|orbit-grey)\.png$/.test(p);
    const filename=allowed[p]||(brandedAsset?p.slice(1):null);if(!filename)throw fail('Сторінку не знайдено.',404);
    const type=brandedAsset?'image/png':filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'text/javascript';
    res.setHeader('Content-Type',brandedAsset?type:`${type}; charset=utf-8`);res.setHeader('Cache-Control','no-cache');
    await pipeline(createReadStream(path.join(ROOT,'dist',filename)),res);
  }catch(e){if(!res.headersSent&&!res.destroyed)respond(res,e.status||500,{error:e.status?e.message:'Помилка сервера. Повторіть спробу.',task_ids:e.task_ids||[],request_id:requestId});else res.destroy();log((e.status||500)>=500?'error':'warn','http.failed',{request_id:requestId,status:e.status||500,method:req.method},e);}
});
server.requestTimeout=60*60*1000;
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>log('info','server.ready',{port:Number(process.env.PORT||3000)}));

async function publishCasting(job,batch){
  const s=readWorkflow(db),task=s.tasks.find(t=>t.id===job.task_id),project=s.projects.find(p=>p.id===task?.project_id);
  if(!task||!project)throw fail('Завдання розподілу більше не існує.');
  const actor=s.users.find(u=>u.id===job.user_id);uploadAllowed(task,actor);await member(job.user_id);
  const dir=path.join(TEMP,job.id);await mkdir(dir,{recursive:true});
  const prepared=[],names=new Map();
  for(const file of batch.files){
    const take=s.takes.find(v=>v.id===file.take_id&&v.task_id===task.id);if(!take)throw fail('Файл розподілу вилучено.');
    const metadata=JSON.parse(take.metadata),source=await takeLocation(take),ext=path.extname(take.filename).toLowerCase();
    const people=file.users.map(id=>s.users.find(u=>u.id===id));if(people.some(u=>!u||u.access!=='active'))throw fail('Один з акторів недоступний.');
    const base=castingLabels(project,task,people,ext),count=names.get(base.filename)||0;names.set(base.filename,count+1);const labels=castingLabels(project,task,people,ext,count);
    const folder=path.join(dir,take.id);await mkdir(folder,{recursive:true});const output=path.join(folder,labels.filename);await copyFile(source,output);
    const lines=ext==='.zip'||(await stat(source)).size>16*1024*1024?null:subtitleLines(await readFile(source,'utf8'),take.filename);
    prepared.push({take,metadata,output,labels,lines,users:file.users});
  }
  const users=[...new Set(batch.files.flatMap(f=>f.users))].map(id=>s.users.find(u=>u.id===id));
  const summary=castingSummary(project,task,prepared,users),target={chat_id:project.chat_id,...(project.thread_id===1?{}:{message_thread_id:project.thread_id})};
  // Never automatically repeat a request after an ambiguous Telegram response.
  execute("UPDATE jobs SET status='publishing' WHERE id=?",job.id);
  for(const text of summary)await tg('sendMessage',{...target,text,disable_notification:true});
  const save=(item,message)=>{
    if(!message?.document?.file_id||!message.message_id)throw fail('Telegram не підтвердив файл пачки.',502);
    const metadata={...item.metadata,distributed_users:item.users,line_count:item.lines};delete metadata.staged_path;
    execute('UPDATE takes SET filename=?,file_id=?,message_id=?,chat_id=?,thread_id=?,metadata=?,actor_id=? WHERE id=?',item.labels.filename,message.document.file_id,message.message_id,project.chat_id,project.thread_id,JSON.stringify(metadata),item.users.length===1?item.users[0]:task.assignee,item.take.id);
  };
  const fresh=prepared.filter(x=>!x.take.message_id);
  for(let i=0;i<fresh.length;i+=10){const chunk=fresh.slice(i,i+10);
    const media=chunk.map(x=>({type:'document',media:`file://${x.output}`,caption:x.labels.caption}));
    const messages=chunk.length===1?[await tg('sendDocument',{...target,document:media[0].media,caption:media[0].caption,disable_notification:true},600000)]:await tg('sendMediaGroup',{...target,media,disable_notification:true},600000);
    if(!Array.isArray(messages)||messages.length!==chunk.length)throw fail('Telegram повернув неповну пачку. Перевірте гілку.',502);
    db.exec('BEGIN IMMEDIATE');try{chunk.forEach((x,j)=>save(x,messages[j]));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  }
  // Existing v18 files are corrected in place rather than sent a second time.
  for(const item of prepared.filter(x=>x.take.message_id)){
    if(item.take.filename===item.labels.filename&&JSON.stringify(item.metadata.distributed_users)===JSON.stringify(item.users))continue;
    const message=await tg('editMessageMedia',{chat_id:item.take.chat_id,message_id:item.take.message_id,media:{type:'document',media:`file://${item.output}`,caption:item.labels.caption}},600000);save(item,message);
  }
  command(db,{type:'uploaded',task_id:task.id,take_id:'batch:'+batch.batch_id},actor);
  for(const item of prepared)if(item.metadata.staged_path)await rm(path.join(STAGED,item.take.id),{recursive:true,force:true});
  await rm(dir,{recursive:true,force:true});
}

let working=false;
async function work(){
  if(working)return;const job=one("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1");if(!job)return;working=true;let sending=false;const jobStarted=Date.now();log('info','job.started',{job_id:job.id,task_id:job.task_id});
  try{
    execute("UPDATE jobs SET status='processing' WHERE id=?",job.id);
    let payload={};try{payload=JSON.parse(job.filename||'{}');}catch{}if(payload.cast_batch){await publishCasting(job,payload.cast_batch);execute("UPDATE jobs SET status='done',error=NULL WHERE id=?",job.id);return;}
    const task=readWorkflow(db).tasks.find(t=>t.id===job.task_id),project=readWorkflow(db).projects.find(p=>p.id===task.project_id),actor=readWorkflow(db).users.find(u=>u.id===task.assignee);
    let upload={name:job.filename};try{const parsed=JSON.parse(job.filename);if(parsed&&typeof parsed==='object')upload=parsed;}catch{}
    const version=Number(one('SELECT MAX(version) AS v FROM takes WHERE task_id=?',task.id).v||0)+1;
    if(upload.staged){
      const current=readWorkflow(db).users.find(u=>u.id===job.user_id);uploadAllowed(task,current);
      const same=duplicateCandidates(readWorkflow(db),task).find(v=>takeMetadata(v).source_hash===upload.source_hash&&upload.source_hash);if(same)throw fail('Файл дублюється: '+same.filename,409);
      const id=randomUUID(),dir=path.join(STAGED,id);await mkdir(dir);const location=path.join(dir,'source'+path.extname(job.input));await copyFile(job.input,location);const info=await stat(location);
      db.exec('BEGIN IMMEDIATE');try{execute('INSERT INTO takes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,task.id,version,upload.name,'',0,project.chat_id,project.thread_id,info.size,JSON.stringify({kind:'document',source_hash:upload.source_hash,content_hash:upload.source_hash,staged_path:location,original_name:upload.name,upload_job_id:job.id,uploaded_by:job.user_id}),iso(),task.assignee);
      execute("UPDATE jobs SET status='done',error=NULL WHERE id=?",job.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}await rm(path.dirname(job.input),{recursive:true,force:true});return;
    }

    const audio=['recording','correction'].includes(task.stage);
    const labels=fileLabels(project,task,actor,audio?'.flac':path.extname(job.input));
    const filename=labels.filename;
    const output=path.join(path.dirname(job.input),filename);let metadata;
    const currentUser=one('SELECT * FROM users WHERE id=?',job.user_id);if(currentUser?.access!=='active')throw fail('Доступ завантажувача заблоковано.');currentUser.roles=JSON.parse(currentUser.roles);uploadAllowed(task,currentUser);
    if(audio)metadata=await normalizeAudio(job.input,output);else{await copyFile(job.input,output);metadata={kind:'document'};}
    const info=await stat(output);
    metadata.source_hash=upload.source_hash||await hashFile(job.input);metadata.content_hash=await hashFile(output);
    for(const previous of duplicateCandidates(readWorkflow(db),task)){
      const old=takeMetadata(previous);let same=old.source_hash===metadata.source_hash||old.content_hash===metadata.content_hash;
      if(!same&&!old.content_hash&&previous.bytes===info.size){const checksum=await hashFile(await takeLocation(previous));execute('UPDATE takes SET metadata=? WHERE id=?',JSON.stringify({...old,content_hash:checksum}),previous.id);same=checksum===metadata.content_hash;}
      if(same)throw fail('Файл дублюється: вміст збігається з '+previous.filename+'. Оберіть файл зі змінами.',409);
    }
    if(info.size>MAX_FILE)throw fail('Вихідний FLAC перевищив ліміт Telegram.');
    await member(job.user_id);
    execute("UPDATE jobs SET status='publishing',output=?,filename=? WHERE id=?",output,filename,job.id);sending=true;
    metadata.unsplit=!!upload.unsplit;metadata.original_name=upload.name;metadata.replaces=upload.replaces||null;metadata.upload_job_id=job.id;metadata.uploaded_by=job.user_id;metadata.performer_id=task.assignee;
    const message=await tg('sendDocument',{chat_id:project.chat_id,...(project.thread_id===1?{}:{message_thread_id:project.thread_id}),document:`file://${output}`,disable_notification:true,caption:labels.caption},600000);
    if(!message.document?.file_id)throw fail('Telegram не повернув ідентифікатор документа.',502);
    db.exec('BEGIN IMMEDIATE');
    try{execute('INSERT INTO takes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),task.id,version,filename,message.document.file_id,message.message_id,project.chat_id,project.thread_id,info.size,JSON.stringify(metadata),iso(),task.assignee);if(audio&&task.status!=='approved')execute("UPDATE tasks SET status='review' WHERE id=?",task.id);command(db,{type:'uploaded',task_id:task.id,take_id:message.document.file_id},currentUser,true);execute("UPDATE jobs SET status='done',error=NULL WHERE id=?",job.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    log('info','job.completed',{job_id:job.id,task_id:job.task_id,duration_ms:Date.now()-jobStarted});
    // A cleanup failure must not turn a confirmed delivery into an uncertain one.
    await rm(path.dirname(job.input),{recursive:true,force:true}).catch(e=>log('warn','job.cleanup_failed',{job_id:job.id},e));
  }catch(e){log('error','job.failed',{job_id:job.id,task_id:job.task_id,phase:sending?'delivery_uncertain':'processing',duration_ms:Date.now()-jobStarted},e);execute('UPDATE jobs SET status=?,error=? WHERE id=?',(sending||one('SELECT status FROM jobs WHERE id=?',job.id)?.status==='publishing')?'uncertain':'failed',e.message.slice(0,700),job.id);}finally{working=false;}
}
setInterval(()=>void work(),1500);

// Long polling observes new group messages to recover thread IDs absent from links.
// No command replies or progress messages are posted to the group.
async function polling(){
  let offset=Number(one("SELECT value FROM settings WHERE key='offset'")?.value||0);
  for(;;){
    try{const updates=await tg('getUpdates',{offset,timeout:25,allowed_updates:['message','edited_message']},35000);
      for(const update of updates){const m=update.message||update.edited_message;
        if(m?.chat.type==='private'&&/^\/start(?:@\w+)?(?: |$)/.test(m.text||''))execute('UPDATE users SET notify=1 WHERE id=?',String(m.from.id));
        if(m&&String(m.chat.id)===GROUP_ID&&m.message_thread_id)execute('INSERT OR REPLACE INTO seen_messages VALUES(?,?,?)',GROUP_ID,m.message_id,m.message_thread_id);
        if(m&&String(m.chat.id)===GROUP_ID&&m.document?.file_id)execute('INSERT OR REPLACE INTO telegram_documents VALUES(?,?,?,?,?,?)',GROUP_ID,m.message_id,m.message_thread_id||1,m.document.file_name||'',m.document.file_id,m.document.file_size||0);
        offset=update.update_id+1;execute("INSERT INTO settings VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(offset));
      }
    }catch(e){log('error','telegram.poll_failed',{},e);await new Promise(r=>setTimeout(r,5000));}
  }
}
void polling();
let maintenanceRunning=false;
setInterval(async()=>{
  if(maintenanceRunning)return;maintenanceRunning=true;
  try{
    const now=Date.now(),ws=readWorkflow(db);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));for(const notice of birthdayNotices(ws,today))await sendNotice(notice.user_id,notice.key,notice.message);const due=ws.tasks.filter(t=>['todo','working','revision'].includes(t.status)&&t.deadline);
    for(const t of due){const profile=ws.profiles.find(p=>p.user_id===t.assignee)||{},hours=profile.reminder_hours??24,days=profile.reminder_days||0,delta=Date.parse(t.deadline)-now;
      const nearest=due.filter(x=>x.assignee===t.assignee&&Date.parse(x.deadline)>now).sort((a,b)=>a.deadline.localeCompare(b.deadline))[0];
      if(delta<0&&hours>0||delta>0&&days>0&&delta<=days*86400000&&nearest?.id===t.id){const kind=delta>0?'soon':'late',bucket=delta>0?'once':Math.floor(-delta/(hours*3600000));await sendNotice(t.assignee,`${kind}:${t.id}:${t.deadline}:${hours}:${days}:${bucket}`,`${delta>0?'⏳ Дедлайн наближається':'⌛ Дедлайн минув'}\n${ws.projects.find(p=>p.id===t.project_id)?.title} · ${t.character}\n${zonedDate(t.deadline,userZone(ws,t.assignee))}`);}}
    for(const entry of await readdir(TEMP,{withFileTypes:true})){if(!entry.isDirectory())continue;const dir=path.join(TEMP,entry.name);const info=await stat(dir);const job=one('SELECT status FROM jobs WHERE id=?',entry.name);if(now-info.mtimeMs>86400000&&!['queued','processing','publishing'].includes(job?.status)){await rm(dir,{recursive:true,force:true});if(job?.status==='uploading')execute("UPDATE jobs SET status='failed',error='Завантаження перерване' WHERE id=?",entry.name);}}
  }catch(e){log('error','maintenance.failed',{},e);}finally{maintenanceRunning=false;}
},60000);

// Persistent outbox: each recipient has an in-app notice even without Telegram write permission.
execute("UPDATE notifications SET status='uncertain',error='Перезапуск під час доставки: перевірте приватний діалог.' WHERE status='sending'");
let delivering=false;
setInterval(async()=>{
  if(delivering)return;delivering=true;
  try{
    const now=Date.now();
    const rows=q("SELECT n.* FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.status IN ('pending','failed') AND n.attempts<5 AND n.read_at IS NULL AND u.access='active' AND u.notify=1 ORDER BY n.created_at");
    const deliveryState=readWorkflow(db);
    for(const batch of buildNoticeBatches(rows,now).filter(batch=>quietMode(deliveryState,batch[0].user_id,now)!=='pause').slice(0,10)){
      const n=batch[0],mode=quietMode(readWorkflow(db),n.user_id,Date.now());
      if(mode==='pause')continue;
      for(const item of batch)execute("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=?",item.id);
      try{
        await member(n.user_id);
        const payload={chat_id:Number(n.user_id),disable_notification:mode==='silent',text:`У вас ${one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL',n.user_id).n} непрочитаних сповіщень у студії.`,reply_markup:{inline_keyboard:[[{text:'Відкрити Studio',web_app:{url:new URL('/#/inbox',APP_URL).href}}]]}};
        const setting='inbox-message:'+n.user_id,old=one('SELECT value FROM settings WHERE key=?',setting);
        const message=await tg('sendMessage',payload);
        execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',setting,String(message.message_id));
        if(old)try{await tg('deleteMessage',{chat_id:Number(n.user_id),message_id:Number(old.value)});}catch{}
        for(const item of batch)execute("UPDATE notifications SET status='sent',error=NULL WHERE id=?",item.id);
      }catch(e){
        log('warn','notification.failed',{notification_id:n.id,attempt:n.attempts+1},e);
        for(const item of batch)execute("UPDATE notifications SET status='failed',error=?,next_attempt=? WHERE id=?",e.message,Date.now()+60000*2**item.attempts,item.id);
      }
    }
  }finally{delivering=false;}
},3000);

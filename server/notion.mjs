import {randomUUID,createHash} from 'node:crypto';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
const err=(message,status=400)=>Object.assign(new Error(message),{status});
const enc=encodeURIComponent;
export const plain=parts=>(parts||[]).map(x=>x.plain_text??x.text?.content??x.mention?.page?.id??'').join('');
export function actorValues(p){if(!p)return [];switch(p.type){case 'select':case 'status':return p[p.type]?[p[p.type].name]:[];case 'multi_select':return p.multi_select.map(x=>x.name);case 'people':return p.people.map(x=>x.name||x.id);case 'rich_text':case 'title':return [plain(p[p.type])];default:throw err('Поле актора повинно бути Select, Multi-select, People або текстом.');}}
export function property(page,key){return page.properties?.[key]||Object.values(page.properties||{}).find(p=>p.id===key);}
// Pin resolved public IPv4 addresses; redirects are revalidated, credentials never leave api.notion.com.
export function publicV4(ip){if(isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
export async function imageBytes(url,hops=0){
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||hops>4)throw err('Недоступна адреса зображення Notion.');
 const ips=await lookup(u.hostname,{family:4,all:true});if(!ips.length||ips.some(x=>!publicV4(x.address)))throw err('Недоступна мережна адреса зображення.');
 return new Promise((resolve,reject)=>{const req=https.get(u,{lookup:(_h,_o,cb)=>cb(null,ips[0].address,4),timeout:20000},res=>{
  if([301,302,303,307,308].includes(res.statusCode)){res.resume();imageBytes(new URL(res.headers.location,u).href,hops+1).then(resolve,reject);return;}
  const mime=String(res.headers['content-type']||'').split(';')[0];if(res.statusCode!==200||!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(mime)){res.resume();reject(err('Не вдалося зберегти зображення: потрібен PNG, JPEG, WebP, GIF або AVIF.'));return;}
  let size=0;const chunks=[];res.on('data',c=>{size+=c.length;if(size>20*1024*1024){req.destroy(err('Зображення більше 20 МБ.'));return;}chunks.push(c);});res.on('end',()=>resolve({mime,bytes:Buffer.concat(chunks)}));res.on('error',reject);
 });req.on('timeout',()=>req.destroy(err('Час завантаження зображення вичерпано.')));req.on('error',reject);});
}
export function notionService(db,{token=process.env.NOTION_TOKEN,database=process.env.NOTION_DATABASE_ID,fetcher=fetch,download=imageBytes,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS notion_snapshots(id TEXT PRIMARY KEY,review_task TEXT NOT NULL,actor_id TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notion_assets(id TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS notion_snapshot_assets(snapshot_id TEXT NOT NULL REFERENCES notion_snapshots(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES notion_assets(id),PRIMARY KEY(snapshot_id,asset_id));`);
 db.prepare('DELETE FROM notion_snapshots WHERE published=0 AND created_at<?').run(new Date(Date.now()-7*86400000).toISOString());
 db.exec('DELETE FROM notion_assets WHERE NOT EXISTS(SELECT 1 FROM notion_snapshot_assets sa WHERE sa.asset_id=notion_assets.id)');
 let last=0;
 async function api(route,body,method=body?'POST':'GET'){
  if(!token||!database)throw err('Адмін має налаштувати NOTION_TOKEN і NOTION_DATABASE_ID на сервері.',503);
  for(let attempt=0;attempt<4;attempt++){
   const pause=Math.max(0,last+350-Date.now());if(pause)await wait(pause);last=Date.now();
   let res;try{res=await fetcher('https://api.notion.com/v1/'+route,{method,headers:{Authorization:'Bearer '+token,'Notion-Version':'2026-03-11','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});}catch{throw err('Notion не відповідає. Спробуйте ще раз.',502);}
   if(res.status===429){await wait(Math.min(10000,Math.max(1000,Number(res.headers.get('retry-after')||1)*1000)));continue;}
   if(!res.ok)throw err(res.status===401?'Notion: перевірте токен інтеграції.':res.status===404?'Notion: надайте інтеграції доступ до бази та сторінок.':'Notion відхилив запит (HTTP '+res.status+'). Перевірте доступ і налаштування.',502);
   return res.status===204?{}:res.json();
  }throw err('Notion тимчасово обмежив кількість запитів. Повторіть пізніше.',503);
 }
 async function all(route){let items=[],cursor;do{const r=await api(route+(route.includes('?')?'&':'?')+'page_size=100'+(cursor?'&start_cursor='+enc(cursor):''));items.push(...r.results);if(items.length>3000)throw err('Забагато елементів. Звузьте фільтр Notion.');cursor=r.has_more?r.next_cursor:null;if(r.has_more&&!cursor)throw err('Notion повернув неповну сторінку.');}while(cursor);return items;}
 let cached=null,cacheTime=0;
 async function views(){if(cached&&Date.now()-cacheTime<60000)return cached;const refs=await all('views?database_id='+enc(database));const out=[];for(const ref of refs){const v=await api('views/'+enc(ref.id||ref.view?.id));if(v.type==='board')out.push({id:v.id,name:v.name,actor_property:v.configuration?.group_by?.property_id||''});}cached=out;cacheTime=Date.now();return out;}
 async function collect({view_id,alias,actor_property},review,actor,user){
  if(typeof alias!=='string'||!alias.trim()||alias.length>150)throw err('Вкажіть точний псевдонім актора в Notion.');alias=alias.trim();
  if(!(await views()).some(v=>v.id===view_id))throw err('Оберіть вкладку з підключеної бази Notion.');
  const view=await api('views/'+enc(view_id)),key=String(actor_property||view.configuration?.group_by?.property_id||'');if(!key||key.length>150)throw err('Укажіть назву поля Notion, у якому записані псевдоніми акторів.');
  let query=await api('views/'+enc(view_id)+'/queries',{page_size:100}),qid=query.id,refs=[];
  try{while(true){refs.push(...query.results);if(refs.length>3000)throw err('Звузьте фільтри вкладки до потрібного тайтла й серії.');if(!query.has_more)break;if(!query.next_cursor)throw err('Notion повернув неповний результат.');query=await api('views/'+enc(view_id)+'/queries/'+enc(qid)+'?page_size=100&start_cursor='+enc(query.next_cursor));}}finally{try{await api('views/'+enc(view_id)+'/queries/'+enc(qid),null,'DELETE');}catch{}}
  const pages=[];for(const ref of refs){const p=ref.properties?ref:await api('pages/'+enc(ref.id));const prop=property(p,key);if(!prop)throw err('Поле актора «'+key+'» не знайдено.');if(actorValues(prop).includes(alias))pages.push(p);}
  if(!pages.length)throw err('У цій вкладці немає правок для псевдоніма «'+alias+'». Перевірте фільтри та написання.');
  if(pages.length>200)throw err('Понад 200 карток для актора. Звузьте фільтр до потрібної серії.');
  const assets=new Map(),warnings=new Set();let blockCount=0,totalBytes=0;
  async function media(object){if(!object)return;const url=object.file?.url||object.external?.url;if(!url)throw err('Notion не повернув адресу зображення. Перевірте доступ або повторіть імпорт.');const asset=await download(url);totalBytes+=asset.bytes.length;if(totalBytes>100*1024*1024)throw err('Зображення правок перевищують 100 МБ. Звузьте вибір.');const id=createHash('sha256').update(asset.bytes).digest('hex');assets.set(id,asset);object.local_asset=id;delete object.file;delete object.external;}
  async function tree(id,depth=0){if(depth>20)throw err('Вкладеність сторінок Notion перевищує 20 рівнів.');const blocks=await all('blocks/'+enc(id)+'/children');for(const b of blocks){if(++blockCount>5000)throw err('Забагато блоків у правках.');if(b.type==='image')await media(b.image);if(b.type==='unsupported'||['child_database','embed','video','audio','file','pdf','bookmark','link_preview'].includes(b.type))warnings.add('Блок «'+b.type+'» збережено, але інтерактивний вміст або вкладення можуть відкриватися лише в Notion.');if(b.type==='synced_block'&&b.synced_block?.synced_from?.block_id)b.children=await tree(b.synced_block.synced_from.block_id,depth+1);else if(b.has_children)b.children=await tree(b.id,depth+1);}return blocks;}
  for(const p of pages){if(p.cover)await media(p.cover);if(p.icon&&p.icon.type!=='emoji'){warnings.add('Іконки сторінок доступні в Notion.');}p.children=await tree(p.id);}
  const id=randomUUID(),body={view:{id:view.id,name:view.name,filter:view.filter,sorts:view.sorts,configuration:view.configuration},alias,actor_property:key,pages,warnings:[...warnings],created_at:new Date().toISOString()};
  db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO notion_snapshots VALUES(?,?,?,?,?,0,?)').run(id,review.id,actor,user.id,body.created_at,JSON.stringify(body));for(const [aid,a] of assets){db.prepare('INSERT OR IGNORE INTO notion_assets VALUES(?,?,?)').run(aid,a.mime,a.bytes);db.prepare('INSERT INTO notion_snapshot_assets VALUES(?,?)').run(id,aid);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  return {id,...body};
 }
 function snapshot(id){const r=db.prepare('SELECT * FROM notion_snapshots WHERE id=?').get(id);if(!r)throw err('Копію правок не знайдено.',404);return r;}
 function validateEntries(action,user){for(const e of action.data?.entries||[]){delete e.notion_snapshot_id;if(!e.notion_import){if(token&&database&&e.status==='fix')throw err('Спочатку імпортуйте й перевірте правки Notion для кожного актора зі статусом «Є правки».');continue;}if(e.status!=='fix')throw err('Імпорт Notion призначений для статусу «Є правки».');const s=snapshot(e.notion_import);if(s.review_task!==action.task_id||s.actor_id!==e.user_id||s.created_by!==user.id)throw err('Копія правок не відповідає завданню або актору.',403);e.notion_snapshot_id=s.id;}}
 return {views,collect,snapshot,validateEntries,configured:()=>Boolean(token&&database)};
}

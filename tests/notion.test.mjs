import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {notionService,publicV4,actorValues} from '../server/notion.mjs';
import {renderNotion,rich} from '../dist/notion-render.js';
const rt=t=>[{type:'text',plain_text:t,text:{content:t}}];
const page=(id,actor)=>({id,object:'page',url:'https://notion.so/'+id,properties:{Actor:{id:'actor',type:'multi_select',multi_select:[{name:actor}]},Name:{type:'title',title:rt('0:15 Правка '+id)}}});
function fixture({broken=false}={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const calls=[];
 const fetcher=async(url,opts)=>{const path=url.replace('https://api.notion.com/v1/','');calls.push([path,opts.method]);let data;
 if(path.startsWith('views?'))data={results:[{id:'v'}],has_more:false};
 else if(path==='views/v')data={id:'v',type:'board',name:'Тайтл · серія 1',configuration:{group_by:{property_id:'actor'}}};
 else if(path==='views/v/queries')data={id:'q',results:[page('other','Someone else'),page('p1','Nick')],has_more:true,next_cursor:'next'};
 else if(path.startsWith('views/v/queries/q')&&opts.method==='GET')data={results:[page('p2','Nick')],has_more:false};
 else if(opts.method==='DELETE')data={};
 else if(path.startsWith('blocks/p1/children'))data={results:[{id:'b',type:'paragraph',paragraph:{rich_text:rt('Текст')},has_children:true}],has_more:false};
 else if(path.startsWith('blocks/b/children'))data={results:[{id:'i',type:'image',image:{type:'file',file:{url:'https://example.com/image.png'},caption:rt('Підпис')}}],has_more:false};
 else if(path.startsWith('blocks/p2/children'))data={results:[],has_more:false};
 else throw new Error('Unexpected '+path);
 return new Response(JSON.stringify(data),{status:200});};
 const service=notionService(db,{token:'secret',database:'db',fetcher,download:async()=>{if(broken)throw Error('download failed');return {mime:'image/png',bytes:Buffer.from('image-data')};},wait:async()=>{}});
 return {db,service,calls};
}
test('view filters/order, paginated results, exact actor matching, recursive content and durable image bytes',async()=>{
 const {db,service,calls}=fixture();try{const s=await service.collect({view_id:'v',alias:'Nick'}, {id:'review'},'actor',{id:'reviewer'});
 assert.deepEqual(s.pages.map(p=>p.id),['p1','p2']);assert.ok(calls.some(([p,m])=>p==='views/v/queries/q'&&m==='DELETE'));
 const image=s.pages[0].children[0].children[0].image;assert.equal(image.file,undefined);assert.equal(image.caption[0].plain_text,'Підпис');assert.equal(Buffer.from(db.prepare('SELECT bytes FROM notion_assets').get().bytes).toString(),'image-data');
 const a={task_id:'review',data:{entries:[{user_id:'actor',status:'fix',notion_import:s.id,notion_snapshot_id:'forged'}]}};
 service.validateEntries(a,{id:'reviewer'});assert.equal(a.data.entries[0].notion_snapshot_id,s.id);
 assert.throws(()=>service.validateEntries({...a,task_id:'wrong'},{id:'reviewer'}),/відповідає/);
 assert.throws(()=>service.validateEntries(a,{id:'other'}),/відповідає/);
 assert.throws(()=>service.validateEntries({data:{entries:[{status:'fix'}]}},{id:'reviewer'}),/імпортуйте/);
 assert.equal(db.prepare('SELECT published FROM notion_snapshots').get().published,0);
 const html=renderNotion(s);assert.match(html,/Підпис/);assert.match(html,/data-notion-asset/);assert.doesNotMatch(html,/image.png/);
 }finally{db.close();}
});
test('failed media import leaves no partial snapshot or assets',async()=>{const {db,service}=fixture({broken:true});try{await assert.rejects(service.collect({view_id:'v',alias:'Nick'},{id:'r'},'a',{id:'u'}),/download failed/);assert.equal(db.prepare('SELECT count(*) n FROM notion_snapshots').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM notion_assets').get().n,0);}finally{db.close();}});
test('unknown actors/views fail closed; rich content cannot inject HTML or javascript links',async()=>{const {db,service}=fixture();try{await assert.rejects(service.collect({view_id:'v',alias:'Nic'},{id:'r'},'a',{id:'u'}),/немає правок/);await assert.rejects(service.collect({view_id:'wrong',alias:'Nick'},{id:'r'},'a',{id:'u'}),/Оберіть вкладку/);}finally{db.close();}const html=rich([{text:{content:'<img onerror=alert(1)>',link:{url:'javascript:alert(1)'}}}]);assert.doesNotMatch(html,/<img|href=/);assert.match(html,/&lt;/);assert.equal(publicV4('127.0.0.1'),false);assert.equal(publicV4('169.254.169.254'),false);assert.equal(publicV4('10.0.0.1'),false);assert.equal(publicV4('::1'),false);assert.equal(publicV4('8.8.8.8'),true);assert.deepEqual(actorValues({type:'select',select:{name:'Nick'}}),['Nick']);});

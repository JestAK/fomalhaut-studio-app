import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdtemp,mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from '../server/audio.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function signed(id){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Test '+id,username:'test'+id})});const key=createHmac('sha256','WebAppData').update('test-token').digest();p.set('hash',createHmac('sha256',key).update([...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();}
test('server: authenticated team workflow, ACL, actual processing, Telegram routing and ZIP',{timeout:45000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fomalhaut-integration-')),cache=path.join(dir,'cache');await mkdir(cache);
  const docs=[],albums=[],messages=[],deletions=[];let rejectDelete=false;const removed=new Set();
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const d of req)raw+=d;const b=JSON.parse(raw||'{}');const method=req.url.split('/').at(-1);let result;
    if(method==='getChatMember'&&b.user_id===999){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,description:'Bad Request: PARTICIPANT_ID_INVALID'}));return;}
    if(method==='getChatMember')result={status:removed.has(b.user_id)?'left':'member'};
    else if(method==='getChat')result={id:-1001234567890,title:'Test team',type:'supergroup',is_forum:true};
    else if(method==='getUpdates'){await delay(250);result=[];}
    else if(method==='sendDocument'){
      docs.push(b);const fileId='file'+docs.length;const filename=path.basename(new URL(b.document).pathname);await copyFile(new URL(b.document),path.join(cache,fileId));result={message_id:100+docs.length,document:{file_id:fileId,file_name:filename}};
    }else if(method==='sendMediaGroup'){
      albums.push(b);result=[];for(const media of b.media){const fileId='album'+albums.length+'-'+result.length;await copyFile(new URL(media.media),path.join(cache,fileId));result.push({message_id:300+albums.length*10+result.length,document:{file_id:fileId}});}
    }else if(method==='editMessageMedia'){
      const fileId='edited'+b.message_id;await copyFile(new URL(b.media.media),path.join(cache,fileId));result={message_id:b.message_id,document:{file_id:fileId}};
    }else if(method==='deleteMessage'){
      deletions.push(b);if(rejectDelete){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,description:'message cannot be deleted'}));return;}result=true;
    }else if(method==='getUserProfilePhotos')result={total_count:0,photos:[]};
    else if(method==='getFile')result={file_path:path.join(cache,b.file_id)};
    else if(method==='sendMessage'){messages.push(b);result={message_id:900+messages.length};}
    else {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,description:'Unexpected method'}));return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  let logs='';const proc=spawn(process.execPath,['server/index.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOT_TOKEN:'test-token',TEAM_CHAT_ID:'-1001234567890',ADMIN_IDS:'111',APP_URL:'https://example.com',TELEGRAM_LOGIN_CLIENT_ID:'123',BOT_API_URL:`http://127.0.0.1:${mock.address().port}`,BOT_FILES_DIR:cache,DATA_DIR:path.join(dir,'data'),PORT:String(port)},stdio:['ignore','pipe','pipe']});proc.stdout.on('data',d=>logs+=d);proc.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`;
  async function call(route,token,method='GET',body){const r=await fetch(base+'/api'+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();return {status:r.status,...data};}
  try{
    let ready=false;for(let i=0;i<60;i++){try{await fetch(base+'/api/health');ready=true;break;}catch{await delay(100);}}assert.ok(ready,logs);
    const challenge=await fetch(base+'/api/browser-auth');const config=await challenge.json();
    assert.equal(config.enabled,true);assert.equal(config.client_id,'123');assert.match(config.nonce,/^[a-f0-9]{64}$/);
    assert.match(challenge.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await fetch(base+'/api/browser-auth',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/browser-auth',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'})).status,401);
    const disposable=await call('/auth',null,'POST',{initData:signed(111)});
    assert.equal((await call('/logout',disposable.token,'POST')).status,200);
    assert.equal((await call('/state',disposable.token)).status,401);
    assert.equal((await call('/state')).status,401);
    assert.equal((await call('/auth',null,'POST',{initData:'bad'})).status,401);
    const admin=await call('/auth',null,'POST',{initData:signed(111)});assert.equal(admin.status,200,JSON.stringify(admin));
    const request=await call('/auth',null,'POST',{initData:signed(999)});assert.equal(request.status,403);assert.match(request.error,/Заявку отримано/);
    await call('/auth',null,'POST',{initData:signed(999)});
    let pendingState=await call('/state',admin.token);assert.equal(pendingState.users.find(u=>u.id==='999').access,'pending');assert.equal(pendingState.notifications.filter(n=>n.key==='access-request:999'&&n.user_id==='111').length,1);
    assert.equal((await call('/workflow',admin.token,'POST',{type:'user',user_id:'999',data:{access:'active',roles:['actor']}})).status,200);
    const noGroup=await call('/auth',null,'POST',{initData:signed(999)});assert.equal(noGroup.status,403);assert.match(noGroup.error,/участь у групі/);assert.equal(noGroup.token,undefined);
    for(const id of [333,444]){assert.equal((await call('/auth',null,'POST',{initData:signed(id)})).status,403);assert.equal((await call('/workflow',admin.token,'POST',{type:'user',user_id:String(id),data:{access:'active',roles:['actor']}})).status,200,logs);}
    const actor=await call('/auth',null,'POST',{initData:signed(333)}),outsider=await call('/auth',null,'POST',{initData:signed(444)});
    assert.equal(admin.user.role,'admin');assert.equal(actor.user.role,'actor');
    assert.equal((await call('/projects',actor.token,'POST',{title:'No',code:'No'})).status,403);
    const project=await call('/projects',admin.token,'POST',{title:'Тестовий проєкт',code:'Test'});assert.equal(project.status,201);
    const ambiguous=await call('/resolve-link',admin.token,'POST',{link:'https://t.me/c/1234567890/105'});assert.equal(ambiguous.threadId,105);
    assert.equal((await call(`/projects/${project.id}/binding`,admin.token,'POST',{link:'https://t.me/c/1234567890/105'})).status,200);
    const binding=await call(`/projects/${project.id}/binding`,admin.token,'POST',{link:'https://t.me/c/1234567890/42/105'});assert.equal(binding.threadId,42);
    const task=await call('/tasks',admin.token,'POST',{project_id:project.id,episode:3,character:'Мамі',assignee:'333',deadline:new Date(Date.now()+86400000).toISOString()});assert.equal(task.status,201);
    assert.equal((await call('/tasks/'+task.id,outsider.token,'PATCH',{status:'working'})).status,403);
    assert.equal((await call('/tasks/'+task.id,actor.token,'PATCH',{status:'approved'})).status,403);
    assert.equal((await call('/tasks/'+task.id,actor.token,'PATCH',{status:'working'})).status,200);
    const wav=path.join(dir,'input.wav');await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=0.3','-c:a','pcm_s16le',wav]);
    const upload=await fetch(base+'/api/tasks/'+task.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+actor.token,'content-type':'application/octet-stream'},body:await readFile(wav)});assert.equal(upload.status,202,await upload.text());
    let snapshot;for(let i=0;i<60;i++){snapshot=await call('/state',admin.token);if(snapshot.takes.length||snapshot.jobs.some(j=>['failed','uncertain'].includes(j.status)))break;await delay(250);}
    assert.equal(snapshot.takes.length,1,JSON.stringify(snapshot.jobs)+'\n'+logs);assert.equal(snapshot.tasks[0].status,'review');assert.equal(docs.length,1);assert.equal(docs[0].message_thread_id,42);assert.equal(docs[0].chat_id,'-1001234567890');assert.match(docs[0].caption,/S01E03/);assert.equal(snapshot.takes[0].version,1);
    const existingTake=snapshot.takes[0];
    const dup=await fetch(base+'/api/tasks/'+task.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+actor.token,'x-file-name':'renamed.wav','x-replaces-take':existingTake.id},body:await readFile(wav)});assert.equal(dup.status,409);assert.match((await dup.json()).error,/дублюється/);assert.equal(docs.length,1);
    const converted=await fetch(base+'/api/tasks/'+task.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+actor.token,'x-file-name':'same.flac','x-replaces-take':existingTake.id},body:await readFile(path.join(cache,'file1'))});assert.equal(converted.status,202);const cj=await converted.json();
    for(let k=0;k<80;k++){snapshot=await call('/state',admin.token);if(snapshot.jobs.find(j=>j.id===cj.id)?.status==='failed')break;await delay(100);}
    assert.match(snapshot.jobs.find(j=>j.id===cj.id).error,/дублюється/);assert.equal(docs.length,1);assert.equal(snapshot.takes.length,1);
    assert.equal((await call('/tasks/'+task.id,admin.token,'PATCH',{status:'approved'})).status,200);
    const archive=await fetch(`${base}/api/projects/${project.id}/episodes/3/archive`,{headers:{authorization:'Bearer '+admin.token}});assert.equal(archive.status,200);const zip=path.join(dir,'out.zip');await writeFile(zip,Buffer.from(await archive.arrayBuffer()));const contents=await run('unzip',['-Z1',zip]);assert.match(contents,/Test_333_S01E03_Test_VO\.flac/);
    assert.equal((await fetch(`${base}/api/projects/${project.id}/episodes/3/archive`,{headers:{authorization:'Bearer '+actor.token}})).status,403);
    const materialIds=(await call('/state',admin.token)).takes.map(t=>t.id);const materialZip=await fetch(`${base}/api/materials/archive?file=${materialIds[0]}`,{headers:{authorization:'Bearer '+actor.token}});assert.equal(materialZip.status,200);await materialZip.arrayBuffer();assert.equal((await fetch(`${base}/api/materials/archive?file=missing`,{headers:{authorization:'Bearer '+actor.token}})).status,400);
    // Multi-role production workflow with explicit access approval and project assignment.
    const tokens={'333':actor.token,'444':outsider.token};
    for(const [id,roles] of [[555,['translator','editor']],[666,['casting']],[777,['reviewer']],[888,['engineer']],[999,['actor']]]){
      await call('/auth',null,'POST',{initData:signed(id)});
      assert.equal((await call('/workflow',admin.token,'POST',{type:'user',user_id:String(id),data:{access:'active',roles}})).status,200);
      tokens[id]=(await call('/auth',null,'POST',{initData:signed(id)})).token;
    }
    const members=[['555','translator'],['555','editor'],['666','casting'],['777','reviewer'],['888','engineer'],['333','actor'],['444','actor'],['999','actor']].map(([user_id,role])=>({user_id,role}));
    const wf=async(action,token=admin.token)=>{const result=await call('/workflow',token,'POST',action);assert.equal(result.status,200,JSON.stringify(result));return result;};
    await wf({type:'members',project_id:project.id,data:{members}});
    await wf({type:'rule',data:{scope:'project',scope_id:project.id,role:'translator',days:7}});
    await wf({type:'episode',project_id:project.id,data:{number:10}});
    const get=async stage=>(await call('/state',admin.token)).tasks.filter(t=>t.episode===10&&t.stage===stage);
    const tr=(await get('translation'))[0];
    const deniedAudio=await fetch(base+'/api/tasks/'+tr.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+tokens[555],'x-file-name':'not-subtitles.flac'},body:Buffer.from('audio')});assert.equal(deniedAudio.status,400);
assert.ok(Date.parse(tr.deadline)>Date.now()+6*86400000);
    assert.equal((await call('/workflow',actor.token,'POST',{type:'complete',task_id:tr.id,data:{output_url:'https://example.com/translation'}})).status,403);
    assert.equal((await call('/workflow',tokens[555],'POST',{type:'uploaded',task_id:tr.id})).status,400);
    await wf({type:'complete',task_id:tr.id,data:{output_url:'https://example.com/translation'}},tokens[555]);
    const ed=(await get('editing'))[0];assert.equal(ed.assignee,'555');
    await wf({type:'complete',task_id:ed.id,data:{output_url:'https://example.com/edited'}},tokens[555]);
    const casting=(await get('casting'))[0];
    await wf({type:'cast',project_id:project.id,data:{episode:10,cast:[{user_id:'333',character:'One',script_url:'https://example.com/one.ass'},{user_id:'444',character:'Two',script_url:'https://example.com/two.ass'}]}},tokens[666]);
    await wf({type:'complete',task_id:casting.id},tokens[666]);
    const recording=await get('recording');assert.equal(recording.length,2);
    let audioSequence=0;async function submit(t){await run('ffmpeg',['-v','error','-y','-f','lavfi','-i',`sine=frequency=${500+(++audioSequence)*50}:duration=0.3`,'-c:a','pcm_s16le',wav]);const r=await fetch(base+'/api/tasks/'+t.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+tokens[t.assignee],'x-file-name':'take.wav'},body:await readFile(wav)});assert.equal(r.status,202,await r.text());
      for(let i=0;i<80;i++){const snap=await call('/state',admin.token);if(snap.jobs.some(j=>j.task_id===t.id&&j.status==='done'))return;assert.ok(!snap.jobs.some(j=>j.task_id===t.id&&['failed','uncertain'].includes(j.status)),JSON.stringify(snap.jobs));await delay(100);}assert.fail('Upload timeout');}
    await submit(recording[0]);assert.equal((await get('mixing')).length,1);assert.equal((await get('review')).length,1);
    const review=(await get('review'))[0];assert.equal((await call('/workflow',tokens[777],'POST',{type:'complete',task_id:review.id,data:{corrections:[]}})).status,400);
    await submit(recording[1]);
    snapshot=await call('/state',admin.token);const reviewEntries=recording.map(t=>({user_id:t.assignee,status:'fix',take_ids:snapshot.takes.filter(v=>v.task_id===t.id).map(v=>v.id).sort()}));
    await wf({type:'review-notify',task_id:review.id,data:{entries:reviewEntries}},tokens[777]);
    await wf({type:'review-notify',task_id:review.id,data:{entries:reviewEntries}},tokens[777]);
    const selectedZip=await fetch(`${base}/api/projects/${project.id}/episodes/10/archive?mode=review&actor=333`,{headers:{authorization:'Bearer '+tokens[777]}});assert.equal(selectedZip.status,200);await writeFile(zip,Buffer.from(await selectedZip.arrayBuffer()));const selectedNames=await run('unzip',['-Z1',zip]);assert.match(selectedNames,/Test_333/);assert.ok(!selectedNames.includes('Test_444'));
    assert.equal((await fetch(`${base}/api/projects/${project.id}/episodes/10/archive?mode=review`,{headers:{authorization:'Bearer '+actor.token}})).status,403);
    const correction=await get('correction');assert.equal(correction.length,2);
    await submit(correction[0]);assert.equal((await call('/state',admin.token)).episodes.find(e=>e.number===10).ready_notified,0);
    await submit(correction[1]);snapshot=await call('/state',admin.token);assert.equal(snapshot.episodes.find(e=>e.number===10).ready_notified,1);
    assert.equal(snapshot.notifications.filter(n=>n.user_id==='888'&&n.key.startsWith('ready:')).length,1);
    const mix=(await get('mixing'))[0];await wf({type:'complete',task_id:mix.id,data:{}},tokens[888]);
    assert.equal((await call('/state',admin.token)).episodes.find(e=>e.number===10).stage,'done');
    await wf({type:'task-create',data:{project_id:project.id,episode:10,stage:'casting',assignee:'666',character:'Extra subs',note:'Distribute shared lines'}});
    snapshot=await call('/state',admin.token);const manualCast=snapshot.tasks.find(t=>t.character==='Extra subs');assert.equal(manualCast.independent,1);
    const subUpload=await fetch(base+'/api/tasks/'+manualCast.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+tokens[666],'x-file-name':'Short_Project_10.ass'},body:'[Script Info]\nTitle: test'});assert.equal(subUpload.status,202);const subJob=await subUpload.json();
    let subTake;for(let i=0;i<80;i++){snapshot=await call('/state',admin.token);subTake=snapshot.takes.find(t=>t.metadata.upload_job_id===subJob.id);if(subTake)break;await delay(100);}assert.ok(subTake,logs);assert.equal(subTake.metadata.original_name,'Short_Project_10.ass');
    const subDownload=await fetch(base+'/api/takes/'+subTake.id+'/download',{headers:{authorization:'Bearer '+actor.token}});assert.equal(subDownload.status,200);assert.match(await subDownload.text(),/Title: test/);
    assert.equal((await call('/download-link',actor.token,'POST',{route:'/state'})).status,400);
    const ticket=await call('/download-link',actor.token,'POST',{route:'/takes/'+subTake.id+'/download'});assert.equal(ticket.status,200);
    const handoff=await fetch(base+new URL(ticket.url).pathname);assert.equal(handoff.status,200);assert.match(await handoff.text(),/Title: test/);
    assert.equal((await fetch(base+new URL(ticket.url).pathname+'invalid')).status,401);
    const temporary=await call('/auth',null,'POST',{initData:signed(333)});
    const revoked=await call('/download-link',temporary.token,'POST',{route:'/takes/'+subTake.id+'/download'});
    await call('/logout',temporary.token,'POST');assert.equal((await fetch(base+new URL(revoked.url).pathname)).status,401);
    const linked=await call('/tasks/'+manualCast.id+'/telegram-files',tokens[666],'POST',{links:[`https://t.me/c/1234567890/42/${subTake.message_id}`]});assert.equal(linked.status,200,JSON.stringify(linked));assert.equal(linked.files[0].name,'Short_Project_10.ass');assert.equal(linked.files[0].take_id,subTake.id);
    assert.equal((await call('/tasks/'+manualCast.id+'/telegram-files',actor.token,'POST',{links:[`https://t.me/c/1234567890/42/${subTake.message_id}`]})).status,403);
    assert.equal((await call('/tasks/'+manualCast.id+'/telegram-files',tokens[666],'POST',{links:['https://t.me/c/1234567890/42/999999']})).status,400);
    const batchAction={type:'cast-batch',task_id:manualCast.id,data:{batch_id:'api-shared',files:[{take_id:subTake.id,users:['333','444']}]}};await wf(batchAction,tokens[666]);await wf(batchAction,tokens[666]);
    snapshot=await call('/state',admin.token);assert.equal(snapshot.tasks.filter(t=>t.script_take_ids?.includes(subTake.id)).length,2);assert.equal(snapshot.episodes.find(e=>e.number===10).stage,'done');
    await wf({type:'profile',data:{name:'НовийНік'}},actor.token);
    await call('/auth',null,'POST',{initData:signed(333)});
    assert.equal((await call('/state',actor.token)).users.find(u=>u.id==='333').name,'НовийНік');
    assert.equal((await call('/profile/avatar',actor.token,'POST',{})).status,200);
    await wf({type:'request-fix',task_id:recording[0].id,data:{note:'Ще одна правка'}},tokens[888]);
    snapshot=await call('/state',admin.token);const fix2=snapshot.tasks.find(t=>t.root_task_id===recording[0].id&&t.fix_iteration===2);assert.ok(fix2);
    await submit(fix2);
    const original=snapshot.takes.find(t=>t.task_id===recording[0].id);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=1100:duration=0.3','-c:a','pcm_s16le',wav]);
    const replacement=await fetch(base+'/api/tasks/'+recording[0].id+'/upload',{method:'POST',headers:{authorization:'Bearer '+tokens[recording[0].assignee],'x-file-name':'replacement.wav','x-replaces-take':original.id},body:await readFile(wav)});
    assert.equal(replacement.status,202);const replacementJob=await replacement.json();
    for(let i=0;i<80;i++){snapshot=await call('/state',admin.token);if(snapshot.jobs.find(j=>j.id===replacementJob.id)?.status==='done')break;await delay(100);}
    assert.ok(snapshot.takes.some(t=>t.metadata.replaces===original.id));
    const revisedArchive=await fetch(`${base}/api/projects/${project.id}/episodes/10/archive`,{headers:{authorization:'Bearer '+admin.token}});
    await writeFile(zip,Buffer.from(await revisedArchive.arrayBuffer()));const revisedContents=await run('unzip',['-Z1',zip]);
    assert.match(revisedContents,/Перші записи\//);assert.match(revisedContents,/Фікси\//);assert.match(revisedContents,/_FIX2\.flac/);assert.ok(!revisedContents.includes(original.filename));
    // End-to-end confirmed batch: stage silently, create distinct actor tasks, then publish an album.
    await wf({type:'task-create',data:{project_id:project.id,episode:11,stage:'casting',assignee:'666',character:'Batch regression'}});
    snapshot=await call('/state',admin.token);const cast19=snapshot.tasks.find(t=>t.character==='Batch regression'),beforeDocs=docs.length;
    const staged=[];
    for(const [i,nick] of ['ActorA','ActorB','Shared'].entries()){
      const r=await fetch(base+'/api/tasks/'+cast19.id+'/upload',{method:'POST',headers:{authorization:'Bearer '+tokens[666],'x-file-name':nick+'.srt','x-stage-casting':'1'},body:'1\n00:00:01,000 --> 00:00:02,000\nHi '+i+'\n'});assert.equal(r.status,202);const j=await r.json();
      for(let k=0;k<80;k++){snapshot=await call('/state',admin.token);const take=snapshot.takes.find(v=>v.metadata.upload_job_id===j.id);if(take){staged.push(take);break;}await delay(100);}
    }
    assert.equal(staged.length,3);assert.equal(docs.length,beforeDocs);assert.ok(staged.every(t=>t.message_id===0));
    const batch19={type:'cast-batch',task_id:cast19.id,data:{batch_id:'staged19',files:[{take_id:staged[0].id,users:['333']},{take_id:staged[1].id,users:['444']},{take_id:staged[2].id,users:['333','999']}]}};
    await wf(batch19,tokens[666]);await wf(batch19,tokens[666]);
    for(let k=0;k<100;k++){snapshot=await call('/state',admin.token);if(snapshot.jobs.filter(j=>j.task_id===cast19.id).every(j=>j.status==='done'))break;await delay(100);}
    assert.ok(snapshot.jobs.filter(j=>j.task_id===cast19.id).every(j=>j.status==='done'),JSON.stringify(snapshot.jobs)+'\n'+logs);
    const assignments=snapshot.tasks.filter(t=>t.source_cast_task_id===cast19.id);assert.equal(assignments.length,3);assert.ok(assignments.every(t=>t.status==='todo'));
    for(const t of assignments)assert.ok(snapshot.notifications.some(n=>n.user_id===t.assignee&&n.key==='task:'+t.id));
    assert.equal(albums.length,1);assert.equal(albums[0].media.length,3);assert.equal(albums[0].message_thread_id,42);
    assert.ok(messages.some(m=>m.chat_id==='-1001234567890'&&m.text.includes(' — 2')));
    const published=snapshot.takes.filter(t=>staged.some(x=>x.id===t.id));assert.equal(new Set(published.map(t=>t.filename)).size,3);assert.ok(published.every(t=>t.message_id>0&&!t.metadata.staged_path));
    const remove={type:'take-delete',task_id:cast19.id,data:{take_id:published[0].id,delete_telegram:true}};
    const countDeleted=deletions.length;assert.equal((await call('/workflow',actor.token,'POST',remove)).status,403);assert.equal(deletions.length,countDeleted);
    rejectDelete=true;assert.equal((await call('/workflow',tokens[666],'POST',remove)).status,502);assert.ok((await call('/state',admin.token)).takes.some(t=>t.id===published[0].id));
    rejectDelete=false;await wf(remove,tokens[666]);assert.ok(!(await call('/state',admin.token)).takes.some(t=>t.id===published[0].id));
    const afterDelete=deletions.length;await wf({type:'take-delete',task_id:cast19.id,data:{take_id:published[1].id}},tokens[666]);assert.equal(deletions.length,afterDelete);
    // v22: optional materials survive persistence, and known Telegram files import without resending.
    await wf({type:'episode-add',project_id:project.id,data:{number:22}});
    await wf({type:'material-assign',project_id:project.id,data:{number:22,kind:'original',assignee:'333'}});
    snapshot=await call('/state',admin.token);const material=snapshot.tasks.find(t=>t.material_kind==='original');assert.ok(material);assert.equal(snapshot.upload_limit,2000000000);
    assert.equal((await call('/workflow',outsider.token,'POST',{type:'material-link',task_id:material.id,data:{name:'Original',url:'https://fex.net/example'}})).status,403);
    await wf({type:'material-link',task_id:material.id,data:{name:'Original',url:'https://fex.net/example'}},actor.token);
    snapshot=await call('/state',admin.token);assert.equal(snapshot.episodeMaterials[0].url,'https://fex.net/example');assert.equal(snapshot.tasks.find(t=>t.id===material.id).status,'material');assert.equal(snapshot.episodes.find(e=>e.number===22).stage,'planned');
    assert.equal((await call('/import-documents',actor.token)).status,403);const catalog=await call('/import-documents',admin.token);assert.ok(catalog.files.some(f=>f.message_id===existingTake.message_id));
    const priorDocs=docs.length,historyLink=`https://t.me/c/1234567890/42/${existingTake.message_id}`;
    const migration={type:'progress-import',project_id:project.id,data:{import_id:'guided-api',guided:true,current:'review',number:22,rows:[{stage:'recording',assignee:'333',status:'review',links:[historyLink]},{stage:'review',assignee:'777',status:'todo',links:[]},{stage:'mixing',assignee:'888',status:'planned',links:[]}]}};
    await wf(migration);await wf(migration);snapshot=await call('/state',admin.token);const historical=snapshot.tasks.find(t=>t.import_id==='guided-api'&&t.stage==='recording'),historyTake=snapshot.takes.filter(t=>t.task_id===historical.id);assert.equal(historyTake.length,1);assert.equal(historyTake[0].file_id,existingTake.file_id);assert.equal(docs.length,priorDocs);assert.ok(snapshot.episodeMaterials.some(m=>m.task_id===material.id));
    const downloaded=await fetch(`${base}/api/takes/${historyTake[0].id}/download`,{headers:{authorization:'Bearer '+tokens[777]}});assert.equal(downloaded.status,200);assert.ok((await downloaded.arrayBuffer()).byteLength>0);
    assert.equal((await call('/workflow',actor.token,'POST',{type:'credit-save',data:{user_id:'333',project_id:project.id,character:'Hero'}})).status,403);
    assert.equal((await wf({type:'credit-save',data:{user_id:'333',project_id:project.id,character:'Hero'}})).status,200);
    const credits=(await call('/state',admin.token)).voiceCredits;assert.ok(credits.some(c=>c.user_id==='333'&&c.character==='Hero'));
    await wf({type:'quiet-hours',data:{enabled:false,ranges:[]}});assert.deepEqual((await call('/state',admin.token)).voiceCredits,credits);
    // Blocking also revokes already issued sessions; role bootstrap must not grant access again.
    await wf({type:'user',user_id:'333',data:{access:'blocked'}});assert.equal((await call('/state',actor.token)).status,403);
    await wf({type:'user',user_id:'333',data:{access:'active'}});
    removed.add(333);assert.equal((await call('/state',actor.token)).status,403);
  }finally{proc.kill('SIGTERM');await new Promise(r=>proc.once('close',r));mock.closeAllConnections();await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});

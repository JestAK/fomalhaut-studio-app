import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseTelegramLink} from '../dist/telegram-link.js';
import {validateInitData} from '../server/auth.mjs';
import {normalizeAudio,run} from '../server/audio.mjs';
export function signedInit(id,token='test-token',now=Math.floor(Date.now()/1000)) {
  const p=new URLSearchParams({auth_date:String(now),user:JSON.stringify({id,first_name:'Tester',username:'tester'+id})});
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  p.set('hash',createHmac('sha256',secret).update([...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();
}
test('private links, public links and tg:// preserve chat, message, thread separately',()=>{
  for(const link of ['https://t.me/c/1234567890/42/105','t.me/c/1234567890/105?thread=42','tg://privatepost?channel=1234567890&post=105&thread=42']){
    const p=parseTelegramLink(link);assert.equal(p.chatId,'-1001234567890');assert.equal(p.threadId,42);assert.equal(p.messageId,105);assert.equal(p.needsThread,false);
  }
  for(const link of ['https://t.me/my_team/42/105','tg://resolve?domain=my_team&post=105&thread=42'])assert.equal(parseTelegramLink(link).chatId,'@my_team');
});
test('ambiguous link never substitutes message id for thread id',()=>{
  const p=parseTelegramLink('https://t.me/c/1234567890/105');assert.equal(p.threadId,null);assert.equal(p.needsThread,true);assert.equal(p.messageId,105);
});
test('reject hostile, invitation, comment and contradictory links',()=>{
  for(const link of ['https://t.me.evil.com/c/123/4/5','https://t.me@evil.com/c/123/4/5','https://t.me/+invitation','https://t.me/team_name/42?comment=5','https://t.me/c/123/4/5?thread=6','https://t.me/c/0/4/5','https://t.me/c/123/NaN/5','https://t.me/c/123/4/5/6'])assert.throws(()=>parseTelegramLink(link));
});
test('initData signature, expiry, future and duplicate checks',()=>{
  const raw=signedInit(123,'token',10000);assert.equal(validateInitData(raw,'token',10001).id,123);
  assert.throws(()=>validateInitData(raw,'wrong-token',10001));
  assert.throws(()=>validateInitData(raw.replace('Tester','Attacker'),'token',10001));
  assert.throws(()=>validateInitData(raw,'token',14001));
  assert.throws(()=>validateInitData(raw,'token',9000));
  assert.throws(()=>validateInitData(raw+'&auth_date=10000','token',10001));
});
test('real FFmpeg conversion preserves duration and preserves sample rate, bit depth and downmixes to mono; corrupt input fails',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fomalhaut-audio-'));
  try{
    const input=path.join(dir,'input.wav'),output=path.join(dir,'output.flac');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=0.6','-ac','2','-c:a','pcm_s16le',input]);
    const metadata=await normalizeAudio(input,output);assert.equal(metadata.sampleRate,44100);assert.equal(metadata.channels,1);assert.equal(metadata.bits,16);assert.ok(Math.abs(metadata.duration-.6)<.01);assert.equal(metadata.source.channels,2);
    await writeFile(input,'not an audio file');await assert.rejects(normalizeAudio(input,output));
  }finally{await rm(dir,{recursive:true,force:true});}
});

import {copyFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
export function run(command,args,{cwd,timeout=600000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe']}); let out='',err='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.stdout.on('data',d=>{out+=d; if(out.length>2e6) child.kill('SIGKILL');});
    child.stderr.on('data',d=>{err=(err+d).slice(-16000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer); code===0?resolve(out):reject(new Error(`${command}: ${err.slice(-600) || 'обробку перервано'}`));});
  });
}
export async function normalizeAudio(input, output) {
  const inputSafety=['-protocol_whitelist','file,pipe','-format_whitelist','flac,wav,mp3,mov,ogg,aac,aiff,matroska,webm'];
  const probe=JSON.parse(await run('ffprobe',['-v','error',...inputSafety,'-show_streams','-show_format','-of','json',input],{timeout:30000}));
  const audio=probe.streams.filter(s=>s.codec_type==='audio');
  const duration=Number(probe.format.duration);
  if(audio.length!==1 || probe.streams.some(s=>s.codec_type==='video' && !s.disposition?.attached_pic)) throw new Error('Очікується один аудіопотік без відео.');
  if(!Number.isFinite(duration) || duration<=0 || duration>10800) throw new Error('Тривалість має бути від 0 до 3 годин.');
  if(audio[0].channels<1 || audio[0].channels>2) throw new Error('Підтримується mono або stereo.');
  if(!['flac','wav'].includes(probe.format.format_name))throw new Error('Приймаються WAV та FLAC.');
  const codec=audio[0].codec_name;
  if(codec.startsWith('pcm_f'))throw new Error('WAV 32/64-bit float потребує експорту у PCM 24-bit або FLAC у вашій DAW. Автоматично розрядність не змінюємо.');
  const bits=Number(audio[0].bits_per_raw_sample||audio[0].bits_per_sample||0);
  if(![8,16,24,32].includes(bits))throw new Error('Непідтримувана розрядність. Експортуйте PCM 16/24-bit або FLAC.');
  if(![16,24].includes(bits))throw new Error('Цей сервер підтримує збереження бітності 16/24-bit. Файл не змінено.');
  if(codec!=='flac'&&!codec.startsWith('pcm_s'))throw new Error('Непідтримуваний тип WAV.');
  await run('ffmpeg',['-nostdin','-v','error','-xerror','-y',...inputSafety,'-i',input,'-map','0:a:0','-map_metadata','-1',...(audio[0].channels===2?['-af','pan=mono|c0=0.5*c0+0.5*c1']:[]),'-ac','1','-c:a','flac','-compression_level','5','-sample_fmt',bits===24?'s32':'s16','-bits_per_raw_sample',String(bits),output]);
  const result=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output]));
  const s=result.streams[0];
  if(s.codec_name!=='flac' || s.sample_rate!==audio[0].sample_rate || s.channels!==1 || Number(s.bits_per_raw_sample)!==bits) throw new Error('Вихідний файл не відповідає стандарту.');
  return {duration:Number(result.format.duration),sampleRate:Number(s.sample_rate),bits:Number(s.bits_per_raw_sample),channels:s.channels,source:{codec:audio[0].codec_name,sampleRate:Number(audio[0].sample_rate),bits:Number(audio[0].bits_per_raw_sample || audio[0].bits_per_sample || 0),channels:audio[0].channels}};
}

export const MAX_UPLOAD_BYTES=2000*1000*1000;
const cache=new WeakMap();
// Fixed-size chunks keep memory bounded for 2000 MB WAV files.
export async function fileDigest(file){
 if(cache.has(file))return cache.get(file);
 const pending=(async()=>{const chunks=[];for(let start=0;start<file.size;start+=4*1024**2){const bytes=await file.slice(start,start+4*1024**2).arrayBuffer();chunks.push(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}const combined=new Uint8Array(chunks.length*32);chunks.forEach((h,i)=>combined.set(h,i*32));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',combined)),b=>b.toString(16).padStart(2,'0')).join('');})();cache.set(file,pending);try{return await pending;}catch(e){cache.delete(file);throw e;}
}
export async function assertDistinctFiles(files){
 const groups=new Map();for(const f of files){if(!groups.has(f.size))groups.set(f.size,[]);groups.get(f.size).push(f);}
 const duplicates=[];for(const group of groups.values()){if(group.length<2)continue;const seen=new Map();for(const file of group){const hash=await fileDigest(file);if(seen.has(hash))duplicates.push(`${seen.get(hash)} ↔ ${file.name}`);else seen.set(hash,file.name);}}
 if(duplicates.length)throw new Error('Файли дублюються за вмістом. Приберіть дублікати: '+duplicates.join('; '));
}

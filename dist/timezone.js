export function validZone(zone){try{new Intl.DateTimeFormat('uk',{timeZone:zone}).format();return !!zone;}catch{return false;}}
export function userZone(s,id){const z=s.profiles?.find(p=>p.user_id===id)?.timezone;return validZone(z)?z:'Europe/Kyiv';}
export function zonedDate(value,zone='Europe/Kyiv'){if(!value)return 'Без дедлайну';return new Date(value).toLocaleString('uk-UA',{timeZone:zone,dateStyle:'short',timeStyle:'short'})+' ('+zone+')';}
export function dateInput(value,zone){if(!value)return '';const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
export function fromInput(value,zone){const target=Date.parse(value+'Z');let t=target;for(let i=0;i<4;i++)t+=target-Date.parse(dateInput(t,zone)+'Z');if(!Number.isFinite(t)||dateInput(t,zone)!==value)throw new Error('Цей час не існує через перехід на літній час. Оберіть інший.');return new Date(t).toISOString();}
export function noticeDates(message,zone){return String(message).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,v=>zonedDate(v,zone));}
// Daily intervals are evaluated in the recipient's timezone, including across midnight.
export function quietMode(s,id,now=Date.now()){
 const pref=s.profiles?.find(p=>p.user_id===id)?.quiet_hours;
 if(!pref?.enabled)return null;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:userZone(s,id),hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
 const minute=Number(parts.hour)*60+Number(parts.minute),minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
 let mode=null;
 for(const r of pref.ranges||[]){const start=minutes(r.start),end=minutes(r.end);if(start<end?minute>=start&&minute<end:minute>=start||minute<end){if(r.mode==='pause')return 'pause';mode='silent';}}
 return mode;
}

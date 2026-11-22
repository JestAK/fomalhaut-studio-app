import path from 'node:path';
import {fileLabels} from './file-labels.mjs';
export function subtitleLines(text,filename){
 const ext=path.extname(filename).toLowerCase(),s=text.replace(/^\uFEFF/,'').replace(/\r/g,'');
 if(['.ass','.ssa'].includes(ext))return s.split('\n').filter(x=>/^Dialogue\s*:/i.test(x)).length;
 if(['.srt','.vtt'].includes(ext))return s.split('\n').filter(x=>/^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}/.test(x)).length;
 return null;
}
export function castingLabels(project,task,users,extension,index=0){
 const label=fileLabels(project,task,{name:users.map(u=>u.name).join('_')},extension);
 if(index)label.filename=label.filename.slice(0,-extension.length)+'_'+(index+1)+extension;
 return label;
}
export function castingSummary(project,task,files,users){
 const episode=`S${String(project.season||1).padStart(2,'0')}E${String(task.episode).padStart(2,'0')}`;
 const tag=project.title.replace(/[^\p{L}\p{N}_]/gu,'_');
 const lines=users.map(u=>{const assigned=files.filter(f=>f.users.includes(u.id));const total=assigned.every(f=>f.lines!==null)?assigned.reduce((n,f)=>n+f.lines,0):null;return `${u.name.replace(/[@\r\n]/g,'')} — ${total===null?'кількість реплік не визначена':total}`;});
 const head=`${project.title} ${episode}\n#${tag}_СофтСаби\n\n`,tail=`\n\n#${tag}_${episode}`;
 const chunks=[];let body=head;for(const line of lines){if(body.length+line.length+tail.length>3900){chunks.push(body+tail);body=head;}body+=line+'\n';}chunks.push(body.trimEnd()+tail);return chunks;
}

const types={translation:'Translate',editing:'Edit',casting:'Roles',recording:'VO',correction:'VO',mixing:'Mix',review:'Review',other:'Other'};
const clean=s=>String(s).normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'_').replace(/^_+|_+$/g,'').slice(0,65)||'File';
export function fileLabels(project,task,actor,extension){
 const episode=`S${String(project.season||1).padStart(2,'0')}E${String(task.episode).padStart(2,'0')}`;
 const fix=task.stage==='correction'?'_FIX'+(task.fix_iteration>1?task.fix_iteration:''):'';
 return {filename:`${clean(actor.name)}_${episode}_${clean(project.code)}_${types[task.stage]||'Other'}${fix}${extension.toLowerCase()}`,caption:`${actor.name} ${project.title} ${episode}\n#${clean(project.title)}_${episode}`};
}

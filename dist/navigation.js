const pages=new Set(['overview','projects','project','tasks','files','team','settings','deadlines','analytics']);
const filters=new Set(['all','mine','overdue','todo','working','review','approved','revision','local']);
export function decodeRoute(hash='') {
  let route=String(hash).replace(/^#\/?/,'');
  const [pathname,query='']=route.split('?');
  const parts=pathname.split('/');
  const page=pages.has(parts[0])?parts[0]:'overview';
  const params=new URLSearchParams(query);
  let projectId=null;
  try{projectId=parts[1]?decodeURIComponent(parts[1]):null;}catch{}
  const tab=['tasks','episodes','files'].includes(params.get('tab'))?params.get('tab'):'tasks';
  return {page:page==='project'&&!projectId?'projects':page,projectId,tab,filter:filters.has(params.get('filter'))?params.get('filter'):'all',q:params.get('q')||''};
}
export function encodeRoute(route) {
  const page=pages.has(route.page)?route.page:'overview';
  const params=new URLSearchParams();
  if(page==='project'&&route.tab&&route.tab!=='tasks')params.set('tab',route.tab);
  if(page==='tasks'&&route.filter&&route.filter!=='all')params.set('filter',route.filter);
  if(route.q)params.set('q',route.q);
  const pathname=page==='project'?`project/${encodeURIComponent(route.projectId||'')}`:page;
  return '#/'+pathname+(params.size?'?'+params:'');
}
export function searchStudio(state,query) {
  const words=query.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
  const matches=(...values)=>words.every(w=>values.join(' ').toLocaleLowerCase('uk-UA').includes(w));
  const projects=new Map(state.projects.map(p=>[p.id,p]));
  const users=new Map(state.users.map(u=>[u.id,u]));
  const visible=state.tasks.filter(t=>t.status!=='planned');
  const taskMap=new Map(visible.map(t=>[t.id,t]));
  const taskMatches=t=>matches(t.character,projects.get(t.project_id)?.title,users.get(t.assignee)?.name,t.episode);
  return {
    projects:state.projects.filter(p=>matches(p.title,p.code)),
    tasks:visible.filter(t=>!t.material_kind&&taskMatches(t)),
    takes:state.takes.filter(t=>{const task=taskMap.get(t.task_id);return task&&matches(t.filename,task.character,projects.get(task.project_id)?.title,users.get(task.assignee)?.name);}),
    users:state.users.filter(u=>matches(u.name,u.username))
  };
}

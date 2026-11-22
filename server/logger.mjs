// Deliberate allowlist: never log bodies, headers, URLs, filenames or error messages.
// Error messages from external tools may contain credentials and personal data.
const levels={info:20,warn:30,error:40};
const fields=['request_id','job_id','task_id','notification_id','method','status','duration_ms','phase','port','attempt'];
export function logRecord(level,event,meta={},error){
  const row={time:new Date().toISOString(),level,event};
  for(const key of fields)if(['string','number','boolean'].includes(typeof meta[key]))row[key]=typeof meta[key]==='string'?meta[key].slice(0,100):meta[key];
  if(error){
    row.error_type=/^[A-Za-z]+Error$/.test(error.name||'')?error.name:'Error';
    if(/^[A-Z][A-Z0-9_]{1,40}$/.test(error.code||''))row.error_code=error.code;
    // Extract only local code locations, never the message or function arguments.
    row.locations=[...String(error.stack||'').matchAll(/(?:server|dist)\/[a-zA-Z0-9_.-]+\.(?:mjs|js):\d+:\d+/g)].map(x=>x[0]).slice(0,8);
  }
  return row;
}
export function log(level,event,meta={},error){
  if((levels[level]||20)<(levels[process.env.LOG_LEVEL]||20))return;
  const line=JSON.stringify(logRecord(level,event,meta,error))+'\n';
  (level==='error'?process.stderr:process.stdout).write(line);
}
// Observe fatal failures without overriding Node's fail-fast/restart behavior.
process.on('uncaughtExceptionMonitor',(error)=>log('error','process.fatal',{},error));

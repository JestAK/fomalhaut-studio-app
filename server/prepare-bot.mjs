// Run manually once, BEFORE starting Studio, if migrating from the cloud Bot API.
// Token is read from the environment, never from command arguments.
const token=process.env.BOT_TOKEN;
if(!token)throw new Error('BOT_TOKEN missing');
for(const method of ['deleteWebhook','logOut']) {
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(method==='deleteWebhook'?{drop_pending_updates:false}:{}),signal:AbortSignal.timeout(30000)});
  const data=await r.json();console.log(method,data.ok?'OK':data.description);
  if(!data.ok)process.exitCode=1;
}

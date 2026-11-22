// Run only for a deliberate move to a different VPS, after draining Studio and taking a backup.
const base=(process.env.BOT_API_URL||'http://telegram-bot-api:8081').replace(/\/$/,'');
const token=process.env.BOT_TOKEN;if(!token)throw new Error('BOT_TOKEN відсутній.');
for(const method of ['deleteWebhook','logOut']){
  const r=await fetch(`${base}/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(method==='deleteWebhook'?{drop_pending_updates:false}:{}),signal:AbortSignal.timeout(30000)});
  const data=await r.json();if(!data.ok)throw new Error('Не вдалося виконати '+method+'. Перевірте Local Bot API.');
}
console.log('Бот вийшов зі старого API. Тепер зупиніть старі studio і telegram-bot-api та запустіть новий VPS.');

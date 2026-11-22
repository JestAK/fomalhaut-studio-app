"""Apply the notification hotfix without replacing earlier server fixes."""
from pathlib import Path
import re

root = Path.cwd()
paths = [root / 'dist/workflow.js', root / 'server/index.mjs']
w, s = [p.read_text() for p in paths]
if 'buildNoticeBatches' in s:
    raise SystemExit('Це виправлення вже встановлено.')
old = "`${actor.name}: ${names[action.type]||action.type}\\n${detail}\\n${JSON.stringify(b)}`"
assert old in w, 'Не знайдено очікуваний код сповіщень. Файли не змінено.'
w = w.replace(old, "`${actor.name}: ${names[action.type]||'Оновлено налаштування студії'}${detail?'\\n'+detail:''}${summary?'\\n'+summary:''}`")
marker = "    s.users.filter(u=>active(u)&&isAdmin(u)&&u.id!==actor.id).forEach"
assert marker in w
w = w.replace(marker, """    Object.assign(names,{'birthday':'Оновлено день народження та нагадування','reminders':'Оновлено нагадування про дедлайни','task-status':'Змінено статус завдання','task-delete':'Видалено завдання','episode-settings':'Змінено запуск етапів серії','project-episodes':'Змінено кількість серій'});
    const accessNames={active:'Доступ дозволено',pending:'Очікує схвалення',blocked:'Доступ заблоковано'};
    const statusNames={todo:'Очікується',working:'У роботі',review:'На перевірці',approved:'Завершено',revision:'Потрібні правки',planned:'Заплановано'};
    const parts=[];
    if(action.type==='user'){
      const target=findUser(action.user_id);
      parts.push('Ролі: '+roles(target).map(r=>ROLES[r]).join(', '),accessNames[target.access]);
    }else if(action.type==='birthday'){
      parts.push(b.month&&b.day?'День народження: '+String(b.day).padStart(2,'0')+'.'+String(b.month).padStart(2,'0'):'День народження не вказано');
      parts.push(b.enabled==='1'?'Нагадування за '+Number(b.ahead)+' дн.':'Нагадування вимкнено');
    }else if(action.type==='reminders'){
      parts.push(Number(b.interval)?'Повтор нагадувань: кожні '+Number(b.interval)+' год.':'Повторні нагадування вимкнено');
      parts.push(Number(b.ahead)?'Про найближчий дедлайн: за '+Number(b.ahead)+' дн.':'Попередні нагадування вимкнено');
    }else{
      if(b.title)parts.push('Назва: '+String(b.title).slice(0,150));
      if(b.code)parts.push('Код проєкту: '+String(b.code).slice(0,40));
      if(b.status&&statusNames[b.status])parts.push('Статус: '+statusNames[b.status]);
      if(b.days!==undefined)parts.push('Строк: '+Number(b.days)+' дн.');
    }
    const summary=parts.filter(Boolean).join('\\n');
""" + marker, 1)
old_endpoint = '`${u.name}: ${req.method} ${p} — зміни збережено.`'
assert old_endpoint in s
s = s.replace(old_endpoint, "`${u.name}: ${p==='/api/profile/avatar'?'Оновлено аватарку':p.includes('binding')?'Оновлено прив’язку Telegram':p==='/api/projects'?'Створено проєкт':'Збережено зміни в студії'}.`")
start = s.index('    const rows=q("SELECT n.* FROM notifications n JOIN users')
end = s.index('\n  }finally{delivering=false;}', start)
s = s[:start] + '''    const now=Date.now();
    const rows=q("SELECT n.* FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.status IN ('pending','failed') AND n.attempts<5 AND u.access='active' AND u.notify=1 ORDER BY n.created_at");
    for(const batch of buildNoticeBatches(rows,now).slice(0,10)){
      const n=batch[0];
      for(const item of batch)execute("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=?",item.id);
      try{
        await member(n.user_id);
        await tg('sendMessage',{chat_id:Number(n.user_id),text:noticeBatchText(batch),reply_markup:{inline_keyboard:[[{text:'Відкрити Studio',web_app:{url:APP_URL}}]]}});
        for(const item of batch)execute("UPDATE notifications SET status='sent',error=NULL WHERE id=?",item.id);
      }catch(e){
        log('warn','notification.failed',{notification_id:n.id,attempt:n.attempts+1},e);
        for(const item of batch)execute("UPDATE notifications SET status='failed',error=?,next_attempt=? WHERE id=?",e.message,Date.now()+60000*2**item.attempts,item.id);
      }
    }''' + s[end:]
s = "import {buildNoticeBatches,noticeBatchText} from './notice-batches.mjs';\n" + s
module = r'''// Queue rows remain in SQLite; restart does not discard the pending digest.
export function noticeBatchText(batch){
  if(!batch[0].key.startsWith('admin:'))return batch[0].message;
  return 'Зміни у студії\n\n'+[...new Set(batch.map(n=>n.message))].join('\n\n');
}
export function buildNoticeBatches(rows,now){
  const batches=[],groups=new Map();
  for(const n of rows){
    if(!n.key.startsWith('admin:')){if(n.next_attempt<=now)batches.push([n]);continue;}
    if(!groups.has(n.user_id))groups.set(n.user_id,[]);
    groups.get(n.user_id).push(n);
  }
  for(const group of groups.values()){
    const times=group.map(n=>Date.parse(n.created_at));
    if(now-Math.max(...times)<60000&&now-Math.min(...times)<300000)continue;
    let batch=[];
    for(const n of group.filter(n=>n.next_attempt<=now)){
      if(batch.length&&noticeBatchText([...batch,n]).length>3800){batches.push(batch);batch=[];}
      batch.push(n);
    }
    if(batch.length)batches.push(batch);
  }
  return batches;
}
'''
for p, content in zip(paths, [w, s]):
    backup = p.with_name(p.name + '.before-notice-batches')
    if not backup.exists():
        backup.write_bytes(p.read_bytes())
    p.write_text(content)
(root / 'server/notice-batches.mjs').write_text(module)
print('Сповіщення виправлено. Далі: sudo bash ops/update.sh')

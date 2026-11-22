import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,copyFile,access,rename} from 'node:fs/promises';
import path from 'node:path';
const data=path.resolve(process.env.DATA_DIR||'data'),file=path.join(data,'studio.sqlite');
const [command,target]=process.argv.slice(2);
await mkdir(data,{recursive:true});
if(command==='restore'){
  if(!target)throw new Error('Потрібен шлях до резервної копії.');
  const check=new DatabaseSync(target,{readOnly:true});
  if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Пошкоджена резервна копія.');
  for(const name of ['users','projects','tasks','takes'])check.prepare(`SELECT COUNT(*) FROM ${name}`).get();check.close();
  // Only a fresh/empty volume. Never overwrite a live database or leave stale WAL files.
  for(const p of [file,file+'-wal',file+'-shm']){try{await access(p);throw new Error('Цільова база вже існує. Відновлюйте в новий порожній volume.');}catch(e){if(e.code!=='ENOENT')throw e;}}
  await copyFile(target,file+'.restoring');await rename(file+'.restoring',file);console.log('Базу відновлено.');
}else{
  await access(file);const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');
  if(command==='backup'){
    if(!target||!target.startsWith('/data/backups/'))throw new Error('Резерв зберігається у /data/backups/.');await mkdir(path.dirname(target),{recursive:true});
    await backup(db,target);const check=new DatabaseSync(target,{readOnly:true});if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Резерв не пройшов перевірку.');check.close();console.log('Резервну копію перевірено.');
  }else if(command==='drain'||command==='resume'){
    db.prepare("INSERT INTO settings VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(command==='drain'?'1':'0');console.log(command==='drain'?'Нові зміни призупинено.':'Роботу відновлено.');
  }else if(command==='idle'){
    const n=db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('uploading','queued','processing','publishing')").get().n;db.close();process.exit(n?2:0);
  }else if(command==='check'){console.log(db.prepare('PRAGMA integrity_check').get().integrity_check);}
  else throw new Error('Команди: backup, restore, drain, resume, idle, check.');
  db.close();
}

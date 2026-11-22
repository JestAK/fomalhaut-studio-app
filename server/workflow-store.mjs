import {act,normalizeState,roles} from '../dist/workflow.js';
export function migrate(db){
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  if(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v>3)throw new Error('База новіша за цю програму. Використайте сумісний реліз або відновіть резервну копію.');
  if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()){migrateExtras(db);return;}
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(`ALTER TABLE users ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN access TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE takes ADD COLUMN actor_id TEXT;
      ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'recording';
      ALTER TABLE tasks ADD COLUMN output_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN completed_at TEXT;
      ALTER TABLE tasks ADD COLUMN deadline_manual INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE episodes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),number INTEGER NOT NULL,stage TEXT NOT NULL,review_done INTEGER NOT NULL DEFAULT 0,ready_notified INTEGER NOT NULL DEFAULT 0,UNIQUE(project_id,number));
      CREATE TABLE memberships(project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project_id,user_id,role));
      CREATE TABLE cast_entries(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),episode INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),character TEXT NOT NULL,script_url TEXT NOT NULL);
      CREATE TABLE deadline_rules(id TEXT PRIMARY KEY,scope TEXT NOT NULL,scope_id TEXT NOT NULL,role TEXT NOT NULL,days INTEGER NOT NULL,UNIQUE(scope,scope_id,role));
      CREATE TABLE notifications(id TEXT PRIMARY KEY,key TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,read_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(key,user_id));`);
    for(const u of db.prepare('SELECT id,role FROM users').all())db.prepare('UPDATE users SET roles=? WHERE id=?').run(JSON.stringify([u.role]),u.id);
    // Legacy episodes keep their records and explicit deadlines, without inventing finished translation stages.
    db.exec(`INSERT OR IGNORE INTO memberships SELECT DISTINCT project_id,assignee,'actor' FROM tasks;UPDATE tasks SET deadline_manual=1;UPDATE takes SET actor_id=(SELECT assignee FROM tasks WHERE tasks.id=takes.task_id);`);
    db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(new Date().toISOString());db.exec('COMMIT');migrateExtras(db);
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function migrateExtras(db){if(!db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='paid'))db.exec('ALTER TABLE projects ADD COLUMN paid INTEGER NOT NULL DEFAULT 0');db.exec("CREATE TABLE IF NOT EXISTS workflow_extras(key TEXT PRIMARY KEY,value TEXT NOT NULL)");db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(3,?)').run(new Date().toISOString());}
export function readWorkflow(db){
  const all=t=>db.prepare('SELECT * FROM '+t).all();
  const extra=JSON.parse(db.prepare("SELECT value FROM workflow_extras WHERE key='state'").get()?.value||'{}');
  return normalizeState({...extra,users:all('users').map(u=>({...u,roles:JSON.parse(u.roles)})),projects:all('projects').map(p=>({...p,...extra.projectData?.[p.id]})),tasks:all('tasks').map(t=>({...t,...extra.tasks?.[t.id]})),takes:all('takes'),episodes:all('episodes').map(e=>({...e,...extra.episodeData?.[e.id]})),memberships:all('memberships'),cast:all('cast_entries'),deadlineRules:all('deadline_rules'),notifications:all('notifications')});
}
function save(db,s){
  db.prepare("INSERT INTO workflow_extras VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({voiceCredits:s.voiceCredits,episodeMaterials:s.episodeMaterials,deletedTaskIds:s.deletedTaskIds,deletedEpisodeKeys:s.deletedEpisodeKeys,deletedTakeIds:s.deletedTakeIds,importIds:s.importIds,projectData:Object.fromEntries(s.projects.map(p=>[p.id,{episode_count:p.episode_count,season:p.season}])),episodeData:Object.fromEntries(s.episodes.map(e=>[e.id,{controlled:e.controlled,stageModes:e.stageModes,nextMode:e.nextMode,pendingStages:e.pendingStages,released:e.released,started:e.started}])),aliases:s.aliases,batches:s.batches,profiles:s.profiles,tasks:Object.fromEntries(s.tasks.map(t=>[t.id,{notion_snapshot_id:t.notion_snapshot_id,material_kind:t.material_kind,material_editors:t.material_editors,import_id:t.import_id,legacy_links:t.legacy_links||[],source_cast_task_id:t.source_cast_task_id,admin_closed:t.admin_closed,script_links:t.script_links||[],review_results:t.review_results||{},reviewed_take_ids:t.reviewed_take_ids||[],requested_take_id:t.requested_take_id||null,root_task_id:t.root_task_id||null,fix_iteration:t.fix_iteration||0,requested_by:t.requested_by||null,independent:t.independent||0,script_take_ids:t.script_take_ids||[]}]))}));
  for(const u of s.users.filter(u=>u.id.startsWith('guest:')))db.prepare("INSERT OR IGNORE INTO users(id,name,username,role,roles,access,notify) VALUES(?,?,?,?,?,?,0)").run(u.id,u.name,'','actor',JSON.stringify(u.roles),u.access);
  for(const u of s.users)db.prepare('UPDATE users SET role=?,roles=?,access=? WHERE id=?').run(roles(u).includes('admin')?'admin':roles(u)[0],JSON.stringify(roles(u)),u.access,u.id);
  db.prepare("INSERT OR IGNORE INTO projects(id,title,code) VALUES('general','Загальне','General')").run();
  for(const p of s.projects)db.prepare('UPDATE projects SET title=?,code=?,description=?,paid=? WHERE id=?').run(p.title,p.code,p.description,p.paid||0,p.id);
  const task=db.prepare(`INSERT INTO tasks(id,project_id,episode,character,assignee,deadline,status,note,stage,output_url,completed_at,deadline_manual) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET assignee=excluded.assignee,deadline=excluded.deadline,status=excluded.status,note=excluded.note,output_url=excluded.output_url,completed_at=excluded.completed_at,deadline_manual=excluded.deadline_manual`);
  s.tasks.forEach(t=>task.run(t.id,t.project_id,t.episode,t.character,t.assignee,t.deadline,t.status,t.note||'',t.stage,t.output_url||'',t.completed_at||null,t.deadline_manual||0));
  for(const old of db.prepare('SELECT id FROM episodes').all())if(!s.episodes.some(e=>e.id===old.id))db.prepare('DELETE FROM episodes WHERE id=?').run(old.id);
  const episode=db.prepare('INSERT INTO episodes VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,review_done=excluded.review_done,ready_notified=excluded.ready_notified');s.episodes.forEach(e=>episode.run(e.id,e.project_id,e.number,e.stage,e.review_done,e.ready_notified));
  db.exec('DELETE FROM memberships;DELETE FROM cast_entries;DELETE FROM deadline_rules;');
  const member=db.prepare('INSERT INTO memberships VALUES(?,?,?)');s.memberships.forEach(m=>member.run(m.project_id,m.user_id,m.role));
  const cast=db.prepare('INSERT INTO cast_entries VALUES(?,?,?,?,?,?)');s.cast.forEach(c=>cast.run(c.id,c.project_id,c.episode,c.user_id,c.character,c.script_url));
  const rule=db.prepare('INSERT INTO deadline_rules VALUES(?,?,?,?,?)');s.deadlineRules.forEach(r=>rule.run(r.id,r.scope,r.scope_id,r.role,r.days));
  const notice=db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET read_at=excluded.read_at');s.notifications.forEach(n=>notice.run(n.id,n.key,n.user_id,n.message,n.status,n.error,n.created_at,n.read_at,n.attempts,n.next_attempt));
}
export function command(db,action,user,withinTransaction=false){
  if(!withinTransaction)db.exec('BEGIN IMMEDIATE');
  try{const s=readWorkflow(db);act(s,action,s.users.find(u=>u.id===user.id));save(db,s);if(!withinTransaction)db.exec('COMMIT');return s;}
  catch(e){if(!withinTransaction)db.exec('ROLLBACK');throw e;}
}

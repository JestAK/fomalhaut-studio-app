import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
export async function hashFile(filename){const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');}
export function duplicateCandidates(state,task){
 const ids=new Set(state.tasks.filter(t=>t.id===task.id||(['recording','correction'].includes(task.stage)&&['recording','correction'].includes(t.stage)&&t.project_id===task.project_id&&t.episode===task.episode&&t.assignee===task.assignee)).map(t=>t.id));
 return state.takes.filter(t=>ids.has(t.task_id));
}
export const takeMetadata=take=>typeof take.metadata==='string'?JSON.parse(take.metadata):take.metadata||{};

// Queue rows remain in SQLite; restart does not discard the pending digest.
export function noticeBatchText(batch){
  if(!batch[0].key.startsWith('admin:'))return batch[0].message;
  return 'Зміни у студії\n\n'+[...new Set(batch.map(n=>n.message))].join('\n\n');
}
export function buildNoticeBatches(rows,now){
  const batches=[],groups=new Map();
  for(const n of rows){
    if(!groups.has(n.user_id))groups.set(n.user_id,[]);
    groups.get(n.user_id).push(n);
  }
  for(const group of groups.values()){
    const times=group.map(n=>Date.parse(n.created_at));
    const quiet=group.some(n=>!n.key.startsWith('admin:'))?3000:60000;
    if(now-Math.max(...times)<quiet&&now-Math.min(...times)<300000)continue;
    const batch=group.filter(n=>n.next_attempt<=now);
    if(batch.length)batches.push(batch);
  }
  return batches;
}

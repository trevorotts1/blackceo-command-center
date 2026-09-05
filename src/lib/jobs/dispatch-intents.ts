/** Recover task creation interrupted before enrichment/dispatch. Each intent is
 * durable; active/unknown attempts exclude re-sends, and worker capacity is
 * reserved by the common dispatcher. Small concurrent workers avoid head blocking. */
import { queryAll, run } from '@/lib/db';
import { autoDispatchTask } from '@/lib/task-dispatcher';
import { runLeasedJob, throwIfJobLeaseLost } from './job-lease';
export async function runDispatchIntentSweep(): Promise<{ scanned:number; acknowledged:number; held:number; unknown:number; failed:number }> {
 const counts={scanned:0,acknowledged:0,held:0,unknown:0,failed:0};
 throwIfJobLeaseLost();
 run(`UPDATE task_dispatch_intents SET state='cancelled',updated_at=? WHERE state='pending' AND task_id IN
   (SELECT id FROM tasks WHERE killed_at IS NOT NULL OR archived_at IS NOT NULL OR upper(COALESCE(description,'')) LIKE '%OWNER KILLED%')`,[new Date().toISOString()]);
 const rows=queryAll<{task_id:string}>(`SELECT i.task_id FROM task_dispatch_intents i JOIN tasks t ON t.id=i.task_id
   WHERE i.state='pending' AND t.assigned_agent_id IS NOT NULL
   AND t.status IN ('backlog','inbox','planning','pending_dispatch','assigned')
   AND (t.next_dispatch_eligible_at IS NULL OR datetime(t.next_dispatch_eligible_at)<=datetime('now'))
   AND NOT EXISTS(SELECT 1 FROM task_executions x WHERE x.task_id=t.id AND x.state IN ('reserved','sending','accepted','running','unknown'))
   ORDER BY i.updated_at ASC LIMIT 8`);
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
  while(cursor<rows.length){
   throwIfJobLeaseLost();
   const row=rows[cursor++];counts.scanned++;
   try {
    run('UPDATE task_dispatch_intents SET updated_at=? WHERE task_id=?',[new Date().toISOString(),row.task_id]);
    const result=await runLeasedJob(`dispatch-intent:${row.task_id}`,()=>autoDispatchTask(row.task_id,'dispatch-intents'),30_000);
    if(result.skipped || !result.result) counts.held++;
    else counts[result.result.status]++;
   } catch { counts.failed++; }
  }
 }));
 return counts;
}

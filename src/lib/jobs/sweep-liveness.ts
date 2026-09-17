/** Task-processing health is separate from process liveness: recent failures are unhealthy. */
import { queryOne, run, timeNow, sqlTime, parseDbTime } from '@/lib/db';
import { notifySystem } from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';
export const STALE_MULTIPLIER=3;
export const WATCHED_JOB_CADENCE_MINUTES:Record<string,number>={
 'intake-advance':2,'qc-review-sweep':2,'execution-reconcile':2,'stuck-in-progress-sweep':5,
};
const cooldown=Math.max(1,Number(process.env.SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES)||60);
const disabled=()=>['1','true'].includes(process.env.DISABLE_SWEEP_LIVENESS||'');
export interface WatchedJobLiveness {
 jobName:string;cadenceMinutes:number;lastRanAt:string|null;lastStatus:string|null;ageMinutes:number|null;staleThresholdMinutes:number;stale:boolean;disabled:boolean;
 failed:boolean;running:boolean;lastSuccessAt:string|null;consecutiveFailures:number;errorCode:string|null;resultCounts:Record<string,number>;
}
export function getWatchedJobLiveness():WatchedJobLiveness[] {
 return Object.entries(WATCHED_JOB_CADENCE_MINUTES).map(([jobName,cadenceMinutes])=>{
  const staleThresholdMinutes=cadenceMinutes*STALE_MULTIPLIER;
  let row: {last_ran_at:string;last_status:string;last_started_at:string|null;last_finished_at:string|null;last_success_at:string|null;consecutive_failures:number;error_code:string|null;result_counts:string|null}|undefined;
  try { row=queryOne('SELECT * FROM job_liveness WHERE job_name=?',[jobName]); } catch { /* missing schema is unobserved */ }
  const started=parseDbTime(row?.last_started_at), finished=parseDbTime(row?.last_finished_at);
  const running=!!row?.last_started_at && (!row.last_finished_at || started>finished);
  const age=(Date.now()-parseDbTime(row?.last_ran_at))/60000;
  const lastSuccessAt=row?.last_success_at || (row?.last_status==='ok' && !running ? row.last_ran_at : null);
  const successAge=(Date.now()-parseDbTime(lastSuccessAt))/60000;
  let counts:Record<string,number>={};try{counts=JSON.parse(row?.result_counts||'{}');}catch{/* malformed diagnostics */}
  return {jobName,cadenceMinutes,lastRanAt:row?.last_ran_at||null,lastStatus:row?.last_status||null,ageMinutes:Number.isFinite(age)?age:null,staleThresholdMinutes,
   stale:!row || !Number.isFinite(age) || age>staleThresholdMinutes || (running && (Date.now()-started)/60000>staleThresholdMinutes),
   disabled:row?.last_status==='disabled',failed:row?.last_status==='error' || (row?.consecutive_failures||0)>0 || (!!lastSuccessAt && successAge>staleThresholdMinutes),
   running,lastSuccessAt,consecutiveFailures:row?.consecutive_failures||0,errorCode:row?.error_code||null,resultCounts:counts};
 });
}
export interface SweepLivenessCheckResult {pass:boolean;detail:string;indeterminate?:boolean;watched:WatchedJobLiveness[];}
export function checkSweepLiveness():SweepLivenessCheckResult {
 if(disabled())return {pass:false,indeterminate:true,detail:'sweep_liveness: monitoring disabled on this box',watched:[]};
 const watched=getWatchedJobLiveness();
 // A job switched off on purpose (kill flag / *_ENABLED=0) records 'disabled' on every tick.
 // That is an operator decision, not a fault: it is reported in the OK detail but never alerts.
 // A disabled job that STOPS TICKING is still a fault (the scheduler itself may be dead) — stale wins.
 const unhealthy=watched.filter(w=>w.stale||(!w.disabled&&w.failed));
 return {pass:unhealthy.length===0,watched,detail:unhealthy.length?`sweep_liveness: ${unhealthy.map(w=>`${w.jobName} ${w.stale?'silent':'FAILED'} (${w.consecutiveFailures} consecutive failures; ${w.ageMinutes===null?'never observed':Math.round(w.ageMinutes)+'m since tick'})`).join('; ')}`:`sweep_liveness: OK — ${watched.map(w=>w.disabled?`${w.jobName} (disabled on this box)`:w.jobName).join(', ')}`};
}
export interface SweepLivenessSweepResult {ranAt:string;skippedReason?:string;staleJobs:string[];disabledJobs:string[];failedJobs?:string[];alerted:boolean;notificationStatus?:'queued'|'unavailable'|'cooldown';}
export async function runSweepLivenessSweep():Promise<SweepLivenessSweepResult> {
 const ranAt=timeNow();
 if(disabled())return {ranAt,skippedReason:'DISABLE_SWEEP_LIVENESS set',staleJobs:[],disabledJobs:[],failedJobs:[],alerted:false};
 const check=checkSweepLiveness(),watched=check.watched;
 const result:SweepLivenessSweepResult={ranAt,staleJobs:watched.filter(w=>w.stale).map(w=>w.jobName),disabledJobs:watched.filter(w=>w.disabled&&!w.stale).map(w=>w.jobName),failedJobs:watched.filter(w=>w.failed).map(w=>w.jobName),alerted:false};
 if(check.pass)return result;
 const recent=queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM events WHERE type IN ('sweep_liveness_alert','sweep_liveness_alert_unavailable') AND ${sqlTime('created_at')} >= datetime('now',?)`,[`-${cooldown} minutes`])?.n||0;
 if(recent)return {...result,notificationStatus:'cooldown'};
 const queued=notifySystem(`[SWEEP-LIVENESS] ${check.detail}`,{agent:'sweep-liveness',action:'escalate'});
 run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)',[uuidv4(),queued?'sweep_liveness_alert':'sweep_liveness_alert_unavailable',`${check.detail}; notification ${queued?'queued (delivery not confirmed)':'unavailable'}`,ranAt]);
 return {...result,alerted:queued,notificationStatus:queued?'queued':'unavailable'};
}

/**
 * ISSUE-04 - GATING scheduler liveness.
 *
 * Every sweep in this app is a node-cron job registered in-process by
 * `registerCronJobs` (src/lib/jobs/scheduler.ts), including the sweep-liveness
 * watchdog itself. When the scheduler loop dies, the watchdog dies with it and
 * its only side effect (a Telegram notify) never fires. `checkSweepLiveness()`
 * was surfaced on /api/health/deep as `advisory.sweep_liveness`, which nothing
 * gates on, so a box sat "healthy" for 41 hours with no card moving until a
 * human ran `pm2 restart`.
 *
 * `checkSchedulerLiveness()` is the GATING half of that signal. It exists
 * because the process that stalled cannot be the thing that repairs the stall:
 * the verdict has to reach an out-of-process consumer (cc-health-check.sh into
 * watchdog-cc.sh) that can restart it.
 *
 * WHAT IT GATES ON, AND WHAT IT DELIBERATELY DOES NOT:
 *   - `stale` ONLY. A watched job with no tick inside its own
 *     cadence x STALE_MULTIPLIER window is evidence the scheduler loop itself
 *     is not running. That is the defect class.
 *   - NOT `failed`, and NOT `disabled`. A job whose body throws still TICKS,
 *     and a job short-circuited by an operator kill flag still TICKS. Neither
 *     is a stalled scheduler, and gating on either would turn a box red for a
 *     deliberate operator setting or for one sweep's own bug. Both stay on the
 *     non-gating `advisory.sweep_liveness`, which reports all three states.
 *
 * WARM-UP WINDOW: for the first (max staleThresholdMinutes + 1) minutes of
 * process uptime, silence PASSES, with the silent jobs named in the detail.
 *
 * It does NOT report UNKNOWN, and that is a deliberate correction. UNKNOWN is
 * a real state in this system with real consequences: it flips the whole
 * /api/health/deep response to indeterminate, cc-health-check.sh exits 3, and
 * a run of exit 3 past the deadline is escalated by cc-health-check.sh itself
 * as a persistent-unknown RED. Measured on a real CI probe of a freshly
 * started server: every one of the four watched jobs reads "never observed" at
 * 0m uptime, the box reports indeterminate, and the health probe exits 3. So
 * spending UNKNOWN on a boot would yellow every box for 16 minutes after every
 * restart, report every deploy as unverified, and open a path to a RED that
 * describes nothing but the clock.
 *
 * Inside the window a silent job is not weak evidence of a stall. It is the
 * EXPECTED state of a process that has just started, so there is no adverse
 * signal to report. What it costs is real and bounded: a box whose scheduler
 * never starts at all reads green for the length of the window. Nothing can
 * close that gap, because no evidence of ticking can exist before the first
 * cadence elapses. The moment uptime passes the window, a still-silent job is
 * a definitive failure.
 *
 * MONITORING DISABLED: DISABLE_SWEEP_LIVENESS is an operator opt-out, so the
 * gating check PASSES and says so. Making it indeterminate would park the box
 * in permanent UNKNOWN, which cc-health-check.sh eventually escalates as a
 * persistent-unknown RED, a false red produced by a setting and not a fault.
 */
export interface SchedulerLivenessCheckResult {pass:boolean;detail:string;indeterminate?:boolean;}

/** Minutes of uptime before a silent watched job becomes a definitive failure. */
export function schedulerLivenessWarmupMinutes(watched:WatchedJobLiveness[]):number {
 return watched.reduce((acc,w)=>Math.max(acc,w.staleThresholdMinutes),0)+1;
}

/**
 * THE INSTRUMENT CONTROL. `getWatchedJobLiveness()` deliberately swallows a
 * read error ("missing schema is unobserved") and reports the job as never
 * observed, which is indistinguishable from a genuinely silent job. For an
 * ADVISORY that is fine. For a GATING check whose failure triggers a pm2
 * restart it is not: a locked DB, or a box whose migrations have not created
 * `job_liveness` yet, would be reported as a stalled scheduler and restarted
 * on a fault it does not have.
 *
 * So before calling silence a stall, prove the instrument works: one trivial
 * read against the same table through the same accessor. A throw here means
 * the CHECK is broken, not the scheduler, and the verdict is UNKNOWN.
 */
function jobLivenessTableReadable():{readable:boolean;reason:string|null} {
 try { queryOne('SELECT 1 AS ok FROM job_liveness LIMIT 1'); return {readable:true,reason:null}; }
 catch(err) { return {readable:false,reason:err instanceof Error?err.message:String(err)}; }
}

export function checkSchedulerLiveness(uptimeSeconds:number=process.uptime()):SchedulerLivenessCheckResult {
 if(disabled())return {pass:true,detail:'scheduler_liveness: monitoring disabled on this box (DISABLE_SWEEP_LIVENESS); not gated'};
 let watched:WatchedJobLiveness[];
 try { watched=getWatchedJobLiveness(); }
 catch(err) { return {pass:false,indeterminate:true,detail:`scheduler_liveness: liveness read threw (${err instanceof Error?err.message:String(err)}); UNKNOWN`}; }
 const silent=watched.filter(w=>w.stale);
 if(silent.length===0)return {pass:true,detail:`scheduler_liveness: OK, ${watched.length} watched job(s) ticking (${watched.map(w=>w.jobName).join(', ')})`};
 const probe=jobLivenessTableReadable();
 if(!probe.readable)
  return {pass:false,indeterminate:true,detail:`scheduler_liveness: job_liveness is unreadable (${probe.reason}), so silence is not evidence of a stall; UNKNOWN`};
 const names=silent.map(w=>`${w.jobName} (${w.ageMinutes===null?'never observed':Math.round(w.ageMinutes)+'m since last tick'}; threshold ${w.staleThresholdMinutes}m)`).join('; ');
 const warmup=schedulerLivenessWarmupMinutes(watched);
 const uptimeMinutes=uptimeSeconds/60;
 if(uptimeMinutes<warmup)
  return {pass:true,detail:`scheduler_liveness: ${silent.length} watched job(s) have not ticked yet, but process uptime is only ${Math.round(uptimeMinutes)}m of the ${warmup}m warm-up window, so this is a boot and not a stall: ${names}`};
 return {pass:false,detail:`scheduler_liveness: in-app scheduler appears STALLED, ${silent.length} watched job(s) silent past their thresholds after ${Math.round(uptimeMinutes)}m uptime: ${names}`};
}

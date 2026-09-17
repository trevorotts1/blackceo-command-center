/**
 * BOARD JOBS WATCHDOG — "are the background jobs that move the board still running?"
 *
 * Every two minutes this reads the `job_liveness` table (which scheduler.ts's
 * wrap() upserts a row into on every job invocation, success or failure) and
 * checks the four board-maintenance background jobs — intake-advance,
 * qc-review-sweep, execution-reconcile, stuck-in-progress-sweep — for three
 * states:
 *   SILENT   no tick inside its own cadence x STALE_MULTIPLIER window. The
 *            in-process scheduler loop may be gone, so cards stop moving.
 *   FAILING  ticking, but its body keeps throwing.
 *   OFF      ticking and short-circuiting on an operator kill flag. This is a
 *            DECISION, not a fault: it is named in the OK detail and never alerts.
 *
 * When something is wrong it sends ONE Telegram message per cooldown window
 * (default 60 minutes). Messages are written for a human who has just been
 * paged and does not know this codebase.
 *
 * Task-processing health is separate from process liveness: recent failures are unhealthy.
 */
import { queryOne, run, timeNow, sqlTime, parseDbTime } from '@/lib/db';
import { notifySystem } from '@/lib/notify';
import { v4 as uuidv4 } from 'uuid';
export const STALE_MULTIPLIER=3;
export const WATCHED_JOB_CADENCE_MINUTES:Record<string,number>={
 'intake-advance':2,'qc-review-sweep':2,'execution-reconcile':2,'stuck-in-progress-sweep':5,
};

/**
 * DEPRECATED ENV ALIASES. This watchdog used to be called "sweep-liveness", and
 * boxes already in the fleet carry the old variable names in their .env.local.
 * Renaming the code must not silently switch monitoring off on those boxes, so
 * both names are read and the NEW name wins. The old name still works and warns
 * once per process, naming itself so an operator can find and fix it.
 */
const DEPRECATED_ENV_ALIASES:Record<string,string>={
 DISABLE_BOARD_JOBS_WATCHDOG:'DISABLE_SWEEP_LIVENESS',
 BOARD_JOBS_WATCHDOG_ALERT_COOLDOWN_MINUTES:'SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES',
};
const warnedDeprecatedEnv=new Set<string>();
function readEnv(name:string):string|undefined {
 const current=process.env[name];
 if(current!==undefined&&current!=='')return current;
 const legacy=DEPRECATED_ENV_ALIASES[name];
 const legacyValue=legacy?process.env[legacy]:undefined;
 if(legacy&&legacyValue!==undefined&&legacyValue!==''&&!warnedDeprecatedEnv.has(legacy)) {
  warnedDeprecatedEnv.add(legacy);
  console.warn(`[board-jobs-watchdog] ${legacy} is deprecated and will stop being read in a future release — rename it to ${name}. It is still honoured for now.`);
 }
 return legacyValue;
}

/** Minutes of quiet after an alert before the same condition may page again.
 *  Read per call, exactly like disabled() below, so neither flag is frozen at
 *  module load and both behave the same way on a box that changes its env. */
const cooldownMinutes=()=>Math.max(1,Number(readEnv('BOARD_JOBS_WATCHDOG_ALERT_COOLDOWN_MINUTES'))||60);
const disabled=()=>['1','true'].includes(readEnv('DISABLE_BOARD_JOBS_WATCHDOG')||'');

/** Alert event types this watchdog writes, plus the pre-rename names. The cooldown
 *  query matches BOTH so rows already on a live box keep suppressing duplicates
 *  across the upgrade instead of letting one extra alert through. */
export const BOARD_JOBS_WATCHDOG_ALERT_EVENT='board_jobs_watchdog_alert';
export const BOARD_JOBS_WATCHDOG_ALERT_UNAVAILABLE_EVENT='board_jobs_watchdog_alert_unavailable';
const COOLDOWN_EVENT_TYPES=[BOARD_JOBS_WATCHDOG_ALERT_EVENT,BOARD_JOBS_WATCHDOG_ALERT_UNAVAILABLE_EVENT,'sweep_liveness_alert','sweep_liveness_alert_unavailable'];

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

/** "1 minute" / "2 minutes" — the messages are read by people, not parsers. */
function plural(count:number,noun:string):string { return `${count} ${noun}${count===1?'':'s'}`; }
/** "a", "a and b", "a, b and c". */
function naturalList(items:string[]):string {
 if(items.length<2)return items[0]||'';
 return `${items.slice(0,-1).join(', ')} and ${items[items.length-1]}`;
}
/** One problem, in plain English, for someone who has just been paged. */
function describeProblem(w:WatchedJobLiveness):string {
 if(w.ageMinutes===null)return `${w.jobName} has never run since the command center started.`;
 if(w.stale)return `${w.jobName} has not run for ${plural(Math.round(w.ageMinutes),'minute')} (it should run every ${plural(w.cadenceMinutes,'minute')}). The background loop that moves tasks may have stopped. Check the command center process.`;
 return `${w.jobName} has failed ${plural(w.consecutiveFailures,'run')} in a row (last error: ${w.errorCode||'unknown'}). Check the command center logs.`;
}

export interface BoardJobsWatchdogCheckResult {pass:boolean;detail:string;indeterminate?:boolean;watched:WatchedJobLiveness[];}
export function checkBoardJobsWatchdog():BoardJobsWatchdogCheckResult {
 if(disabled())return {pass:false,indeterminate:true,detail:'board_jobs_watchdog: board jobs watchdog is switched off on this box (DISABLE_BOARD_JOBS_WATCHDOG).',watched:[]};
 const watched=getWatchedJobLiveness();
 // A job switched off on purpose (kill flag / *_ENABLED=0) records 'disabled' on every tick.
 // That is an operator decision, not a fault: it is reported in the OK detail but never alerts.
 // A disabled job that STOPS TICKING is still a fault (the scheduler itself may be dead) — stale wins.
 const unhealthy=watched.filter(w=>w.stale||(!w.disabled&&w.failed));
 if(unhealthy.length)return {pass:false,watched,detail:`board_jobs_watchdog: ${unhealthy.map(describeProblem).join(' | ')}`};
 const off=watched.filter(w=>w.disabled).map(w=>w.jobName);
 return {pass:true,watched,detail:`board_jobs_watchdog: all ${watched.length} background jobs are running on schedule.${off.length?` ${naturalList(off)} ${off.length===1?'is':'are'} switched off on this box.`:''}`};
}
export interface BoardJobsWatchdogRunResult {ranAt:string;skippedReason?:string;staleJobs:string[];disabledJobs:string[];failedJobs?:string[];alerted:boolean;notificationStatus?:'queued'|'unavailable'|'cooldown';}
export async function runBoardJobsWatchdog():Promise<BoardJobsWatchdogRunResult> {
 const ranAt=timeNow();
 if(disabled())return {ranAt,skippedReason:'DISABLE_BOARD_JOBS_WATCHDOG set',staleJobs:[],disabledJobs:[],failedJobs:[],alerted:false};
 const check=checkBoardJobsWatchdog(),watched=check.watched;
 const result:BoardJobsWatchdogRunResult={ranAt,staleJobs:watched.filter(w=>w.stale).map(w=>w.jobName),disabledJobs:watched.filter(w=>w.disabled&&!w.stale).map(w=>w.jobName),failedJobs:watched.filter(w=>w.failed).map(w=>w.jobName),alerted:false};
 if(check.pass)return result;
 const recent=queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM events WHERE type IN (${COOLDOWN_EVENT_TYPES.map(()=>'?').join(',')}) AND ${sqlTime('created_at')} >= datetime('now',?)`,[...COOLDOWN_EVENT_TYPES,`-${cooldownMinutes()} minutes`])?.n||0;
 if(recent)return {...result,notificationStatus:'cooldown'};
 const queued=notifySystem(`[BOARD JOBS WATCHDOG] ${check.detail}`,{agent:'board-jobs-watchdog',action:'escalate'});
 run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)',[uuidv4(),queued?BOARD_JOBS_WATCHDOG_ALERT_EVENT:BOARD_JOBS_WATCHDOG_ALERT_UNAVAILABLE_EVENT,`${check.detail}; notification ${queued?'queued (delivery not confirmed)':'unavailable'}`,ranAt]);
 return {...result,alerted:queued,notificationStatus:queued?'queued':'unavailable'};
}

/**
 * ISSUE-04 - GATING scheduler liveness.
 *
 * Every sweep in this app is a node-cron job registered in-process by
 * `registerCronJobs` (src/lib/jobs/scheduler.ts), including the board jobs
 * watchdog itself. When the scheduler loop dies, the watchdog dies with it and
 * its only side effect (a Telegram notify) never fires.
 * `checkBoardJobsWatchdog()` was surfaced on /api/health/deep as
 * `advisory.board_jobs_watchdog`, which nothing gates on, so a box sat
 * "healthy" for 41 hours with no card moving until a human ran `pm2 restart`.
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
 *     non-gating `advisory.board_jobs_watchdog`, which reports all three states.
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
 * MONITORING DISABLED: DISABLE_BOARD_JOBS_WATCHDOG is an operator opt-out, so
 * the gating check PASSES and says so. Making it indeterminate would park the
 * box in permanent UNKNOWN, which cc-health-check.sh eventually escalates as a
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
 if(disabled())return {pass:true,detail:'scheduler_liveness: monitoring disabled on this box (DISABLE_BOARD_JOBS_WATCHDOG); not gated'};
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

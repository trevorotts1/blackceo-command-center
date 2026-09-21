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
 * When a watched job is SILENT the watchdog REPAIRS it: it restarts the command
 * center process (the only repair possible for an in-process node-cron loop)
 * under a warm-up guard, a cooldown and a three-in-six-hours circuit breaker,
 * and the Telegram message states what it did. See the SELF-REPAIR block below.
 *
 * It sends ONE Telegram message per cooldown window (default 60 minutes).
 * Messages are written for a human who has just been paged, does not know this
 * codebase, and is being TOLD what happened — never handed a chore.
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
 failed:boolean;running:boolean;leaseHeld:boolean;lastSuccessAt:string|null;consecutiveFailures:number;errorCode:string|null;resultCounts:Record<string,number>;
}

/**
 * A LIVE, UNEXPIRED scheduler lease for `jobName` — the proof that a tick is
 * still RUNNING rather than stalled.
 *
 * WHY THIS READ EXISTS. `stale` used to fire for any job whose current run had
 * been going longer than cadence x STALE_MULTIPLIER, and for the qc-review-sweep
 * that window is SIX MINUTES. A legitimate QC sweep that takes longer than six
 * minutes was therefore reported as a stalled scheduler, and because a silent
 * job is the one state the watchdog repairs, it restarted the whole command
 * center process (exit 75) out from under the sweep that was still working —
 * observed twice in one day on one box. The restart then killed the run, which
 * guaranteed the next tick looked silent too.
 *
 * A running job HOLDS a `scheduler_leases` row (job-lease.ts: inserted before
 * the body runs, DELETEd when it settles) whose `expires_at` is bounded by the
 * job's own timeout budget. So the lease answers exactly the question `stale`
 * was guessing at: is a process still working on this, right now? A crashed
 * process leaves its lease behind, but only until `expires_at` passes — which
 * is why the lease is a LIVENESS signal and not an excuse: once it expires, an
 * overrunning job is stale again on the ordinary threshold.
 *
 * An unreadable leases table returns false, which restores the previous
 * (stricter) behaviour rather than suppressing a real stall.
 */
function leaseHeldFor(jobName:string):boolean {
 try {
  return !!queryOne<{job_name:string}>('SELECT job_name FROM scheduler_leases WHERE job_name=? AND expires_at>?',[jobName,new Date().toISOString()]);
 } catch { return false; /* missing schema / locked DB is not proof of a live lease */ }
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
  // NO PROGRESS: neither a finished tick nor the current run has advanced inside
  // the job's own cadence x STALE_MULTIPLIER window. `last_ran_at` is only moved
  // by a FINISHED tick, so an overrunning run trips both halves at once.
  const noProgress=age>staleThresholdMinutes || (running && (Date.now()-started)/60000>staleThresholdMinutes);
  // A running tick is ALIVE while it holds an unexpired lease. Only when the
  // lease has expired AND nothing has progressed is it a stall.
  const leaseHeld=running && leaseHeldFor(jobName);
  return {jobName,cadenceMinutes,lastRanAt:row?.last_ran_at||null,lastStatus:row?.last_status||null,ageMinutes:Number.isFinite(age)?age:null,staleThresholdMinutes,
   stale:!row || !Number.isFinite(age) || (noProgress && !leaseHeld),
   // The "no recent success" half of `failed` is the SAME misreading as `stale`
   // one line up: a job that is still running holds its lease and has simply not
   // finished yet, which is not a failure. Real failure evidence (an error
   // status, a non-zero consecutive-failure count) is unaffected — only the
   // time-since-success inference defers to the live lease.
   disabled:row?.last_status==='disabled',failed:row?.last_status==='error' || (row?.consecutive_failures||0)>0 || (!!lastSuccessAt && successAge>staleThresholdMinutes && !leaseHeld),
   running,leaseHeld,lastSuccessAt,consecutiveFailures:row?.consecutive_failures||0,errorCode:row?.error_code||null,resultCounts:counts};
 });
}

/** "1 minute" / "2 minutes" — the messages are read by people, not parsers. */
function plural(count:number,noun:string):string { return `${count} ${noun}${count===1?'':'s'}`; }
/** "a", "a and b", "a, b and c". */
function naturalList(items:string[]):string {
 if(items.length<2)return items[0]||'';
 return `${items.slice(0,-1).join(', ')} and ${items[items.length-1]}`;
}
/** Small counts read as words inside a sentence someone is being paged with.
 *  Rendered FROM the constants they describe, so a changed budget can never
 *  leave the message quoting a number the code no longer enforces. */
const NUMBER_WORDS=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
function numberWord(n:number):string { return NUMBER_WORDS[n]??String(n); }

/** "has not run for 17 minutes" / "has never run since the command center started". */
function silentAgeClause(w:WatchedJobLiveness):string {
 return w.ageMinutes===null?'has never run since the command center started':`has not run for ${plural(Math.round(w.ageMinutes),'minute')}`;
}
/** The opening sentence of every silent-job message. */
function describeSilent(w:WatchedJobLiveness):string {
 return w.ageMinutes===null?`${w.jobName} ${silentAgeClause(w)}.`:`${w.jobName} ${silentAgeClause(w)} (it should run every ${plural(w.cadenceMinutes,'minute')}).`;
}
/** A job that is TICKING but whose body keeps throwing. The loop is alive, so a
 *  restart repairs nothing: the message says what the system is already doing
 *  about it (retrying on the job's own cadence) instead of handing over a chore. */
function describeFailing(w:WatchedJobLiveness):string {
 return `${w.jobName} has failed ${plural(w.consecutiveFailures,'run')} in a row (last error: ${w.errorCode||'unknown'}). The job keeps being retried every ${plural(w.cadenceMinutes,'minute')}.`;
}
/** One problem, in plain English, for the NON-GATING advisory surface. That
 *  surface is a pure read and knows nothing about any repair, so it describes
 *  the CONDITION only; runBoardJobsWatchdog() below replaces the silent
 *  sentence with what the system actually DID about it. */
function describeProblem(w:WatchedJobLiveness):string {
 if(!w.stale)return describeFailing(w);
 if(w.ageMinutes===null)return describeSilent(w);
 return `${describeSilent(w)} The background loop that moves tasks may have stopped.`;
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

/**
 * SELF-REPAIR — "I'm not checking this. You did it. You check it."
 *
 * The alert this watchdog used to send ended by telling the reader to go and
 * inspect the command center process themselves. That is a chore handed to a
 * person for a fault the system can both detect and fix, and on the box that
 * proved it that chore was the ONLY thing
 * standing between a dead loop and a dead board: the out-of-process repair
 * (scripts/watchdog-cc.sh) was never installed on any schedule by anything in
 * this repo, so nothing was ever going to restart that loop. Two independent
 * layers now perform the repair, and the message states what was done:
 *
 *   IN-PROCESS (here): the cron loop is dead but the process is alive and
 *     still answering HTTP. node-cron registrations are made ONCE at boot, so
 *     nothing inside a running process can revive them. The only repair
 *     available from inside is to exit and let pm2 start it again with fresh
 *     timers.
 *   OUT-OF-PROCESS (scripts/watchdog-cc.sh, installed on a schedule by
 *     scripts/install-watchdog-cc.sh from the deploy): covers what this layer
 *     cannot — a process that is gone, wedged, or not answering at all.
 *
 * A self-restart is loud and destructive of in-flight work, so every guard
 * below is a hard precondition, never a heuristic:
 *
 *   WARM-UP     every liveness row reads silent right after a start, so a
 *               restart inside the warm-up window would feed on itself. The
 *               window is computed by the SAME function the gating
 *               scheduler_liveness check uses (schedulerLivenessWarmupMinutes),
 *               so the restarting layer and the gating layer cannot drift.
 *   COOLDOWN    at most one self-restart per
 *               BOARD_JOBS_WATCHDOG_RESTART_COOLDOWN_MINUTES (default 60),
 *               proved by an `events` row written BEFORE the exit, so the
 *               evidence survives the restart it is about to cause.
 *   BREAKER     three restarts inside six hours is proof that restarting is
 *               not the repair. The watchdog stops restarting and says so.
 *   SILENT ONLY a `failed` job is still TICKING (its body throws) and a
 *               `disabled` job is an operator's decision. Neither is a stalled
 *               loop, and restarting for either would destroy work for a fault
 *               a restart cannot fix. A job that is disabled AND has stopped
 *               ticking is deliberately left to the out-of-process watchdog,
 *               whose gating signal (checkSchedulerLiveness) keys on `stale`
 *               alone and so still covers it.
 *
 * EXIT CODE 75 (EX_TEMPFAIL, "temporary failure — retry"):
 * ecosystem.config.cjs sets `stop_exit_codes: [78]`, so 78 is the one code pm2
 * will NOT restart — it is cc-start.sh's deterministic refusal receipt for a
 * missing/stale build, and using it here would leave the box DOWN instead of
 * recovered. With `autorestart: true` every other code is restarted, so 75 is
 * picked because it means exactly what is happening, and it is distinct from 0
 * and 1 in `pm2 logs` so a self-restart is identifiable after the fact. By the
 * time the warm-up guard allows this, the process has been up far longer than
 * min_uptime (30s), so pm2 counts it as a clean restart and it does not consume
 * the max_restarts circuit-breaker budget.
 */
export const BOARD_JOBS_WATCHDOG_RESTART_EVENT='board_jobs_watchdog_restart';
export const BOARD_JOBS_WATCHDOG_RESTART_EXIT_CODE=75;
export const BOARD_JOBS_WATCHDOG_RESTART_MAX_IN_WINDOW=3;
export const BOARD_JOBS_WATCHDOG_RESTART_WINDOW_HOURS=6;
/** Long enough for notifySystem()'s write and the log line to land before the
 *  process goes away; short enough that the board is back on its feet fast. */
const BOARD_JOBS_WATCHDOG_RESTART_DELAY_MS=500;

/** Read per call, exactly like disabled() and cooldownMinutes(), so a box that
 *  changes its env does not have to be restarted for the change to be read. */
const restartCooldownMinutes=()=>Math.max(1,Number(readEnv('BOARD_JOBS_WATCHDOG_RESTART_COOLDOWN_MINUTES'))||60);
const selfRestartEnabled=()=>!['0','false'].includes((readEnv('BOARD_JOBS_WATCHDOG_SELF_RESTART')??'1').trim().toLowerCase());

/** The exit is injectable so tests can prove the restart decision WITHOUT
 *  killing the test runner. Production wiring is process.exit and nothing else. */
let exitFn:(code:number)=>void=(code:number)=>{process.exit(code);};
let restartScheduled=false;
export function setBoardJobsWatchdogExitFn(fn:(code:number)=>void):void { exitFn=fn; restartScheduled=false; }
export function resetBoardJobsWatchdogExitFn():void { exitFn=(code:number)=>{process.exit(code);}; restartScheduled=false; }

export type SelfRestartOutcome='none'|'warmup'|'restarted'|'cooldown'|'breaker'|'switched-off'|'unknown-history';
interface SelfRestartDecision {outcome:SelfRestartOutcome;minutesSinceRestart?:number;warmupMinutes?:number;uptimeMinutes?:number;restartsInWindow?:number;reason?:string;}

function decideSelfRestart(watched:WatchedJobLiveness[],uptimeSeconds:number):SelfRestartDecision {
 if(!selfRestartEnabled())return {outcome:'switched-off'};
 const warmupMinutes=schedulerLivenessWarmupMinutes(watched),uptimeMinutes=uptimeSeconds/60;
 if(uptimeMinutes<warmupMinutes)return {outcome:'warmup',warmupMinutes,uptimeMinutes};
 // The restart history is the EVIDENCE for both remaining guards. If it cannot
 // be read the guards cannot be proved, and an unreadable history is never
 // read as "no restarts yet" — that would turn a locked DB into a restart loop.
 let restartsInWindow:number, lastRestartAt:string|null;
 try {
  restartsInWindow=queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM events WHERE type=? AND ${sqlTime('created_at')} >= datetime('now',?)`,[BOARD_JOBS_WATCHDOG_RESTART_EVENT,`-${BOARD_JOBS_WATCHDOG_RESTART_WINDOW_HOURS} hours`])?.n||0;
  lastRestartAt=queryOne<{created_at:string}>(`SELECT created_at FROM events WHERE type=? ORDER BY ${sqlTime('created_at')} DESC LIMIT 1`,[BOARD_JOBS_WATCHDOG_RESTART_EVENT])?.created_at??null;
 } catch(err) { return {outcome:'unknown-history',reason:err instanceof Error?err.message:String(err)}; }
 // Breaker BEFORE cooldown: once three restarts have failed to fix it, the
 // honest message is "restarting is not working and has stopped", not "wait
 // and see". The third restart is normally still inside the cooldown window,
 // so checking cooldown first would hide the breaker for an hour.
 if(restartsInWindow>=BOARD_JOBS_WATCHDOG_RESTART_MAX_IN_WINDOW)return {outcome:'breaker',restartsInWindow};
 const sinceMinutes=lastRestartAt?(Date.now()-parseDbTime(lastRestartAt))/60000:Number.POSITIVE_INFINITY;
 if(lastRestartAt&&!Number.isFinite(sinceMinutes))return {outcome:'unknown-history',reason:`the last restart timestamp is unreadable (${lastRestartAt})`};
 if(Number.isFinite(sinceMinutes)&&sinceMinutes<restartCooldownMinutes())return {outcome:'cooldown',minutesSinceRestart:Math.max(0,Math.round(sinceMinutes))};
 return {outcome:'restarted'};
}

/** What the system DID about this silent job, in the words an operator reads. */
function describeSilentWithOutcome(w:WatchedJobLiveness,d:SelfRestartDecision):string {
 switch(d.outcome) {
  case 'restarted': return `${describeSilent(w)} The command center restarted itself to recover it. If this message repeats within the hour, the restart did not fix it.`;
  case 'cooldown': return `${w.jobName} is still not running ${plural(d.minutesSinceRestart??0,'minute')} after the command center restarted itself. The restart did not fix it.`;
  case 'breaker': return `${w.jobName} ${silentAgeClause(w)} and ${numberWord(BOARD_JOBS_WATCHDOG_RESTART_MAX_IN_WINDOW)} automatic restarts in ${numberWord(BOARD_JOBS_WATCHDOG_RESTART_WINDOW_HOURS)} hours did not fix it. The command center has stopped restarting itself. A person needs to look at this box.`;
  case 'switched-off': return `${describeSilent(w)} Automatic restart is switched off on this box (BOARD_JOBS_WATCHDOG_SELF_RESTART=0).`;
  case 'unknown-history': return `${describeSilent(w)} The command center could not read its own restart history (${d.reason}), so it did not restart itself.`;
  default: return describeProblem(w);
 }
}

export interface BoardJobsWatchdogRunResult {ranAt:string;skippedReason?:string;staleJobs:string[];disabledJobs:string[];failedJobs?:string[];alerted:boolean;notificationStatus?:'queued'|'unavailable'|'cooldown'|'warmup';selfRestart?:SelfRestartOutcome;}
export async function runBoardJobsWatchdog(uptimeSeconds:number=process.uptime()):Promise<BoardJobsWatchdogRunResult> {
 const ranAt=timeNow();
 if(disabled())return {ranAt,skippedReason:'DISABLE_BOARD_JOBS_WATCHDOG set',staleJobs:[],disabledJobs:[],failedJobs:[],alerted:false};
 const check=checkBoardJobsWatchdog(),watched=check.watched;
 const result:BoardJobsWatchdogRunResult={ranAt,staleJobs:watched.filter(w=>w.stale).map(w=>w.jobName),disabledJobs:watched.filter(w=>w.disabled&&!w.stale).map(w=>w.jobName),failedJobs:watched.filter(w=>w.failed).map(w=>w.jobName),alerted:false};
 if(check.pass)return result;

 // SILENT, and not switched off by an operator — the only state a restart can repair.
 const silent=watched.filter(w=>w.stale&&!w.disabled);
 const decision:SelfRestartDecision=silent.length?decideSelfRestart(watched,uptimeSeconds):{outcome:'none'};
 result.selfRestart=decision.outcome;

 // WARM-UP: the process has just started, so silence is the EXPECTED state and
 // there is no adverse signal to report. Logged, never sent: a Telegram here
 // would page a person after every single deploy.
 if(decision.outcome==='warmup') {
  console.log(`[board-jobs-watchdog] ${naturalList(silent.map(w=>w.jobName))} ${silent.length===1?'has':'have'} not ticked yet, but this process has been up for only ${Math.round(decision.uptimeMinutes??0)} of the ${decision.warmupMinutes} warm-up minutes. That is a boot and not a stall: no restart, no alert.`);
  return {...result,notificationStatus:'warmup'};
 }

 const unhealthy=watched.filter(w=>w.stale||(!w.disabled&&w.failed));
 const detail=unhealthy.map(w=>w.stale&&!w.disabled?describeSilentWithOutcome(w,decision):describeProblem(w)).join(' | ');

 if(decision.outcome==='restarted') {
  // The receipt is written BEFORE the exit, on purpose: it is the evidence the
  // cooldown and the breaker read AFTER the restart, and a row written after
  // process.exit() would never exist. It also bypasses the ordinary alert
  // cooldown — an alert saying "I restarted myself" is a new fact every time.
  run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)',[uuidv4(),BOARD_JOBS_WATCHDOG_RESTART_EVENT,`board_jobs_watchdog: self-restart (exit ${BOARD_JOBS_WATCHDOG_RESTART_EXIT_CODE}) — ${detail}`,ranAt]);
  const queued=notifySystem(`[BOARD JOBS WATCHDOG] ${detail}`,{agent:'board-jobs-watchdog',action:'escalate'});
  run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)',[uuidv4(),queued?BOARD_JOBS_WATCHDOG_ALERT_EVENT:BOARD_JOBS_WATCHDOG_ALERT_UNAVAILABLE_EVENT,`board_jobs_watchdog: ${detail}; notification ${queued?'queued (delivery not confirmed)':'unavailable'}`,ranAt]);
  console.warn(`[board-jobs-watchdog] SELF-RESTART: ${detail} Exiting ${BOARD_JOBS_WATCHDOG_RESTART_EXIT_CODE} so pm2 starts this process again with fresh timers.`);
  if(!restartScheduled){restartScheduled=true;setTimeout(()=>{exitFn(BOARD_JOBS_WATCHDOG_RESTART_EXIT_CODE);},BOARD_JOBS_WATCHDOG_RESTART_DELAY_MS);}
  return {...result,alerted:queued,notificationStatus:queued?'queued':'unavailable'};
 }

 const recent=queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM events WHERE type IN (${COOLDOWN_EVENT_TYPES.map(()=>'?').join(',')}) AND ${sqlTime('created_at')} >= datetime('now',?)`,[...COOLDOWN_EVENT_TYPES,`-${cooldownMinutes()} minutes`])?.n||0;
 if(recent)return {...result,notificationStatus:'cooldown'};
 const queued=notifySystem(`[BOARD JOBS WATCHDOG] ${detail}`,{agent:'board-jobs-watchdog',action:'escalate'});
 run('INSERT INTO events(id,type,task_id,message,created_at) VALUES(?,?,NULL,?,?)',[uuidv4(),queued?BOARD_JOBS_WATCHDOG_ALERT_EVENT:BOARD_JOBS_WATCHDOG_ALERT_UNAVAILABLE_EVENT,`board_jobs_watchdog: ${detail}; notification ${queued?'queued (delivery not confirmed)':'unavailable'}`,ranAt]);
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

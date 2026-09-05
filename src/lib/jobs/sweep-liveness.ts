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
 const unhealthy=watched.filter(w=>w.stale||w.disabled||w.failed);
 return {pass:unhealthy.length===0,watched,detail:unhealthy.length?`sweep_liveness: ${unhealthy.map(w=>`${w.jobName} ${w.disabled?'DISABLED':w.failed?'FAILED':'silent'} (${w.consecutiveFailures} consecutive failures; ${w.ageMinutes===null?'never observed':Math.round(w.ageMinutes)+'m since tick'})`).join('; ')}`:`sweep_liveness: OK — ${watched.map(w=>w.jobName).join(', ')}`};
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

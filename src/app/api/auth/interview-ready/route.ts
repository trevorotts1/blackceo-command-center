import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { queryOne } from '@/lib/db';
import { personaCompanyContext } from '@/lib/persona-company';
import { readBuildState } from '@/lib/interview/seam';
import { buildStatePath, resolveWorkspaceDir, updateInterviewStateScript, recordDeptDecisionScript, listCanonicalDepartmentsScript } from '@/lib/interview/paths';
import { hasCanonicalPersonaCatalog, verifyStandardFoundation } from '@/lib/interview/foundation-verification';
import { resolveOpenClawRuntimeRoot } from '@/lib/openclaw/runtime-root';
import { runtimeRegistryEntries } from '@/lib/openclaw/runtime-registry';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const protocol='interview-launch.v1';
/** Authenticated launch prerequisites, never a claim that a provider accepted a turn. */
export async function GET(req:NextRequest) {
  const headers={'cache-control':'private, no-store'};
  try {
    const context=await resolveTenantContext(req);
    if(context.subject!=='operator:api') return NextResponse.json({ready:false,protocol,error:'operator_required'},{status:403,headers});
    const missing:string[]=[];
    if(context.kind!=='self') missing.push('dedicated_self_registration');
    if(process.env.MC_INSTALLATION_ID!==context.installationId) missing.push('installation_id');
    if(!queryOne('SELECT id FROM companies WHERE id=?',[context.companyId])) missing.push('company_record');
    if(!queryOne('SELECT id FROM workspaces WHERE company_id=? AND archived_at IS NULL',[context.companyId])) missing.push('company_workspace');
    const state=readBuildState();
    let stateReady=!!state && typeof state.interviewComplete==='boolean' && state.companyId===context.companyId && state.installationId===context.installationId && state.tenantId===context.tenantId;
    if(!stateReady) missing.push('scoped_interview_state');
    try {fs.accessSync(buildStatePath(),fs.constants.R_OK|fs.constants.W_OK);fs.accessSync(path.dirname(buildStatePath()),fs.constants.W_OK);} catch {stateReady=false;missing.push('interview_state_access');}
    try {
      const persona=personaCompanyContext(context.companyId);
      if(!hasCanonicalPersonaCatalog(JSON.parse(fs.readFileSync(persona.personaCatalog,'utf8')))) missing.push('canonical_persona_catalog');
    } catch {missing.push('persona_company_context_or_catalog');}
    const prerequisites:string[]=[];
    for(const file of [updateInterviewStateScript(),recordDeptDecisionScript(),listCanonicalDepartmentsScript()]) {
      try {if(!fs.statSync(file).isFile() || fs.statSync(file).size===0) throw new Error();fs.accessSync(file,fs.constants.R_OK);} catch {prerequisites.push('local_interview_scripts');break;}
    }
    try {
      const root=resolveOpenClawRuntimeRoot(),configPath=path.join(root,'openclaw.json');
      if(fs.statSync(configPath).size>1024*1024) throw new Error();
      const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
      if(config.gateway?.auth?.mode==='token' && !process.env.OPENCLAW_GATEWAY_TOKEN) prerequisites.push('gateway_token_configuration');
      const entries=runtimeRegistryEntries(config),defaults=entries.filter(entry=>entry.default===true);
      // Interview turns call sessions.create without agentId; inspect the configured
      // ambient owner, not whichever directory happens to be named main.
      // https://docs.openclaw.ai/gateway/config-agents#agentsdefaultssystemagent
      const owner=config.agents?.defaults?.systemAgent?.agentId;
      const selected=typeof owner==='string' ? entries.find(entry=>entry.id===owner)
        : config.agents?.ownership!=='explicit' && defaults.length===1 ? defaults[0]
        : defaults.length===0 && entries.length===1 ? entries[0] : undefined;
      if(!selected || !/^[a-zA-Z0-9_-]+$/.test(selected.id)) throw new Error();
      const modelSetting:unknown=selected.model ?? config.agents?.defaults?.model;
      const model=typeof modelSetting==='string' ? modelSetting
        : modelSetting && typeof modelSetting==='object' ? (modelSetting as {primary?:unknown}).primary : undefined;
      if(typeof model!=='string' || !model.trim()) throw new Error();
      const configuredPath=(value:unknown):string=>{
        if(typeof value!=='string' || !value.trim()) throw new Error();
        const expanded=value.startsWith('~/') ? path.join(os.homedir(),value.slice(2)) : value;
        if(!path.isAbsolute(expanded)) throw new Error();
        return fs.realpathSync(expanded);
      };
      const agentDir=configuredPath(selected.agentDir ?? path.join(root,'agents',selected.id,'agent'));
      if(!fs.statSync(agentDir).isDirectory()) throw new Error();
      fs.accessSync(agentDir,fs.constants.R_OK|fs.constants.W_OK);
      const agentWorkspace=configuredPath(selected.workspace ?? config.agents?.defaults?.workspace ?? path.join(root,'workspace'));
      if(!fs.statSync(agentWorkspace).isDirectory() || agentWorkspace!==configuredPath(resolveWorkspaceDir())) throw new Error();

    } catch {prerequisites.push('interviewer_runtime_configuration');}
    try {const gateway=new URL(process.env.OPENCLAW_GATEWAY_URL||'ws://127.0.0.1:18789');if(!['ws:','wss:'].includes(gateway.protocol))throw new Error();} catch {prerequisites.push('gateway_configuration');}
    missing.push(...prerequisites);
    const enrollment=!!(process.env.MC_TENANT_SESSION_SECRET||process.env.MC_INTERVIEW_COOKIE_SECRET||process.env.MC_API_TOKEN);
    if(!enrollment) missing.push('enrollment_secret');
    const foundation=verifyStandardFoundation(state);
    if(state?.buildType==='standard-first' && !foundation.ready) missing.push('standard_foundation_unverified');
    return NextResponse.json({protocol,stage:'interview',ready:missing.length===0,tenantId:context.tenantId,companyId:context.companyId,installationId:context.installationId,host:context.host,interviewComplete:stateReady?state!.interviewComplete:null,capabilities:{state:stateReady,localInterviewPrerequisites:prerequisites.length===0,enrollment,providerLiveness:'unverified'},foundation,missing},{status:missing.length?503:200,headers});
  } catch {return NextResponse.json({ready:false,protocol,error:'tenant_registration_or_identity_unverified'},{status:403,headers});}
}

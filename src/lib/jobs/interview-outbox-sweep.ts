/** Resume durable interview synchronization even after the browser closes. */
import { tenantRegistration } from '@/lib/auth/tenant-context';
import { drainInterviewOperations } from '@/lib/interview/remote-protocol';
import { throwIfJobLeaseLost } from './job-lease';
export async function runInterviewOutboxSweep() {
 let hosts: string[] = [];
 try { hosts = Object.keys(JSON.parse(process.env.MC_TENANT_REGISTRY_JSON || '{}')); }
 catch { return { scanned: 0, skippedReason: 'MC_TENANT_REGISTRY_JSON is not valid JSON' }; }
 let scanned=0;
 for(const host of hosts) {
  throwIfJobLeaseLost();
  const reg=tenantRegistration(host);
  if(reg.kind!=='client'||!reg.remoteUrl||!reg.remoteSecret)continue;
  await drainInterviewOperations({tenantId:reg.tenantId,companyId:reg.companyId,clientId:reg.clientId!,kind:reg.kind,subject:'system:interview-sync',host,installationId:reg.installationId},1);
  scanned++;
 }
 return {scanned};
}

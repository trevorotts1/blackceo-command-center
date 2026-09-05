/** Operator-only local tool: never emails or sends the invitation. */
import { randomUUID } from 'crypto';
import { tenantRegistration, signTenantGrant } from '../src/lib/auth/tenant-context';
async function main() {
  const [host,subject]=process.argv.slice(2);
  if(!host || !subject || subject.startsWith('operator:'))throw new Error('Usage: npx tsx scripts/mint-interview-enrollment.ts <registered-host> <owner-subject>');
  const reg=tenantRegistration(host);
  const ticket=await signTenantGrant({purpose:'enrollment',tenantId:reg.tenantId,subject,host,installationId:reg.installationId,exp:Math.floor(Date.now()/1000)+900,nonce:randomUUID()});
  process.stdout.write(`https://${host}/interview#enroll=${encodeURIComponent(ticket)}\n`);
}
void main().catch(err=>{process.stderr.write(`${err.message}\n`);process.exitCode=1;});

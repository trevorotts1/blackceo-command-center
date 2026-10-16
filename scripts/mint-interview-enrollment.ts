/** Operator-only local tool: never emails or sends the invitation. */
import { randomUUID } from 'crypto';
import { tenantRegistration, signTenantGrant } from '../src/lib/auth/tenant-context';
import { INTERVIEW_INVITATION_TTL_SECONDS } from '../src/lib/interview/session-policy';
async function main() {
  const [host,subject]=process.argv.slice(2);
  if(!host || !subject || subject.startsWith('operator:'))throw new Error('Usage: npx tsx scripts/mint-interview-enrollment.ts <registered-host> <owner-subject>');
  const reg=tenantRegistration(host);
  // `exp` is a wire-shape stamp, not this link's lifetime: an enrollment ticket
  // is valid until the interview is complete, and redemption ignores it.
  const ticket=await signTenantGrant({purpose:'enrollment',tenantId:reg.tenantId,subject,host,installationId:reg.installationId,exp:Math.floor(Date.now()/1000)+INTERVIEW_INVITATION_TTL_SECONDS,nonce:randomUUID()});
  process.stdout.write(`https://${host}/interview?enroll=${encodeURIComponent(ticket)}\n`);
}
void main().catch(err=>{process.stderr.write(`${err.message}\n`);process.exitCode=1;});

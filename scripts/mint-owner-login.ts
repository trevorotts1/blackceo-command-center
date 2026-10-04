/**
 * Operator-only local tool: mint a one-use owner sign-in link for a COMPLETED
 * company (SPEC S7 line 275).
 *
 * Run it ON the box, as the operator:
 *
 *   npx tsx scripts/mint-owner-login.ts            # uses the box's configured origin
 *   npx tsx scripts/mint-owner-login.ts --origin https://board.example.com
 *
 * What it refuses to do, by construction:
 *   • No HTTP issuance endpoint exists. Nothing in the served app can mint one
 *     of these; only this local command, carrying the operator's own OS context.
 *   • Recipient, subject, company and installation are NEVER arguments. The
 *     owner comes from the existing resolveOwnerChatId() record and the
 *     company/installation come from the host's own registration, so a caller
 *     cannot name a different owner. `--origin` selects WHICH configured origin
 *     is used; it cannot invent one that this box does not already serve.
 *   • The link is printed to stdout and to nothing else: never sent, never
 *     logged to a file, never auto-published.
 *
 * The ten-minute clock is the ticket's own `exp`, and it is real: `owner-login`
 * is not in tenant-context's timeless-purpose set.
 */

import { randomUUID } from 'node:crypto';
import {
  configuredPublicOrigin,
  signTenantGrant,
  tenantRegistration,
} from '../src/lib/auth/tenant-context';
import { resolveOwnerChatId } from '../src/lib/notify';
import {
  OWNER_LOGIN_PURPOSE,
  OWNER_LOGIN_TTL_SECONDS,
  ownerLoginLink,
  ownerSubjectForChatId,
  registrationAllowsOwnerLogin,
} from '../src/lib/auth/owner-login';

/** Exact-origin argument, so several configured origins are not a guess. */
function requestedOrigin(argv: string[]): string | null {
  const flag = argv.indexOf('--origin');
  if (flag === -1) return null;
  const value = argv[flag + 1];
  if (!value || value.startsWith('--')) throw new Error('--origin needs a value, e.g. --origin https://board.example.com');
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const override = requestedOrigin(argv);

  const configured = configuredPublicOrigin();
  const origin = override ? new URL(override) : configured;
  if (!origin) {
    throw new Error(
      'No configured public origin on this box (CC_PUBLIC_URL / MC_TENANT_PUBLIC_URL). ' +
        'Set the box up first, or pass --origin with the address this box actually serves.',
    );
  }
  if (configured && origin.origin !== configured.origin) {
    throw new Error(
      `Refusing ${origin.origin}: this box's configured public origin is ${configured.origin}. ` +
        'A sign-in link must be minted for the address the box itself serves.',
    );
  }
  if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error(`Refusing ${origin.origin}: a production sign-in link requires HTTPS.`);
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`Refusing ${origin.origin}: the origin must be scheme+host+port only, with no path, query or fragment.`);
  }

  const host = origin.host;
  const registration = tenantRegistration(host);
  if (!registrationAllowsOwnerLogin(host)) {
    throw new Error(
      `Refusing to mint for ${host}: owner sign-in is for a self-kind registration whose ` +
        'company and installation match this box. A client-kind host, or a host whose ' +
        'registration disagrees with MC_COMPANY_ID / MC_INSTALLATION_ID, is not eligible.',
    );
  }

  const ownerChat = resolveOwnerChatId();
  if (!ownerChat) {
    throw new Error(
      'Refusing to mint: no explicit owner record resolves on this box (OPENCLAW_OWNER_CHAT_ID, ' +
        '.env.local, openclaw.json env vars, secrets/.env, or ownerChat in the build state). ' +
        'A missing or ambiguous owner is a refusal, never a guess.',
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + OWNER_LOGIN_TTL_SECONDS;
  const ticket = await signTenantGrant({
    purpose: OWNER_LOGIN_PURPOSE,
    tenantId: registration.tenantId,
    companyId: registration.companyId,
    installationId: registration.installationId,
    host,
    // Stable subject, derived exactly as interview issuance derives it.
    subject: ownerSubjectForChatId(ownerChat),
    exp: expiresAt,
    nonce: randomUUID(),
  });

  // Private link only, to the operator invoking this command.
  process.stdout.write(`${ownerLoginLink(origin, ticket)}\n`);
  process.stdout.write(`expires at ${new Date(expiresAt * 1000).toISOString()} (ten minutes, single use)\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

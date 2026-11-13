/**
 * GET /api/interview/next  (BU-13)
 *
 * The ONE question the owner should see next, straight from the step gate
 * (`interview_gate.py next`). The page no longer decides order: the gate does.
 *
 * Response = the gate's own `next` JSON, unchanged:
 *   {done:false, id, section, kind, prompt, help, example, choices, suggestions,
 *    required, allowSkip, allowUnsure, allowOther, minChars, minWords,
 *    knownValue, knownSource, attempt, requiredTotal, requiredAnswered,
 *    answeredTotal, percent}
 * or, when every required question has an answer:
 *   {done:true, missingRequired:[], skippedOpen:[], …counts}
 *
 * Known facts (the clients row + company config) are published to
 * `interview-known.json` first, so `next` can offer them as `knownValue` — the
 * gate never answers from them; the owner still submits.
 *
 * Error mapping:
 *   403 forbidden                 — server-side tenant identity is not verified
 *   503 temporarily_unavailable   — the gate is not installed or could not run
 *                                   (never "not answered")
 *   503 box_unreachable           — a CLIENT tenant whose own box cannot be
 *                                   reached over the operator-hosted lane; the
 *                                   page says so instead of a lock hint
 *
 * DOCTRINE: this route reads only. The gate is the sole writer of its state.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runGate, writeKnownFacts } from '@/lib/interview/seam';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { getClientContext } from '@/lib/clients';
import { loadCompanyConfig } from '@/lib/company-config';
import { ensureTenantInterview } from '@/lib/interview/remote-store';
import { readRemoteInterviewState } from '@/lib/interview/remote-protocol';

/** BU-25: the exact sentence the page shows for an unreachable client box. */
const BOX_UNREACHABLE_MESSAGE =
  'We cannot reach your system right now. Your answers are saved. Please try again in a few minutes.';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* -------------------------------------------------------------------------- */
/* known-context (memory) — facts already on file the interview can CONFIRM    */
/* -------------------------------------------------------------------------- */

/**
 * Facts the box already holds (clients row + company config) keyed by the
 * structured question that asks for them. The UI prefills the matching card and
 * offers "confirm or correct"; a confirm posts confirmedFromContext so the QC
 * gate classifies it as confirmed-from-context, never fabricated. Values are
 * read-only here; template/default values are filtered out so the owner is
 * never asked to "confirm" a placeholder.
 *
 * Deliberately a copy of the state route's reader: a Next route module may not
 * export helpers for a sibling route to import, and this route must serve the
 * SELF tenant only (the state route's client-tenant variant lives there).
 */
async function readKnownContext(): Promise<Record<string, { value: string; source: string }>> {
  const known: Record<string, { value: string; source: string }> = {};
  try {
    const client = await getClientContext();
    const name = (client?.name ?? '').trim();
    // Placeholder names (fresh-box auto-seed rows) are NOT known facts.
    const placeholderName = /^(default|this box(\s*\(operator\))?|operator)$/i.test(name);
    if (name && !placeholderName) {
      known.company_name = { value: name, source: 'client-record' };
    }
    if (client?.brand_color && String(client.brand_color).trim()) {
      known.brand_primary_color = {
        value: String(client.brand_color).trim(),
        source: 'client-record',
      };
    }
    if (client?.logo_url && String(client.logo_url).trim()) {
      known.brand_logo = { value: String(client.logo_url).trim(), source: 'client-record' };
    }
  } catch {
    /* fail-soft: no client context → nothing known */
  }
  try {
    const cfg = loadCompanyConfig();
    if (!known.company_name) {
      const cfgName = (cfg.companyName ?? '').trim();
      const placeholderCfgName = /^(your company|command center)$/i.test(cfgName);
      if (cfgName && !placeholderCfgName) {
        known.company_name = { value: cfgName, source: 'company-settings' };
      }
    }
    const industry = (cfg.industry ?? '').trim();
    if (industry && !/^(unknown|general|template)$/i.test(industry)) {
      known.industry = { value: industry, source: 'company-settings' };
    }
    const ccName = (cfg.commandCenterName ?? '').trim();
    if (ccName && ccName.toLowerCase() !== 'command center') {
      known.command_center_name = { value: ccName, source: 'company-settings' };
    }
  } catch {
    /* fail-soft */
  }
  return known;
}

export async function GET(request: NextRequest) {
  // Same tenant checks as the state route: a verified caller, or a 403.
  const tenant = await resolveInterviewTenant(request);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;

  // The gate's state folder belongs to THIS box's own interview. A client
  // tenant's deck is served over the operator-hosted lane (its own unit); this
  // route never reads the operator's gate state on another tenant's behalf.
  //
  // BU-25: probe that lane before answering anything. When the client's box
  // cannot be reached the page must say "we cannot reach your system" (answers
  // are saved) instead of a lock hint that reads like "answer more".
  if (tenant.kind !== 'self') {
    try {
      const interview = ensureTenantInterview(tenant.context!.tenantId);
      await readRemoteInterviewState(tenant.context!, interview.interview_id);
    } catch {
      return NextResponse.json(
        { error: 'box_unreachable', message: BOX_UNREACHABLE_MESSAGE },
        { status: 503 },
      );
    }
    // Reachable: the lane's own reader answers the question. This release has
    // no next-question reader over that lane for a client tenant, so the route
    // reports a tooling gap — never "not answered" and never the gate's order.
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }

  try {
    writeKnownFacts(await readKnownContext());
  } catch {
    // A known-fact file that could not be written would silently re-ask every
    // question it covers; report it rather than serve a deck built on a guess.
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }

  const gate = await runGate(['next']);
  if (gate.code !== 0) {
    // Exit 1 / missing script / unusable output: a TOOLING failure. The caller
    // must say "temporarily unavailable", never "not answered".
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }
  return NextResponse.json(gate.json);
}

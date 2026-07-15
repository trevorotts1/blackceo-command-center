/**
 * Box / client identity for OUTBOUND operator escalations.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `notifySystem()` POSTed `{action, agent, message}` to the Rescue Rangers
 * escalation webhook — and NOTHING else. The body carried no client and no box,
 * so on the receiving end EVERY escalation from EVERY box in the fleet landed as
 * one anonymous sender:
 *
 *   1. ATTRIBUTION — an operator staring at a flooded escalation channel could
 *      not tell WHICH box was screaming. During a live escalation flood the
 *      source box was identified only by tracing the webhook's `x-real-ip`.
 *   2. CAP COLLAPSE — the documented escalation budget is "25 exchanges per
 *      client per day" (see fleet-heartbeat/scripts/propagate-rescue-webhook.sh,
 *      the canonical AGENTS.md escalation block). With no client on the payload
 *      the receiver cannot key that cap per client, so every box shares ONE
 *      counter: a single runaway box eats the entire fleet's escalation budget
 *      and silences every other box for the rest of the day.
 *
 * The fix is attribution, not muting: an escalation still ALWAYS fires. It just
 * now says who it is from.
 *
 * ── THE SCHEMA IS NOT NEW ──────────────────────────────────────────────────────
 * The fleet already has a canonical escalation payload — the one every box's
 * AGENTS.md tells its agent to POST:
 *
 *   {"action","person","clientName","agentName","boxName","boxType",
 *    "openclawVersion","problem","alreadyTried","returnTo"}
 *
 * (source: fleet-heartbeat/scripts/propagate-rescue-webhook.sh `make_section()`).
 * The Command Center's own escalations were the odd one out. This module resolves
 * the identity half of that schema — `clientName` / `boxName` / `boxType`, plus a
 * derived stable `boxId` — so the CC payload conforms instead of inventing a
 * second scheme.
 *
 * ── FLEET-WIDE / CONFIG-DRIVEN ────────────────────────────────────────────────
 * This repo is cloned to every client box: NO client name may ever be hardcoded
 * here. Every value is resolved at RUNTIME from env or the box's own
 * `config/company-config.json`, and the unpopulated repo template resolves to
 * `unknown-client` — never to a real brand.
 *
 * ── FAIL-OPEN ─────────────────────────────────────────────────────────────────
 * Identity is metadata on an ALARM. It must never be able to suppress the alarm:
 * every resolver is wrapped, never throws, and degrades to an `unknown-*`
 * placeholder. A box that cannot name itself still escalates — anonymously, which
 * is exactly the pre-fix behaviour and strictly better than silence.
 */

import fs from 'fs';
import os from 'os';
import { getCompanyName } from '@/lib/company-config';

/** Placeholder used when the client cannot be resolved. Never a real brand. */
export const UNKNOWN_CLIENT = 'unknown-client';
/** Placeholder used when the box cannot name itself. */
export const UNKNOWN_BOX = 'unknown-box';

/**
 * Unpopulated-template company names — a box still carrying one of these has
 * never been branded, so it is NOT a client and must not be attributed as one
 * (a bogus `clientName` is worse than an honest `unknown-client`: it would give
 * the receiver a cap key that collides across every unbranded box in the fleet).
 *
 * Kept in step with `TEMPLATE_COMPANY_NAMES` in src/lib/db/branding-seed.ts.
 * Deliberately NOT imported from there: branding-seed.ts pulls in better-sqlite3
 * at module load, and notify.ts (this module's only consumer) must stay free of
 * the native DB binding — an escalation has to work on a box whose DB is broken.
 * `command center` is added here because it is company-config.ts's own generic
 * fallback for an unset name, not a brand.
 */
const TEMPLATE_CLIENT_NAMES = new Set([
  'your company',
  'your company name',
  'command center',
]);

export interface BoxIdentity {
  /** The client this box belongs to, or UNKNOWN_CLIENT. The per-client cap key. */
  clientName: string;
  /** This box's own name (hostname unless pinned), or UNKNOWN_BOX. */
  boxName: string;
  /** 'VPS' (Docker/Hostinger) | 'Mac' (bare install) | 'unknown'. */
  boxType: 'VPS' | 'Mac' | 'unknown';
  /** Stable `<client>:<box>` slug — the dedup / rate-limit key for the receiver. */
  boxId: string;
}

/** Lowercase, punctuation-free slug safe to use as a counter key. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function envValue(...names: string[]): string {
  for (const name of names) {
    const v = (process.env[name] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * The client this box serves.
 *
 * Precedence (all config-driven — nothing about any specific client is compiled in):
 *   1. CC_CLIENT_NAME env — the explicit pin the installer can write.
 *   2. COMPANY_NAME env — the name company-config.ts already reads.
 *   3. config/company-config.json → companyName (the box's own branding).
 *   4. UNKNOWN_CLIENT — unbranded box, or the config could not be read.
 * Unpopulated template names are rejected at every source (see TEMPLATE_CLIENT_NAMES).
 */
export function resolveClientName(): string {
  const candidates = [envValue('CC_CLIENT_NAME'), envValue('COMPANY_NAME')];
  try {
    candidates.push(getCompanyName());
  } catch {
    /* config unreadable — fall through to UNKNOWN_CLIENT (fail-open) */
  }
  for (const candidate of candidates) {
    const name = (candidate ?? '').trim();
    if (!name) continue;
    if (TEMPLATE_CLIENT_NAMES.has(name.toLowerCase())) continue;
    return name;
  }
  return UNKNOWN_CLIENT;
}

/** This box's name: an explicit pin, else the hostname, else UNKNOWN_BOX. */
export function resolveBoxName(): string {
  const pinned = envValue('CC_BOX_NAME', 'OPENCLAW_BOX_NAME');
  if (pinned) return pinned;
  try {
    const host = os.hostname().trim();
    if (host) return host;
  } catch {
    /* hostname unavailable — fail-open below */
  }
  return UNKNOWN_BOX;
}

/**
 * VPS (Docker/Hostinger) vs Mac (bare install). Mirrors the same `/data/.openclaw`
 * probe notify.ts already uses to locate the workspace, so the two agree on what
 * kind of box they are running on.
 */
export function resolveBoxType(): BoxIdentity['boxType'] {
  const pinned = envValue('CC_BOX_TYPE');
  if (pinned === 'VPS' || pinned === 'Mac') return pinned;
  try {
    if (fs.statSync('/data/.openclaw').isDirectory()) return 'VPS';
  } catch {
    /* not a VPS/Docker box — fall through */
  }
  if (process.platform === 'darwin') return 'Mac';
  return 'unknown';
}

/**
 * Resolve the full identity of this box. NEVER throws: on any failure the caller
 * still gets a usable (if anonymous) identity, so the escalation always goes out.
 *
 * Not cached: env/config can change under a long-lived Next.js server, and this
 * runs at most once per escalation — a file stat is not the hot path.
 */
export function resolveBoxIdentity(): BoxIdentity {
  let clientName = UNKNOWN_CLIENT;
  let boxName = UNKNOWN_BOX;
  let boxType: BoxIdentity['boxType'] = 'unknown';
  try {
    clientName = resolveClientName();
    boxName = resolveBoxName();
    boxType = resolveBoxType();
  } catch {
    /* fail-OPEN: identity is metadata on an alarm and must never suppress it */
  }
  return {
    clientName,
    boxName,
    boxType,
    boxId: `${slugify(clientName) || UNKNOWN_CLIENT}:${slugify(boxName) || UNKNOWN_BOX}`,
  };
}

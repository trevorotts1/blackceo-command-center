/**
 * company-mirror.ts — best-effort DERIVED mirror of company-level interview
 * answers into config/company-config.json (the file /settings/company edits and
 * the CEO Board reads).
 *
 * WHY: identity/operations answers (company name, industry, command center
 * name) were previously recorded ONLY in the interview transcript; the
 * dashboard kept rendering its template values until an operator re-typed them
 * in Settings. This helper closes that seam so the surface the owner unlocks at
 * closeout already carries the facts they gave in the interview.
 *
 * DOCTRINE (same as every interview mirror):
 *   • The interview FILES stay the single source of truth. This mirror is
 *     derived, display-facing state — a failure here NEVER unwinds or blocks
 *     the canonical transcript/state writes (callers wrap in try/catch and only
 *     report a warning).
 *   • Writes are atomic (temp + rename) and MERGE into the existing file,
 *     preserving KPIs / departments / weights — byte-parity with the
 *     POST /api/company/config route's editable-subset write.
 *   • The repo copy of config/company-config.json must remain template (the
 *     config-guard CI enforces that); this module only ever runs at runtime on
 *     a provisioned box.
 */

import fs from 'fs';
import path from 'path';
import { invalidateCompanyConfigCache } from '@/lib/company-config';

/** The interview-writable subset (mirrors the /api/company/config allow-list). */
export interface CompanyMirrorPatch {
  companyName?: string;
  industry?: string;
  commandCenterName?: string;
}

function configPath(): string {
  return path.join(process.cwd(), 'config', 'company-config.json');
}

/**
 * Merge the given fields into company-config.json. Returns true when the write
 * landed, false when it was skipped/failed (callers treat both as non-fatal).
 * Empty values are ignored — the mirror never blanks a configured field.
 */
export function mirrorCompanyAnswer(patch: CompanyMirrorPatch): boolean {
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'string' && v.trim()) updates[k] = v.trim();
  }
  if (Object.keys(updates).length === 0) return false;

  const p = configPath();
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(p)) {
      existing = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // Unreadable existing file: start from an empty object rather than failing —
    // identical posture to the settings route.
    existing = {};
  }

  try {
    const merged = { ...existing, ...updates };
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, p);
    invalidateCompanyConfigCache();
    return true;
  } catch {
    return false;
  }
}

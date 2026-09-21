/**
 * departments-payload.ts — the ONE normalizer every TypeScript reader of
 * `departments.json` uses.
 *
 * MIRRORED, RULE FOR RULE, from `shared-utils/departments_payload.py` (itself a
 * mirror of openclaw-onboarding v25.1.57). The Python installer scripts and this
 * app read the SAME artifact off the SAME box, so they must agree on its shape;
 * change one only by re-mirroring the others.
 *
 * WHY THIS EXISTS
 * ---------------
 * `departments.json` ships in two legitimate top-level shapes:
 *
 *   1. a bare LIST of department entries — what a first-ever workforce build
 *      writes; and
 *   2. an OBJECT wrapping that list under a `departments` key — the retirement
 *      script's `{removedWithProvenance, departments}` audit trail, and the
 *      build's `{company, total_departments, total_roles, departments}` envelope.
 *
 * Every reader handled shape 2 wrong, in one of two ways:
 *
 *   - `reseedWorkspacesFromConfig()` gated on `Array.isArray` and reported a
 *     perfectly valid wrapped artifact as `malformed`, so the board rendered NO
 *     department columns — a false negative on a healthy box.
 *   - `preview/page.tsx` folded ANY object's KEYS in as department ids, so the
 *     metadata envelope rendered four phantom departments literally named
 *     Company, Total Departments, Total Roles and Departments. That is the same
 *     defect that seeded four bogus workspaces onto a client board on 2026-08-07.
 *
 * So: unwrap the envelope here, at the single shape boundary, and REFUSE any
 * object that carries no usable department list. A dict's metadata keys are
 * never departments.
 *
 * This module decides the ENVELOPE layer only. Per-entry coercion (bare strings,
 * a missing `name`, a `slug`/`dept`/`key` alias for `id`) stays with the caller
 * that needs it.
 */

/** The envelope layer's verdict. `ok: false` carries an operator-readable reason. */
export type DepartmentsPayload =
  | { ok: true; departments: unknown[] }
  | { ok: false; reason: string };

function describe(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  if (typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>);
    const shown = keys.slice(0, 8).map((k) => JSON.stringify(k)).join(', ');
    const more = keys.length > 8 ? `, ... (+${keys.length - 8} more)` : '';
    return `object with keys [${shown}${more}]`;
  }
  return typeof data;
}

/**
 * Return the department list a parsed `departments.json` payload carries.
 *
 * Accepted shapes, mirroring `normalize_departments()`:
 *   - `[entry, ...]`                      → the list itself
 *   - `{ departments: [entry, ...], … }`  → the wrapped list
 *   - `{ "<slug>": {…}, … }`              → folded to a list with the key as `id`,
 *     ONLY when the object is non-empty and EVERY value is an object. A scalar
 *     value (a company name, a role count) marks the object as a metadata
 *     envelope, never a department map.
 *
 * Anything else is refused. `path` is echoed into the reason so an operator can
 * find the file.
 */
export function normalizeDepartmentsPayload(data: unknown, path?: string): DepartmentsPayload {
  const where = path ? ` (path: ${path})` : '';

  if (Array.isArray(data)) return { ok: true, departments: data };

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    if ('departments' in obj) {
      const wrapped = obj.departments;
      if (Array.isArray(wrapped)) return { ok: true, departments: wrapped };
      return {
        ok: false,
        reason: `departments.json: 'departments' key holds ${describe(wrapped)}, expected an array${where}`,
      };
    }

    const values = Object.values(obj);
    if (values.length > 0 && values.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      return {
        ok: true,
        departments: Object.entries(obj).map(([key, value]) => ({
          ...(value as Record<string, unknown>),
          id: (value as Record<string, unknown>).id ?? key,
        })),
      };
    }
  }

  return {
    ok: false,
    reason:
      `departments.json: expected an array, or an object with a 'departments' array; ` +
      `got ${describe(data)}${where}`,
  };
}

/**
 * Lenient `normalizeDepartmentsPayload` for readers that must render a verdict
 * rather than fail. A malformed payload logs one loud line and yields `[]` —
 * which is the empty result those callers already produce. Use the strict form
 * anywhere the alternative is writing garbage to a client's board.
 */
export function departmentsOrEmpty(data: unknown, path?: string): unknown[] {
  const result = normalizeDepartmentsPayload(data, path);
  if (!result.ok) {
    console.error(`  [departments.json] MALFORMED: ${result.reason}`);
    return [];
  }
  return result.departments;
}

/**
 * departments-payload.ts — the ONE normalizer every TypeScript reader of
 * `departments.json` uses.
 *
 * MIRRORED, RULE FOR RULE, from `shared-utils/departments_payload.py` (itself a
 * mirror of openclaw-onboarding's copy). The Python installer scripts and this
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
 * That `departments` key holds an ARRAY in some builds and a MAP KEYED BY
 * DEPARTMENT SLUG in others — `{"account-management-dept": {…},
 * "app-development-dept": {…}, …}` is what a real 34-department client box
 * ships. Both are valid; the map is folded into an array here.
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
 * True when `value` is a NON-EMPTY plain object whose every value is a plain
 * object. A scalar value (a company name, a role count) marks the object as a
 * metadata envelope, never a department map. An EMPTY object is not one either:
 * the shipped empty default is `[]`, and the provisioning completeness gate
 * treats `{}` as invalid on purpose.
 */
function isDepartmentMap(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const values = Object.values(value as Record<string, unknown>);
  return (
    values.length > 0 &&
    values.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
  );
}

const DEPT_SUFFIX = '-dept';

/** The first value that is a non-empty string, trimmed. `null` if none is. */
function firstSlug(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Fold a slug-keyed department map into a list, PRESERVING key order.
 *
 * The ENTRY'S OWN IDENTITY WINS, in this precedence:
 *
 *     id  ->  slug  ->  folder  ->  the map key
 *
 * The map key is used ONLY when the entry carries none of the three, and a slug
 * taken FROM THE KEY has a trailing `-dept` removed. An entry's own value is
 * NEVER rewritten — not trimmed, not stripped.
 *
 * Why the key loses: a real client artifact is keyed `<name>-dept` while each
 * entry names its actual folder, e.g. key `account-management-dept` holding
 * `{"name": "Account Management", "folder": "account-management", …}`. Folding
 * on the key alone slugged all 34 departments `…-dept` while seed-workspaces.py
 * read the bare slug off the entry — two readers, two slugs for one department,
 * and since only a `dept-` PREFIX is canonicalized away, nothing collapsed the
 * pair: the board gained a duplicate workspace row per department (40 → 74).
 *
 * `id` and `slug` are filled from the resolved slug only when the entry carries
 * none of its own.
 */
function foldKeyed(map: Record<string, Record<string, unknown>>): unknown[] {
  return Object.entries(map).map(([key, value]) => {
    let resolved = firstSlug(value.id, value.slug, value.folder);
    if (resolved === null) {
      resolved = key.trim();
      if (resolved.endsWith(DEPT_SUFFIX) && resolved.length > DEPT_SUFFIX.length) {
        resolved = resolved.slice(0, -DEPT_SUFFIX.length);
      }
    }
    return {
      ...value,
      id: firstSlug(value.id) === null ? resolved : value.id,
      slug: firstSlug(value.slug) === null ? resolved : value.slug,
    };
  });
}

/**
 * Return the department list a parsed `departments.json` payload carries.
 *
 * Accepted shapes, mirroring `normalize_departments()`:
 *   - `[entry, ...]`                          → the list itself
 *   - `{ departments: [entry, ...], … }`      → the wrapped list
 *   - `{ departments: { "<slug>": {…}, … }, … }` → the wrapped department MAP,
 *     folded by the same rule as a top-level one
 *   - `{ "<slug>": {…}, … }`                  → folded to a list, ONLY when the
 *     object is non-empty and EVERY value is an object. A scalar value (a
 *     company name, a role count) marks the object as a metadata envelope, never
 *     a department map.
 *
 * Folding resolves each entry's slug as `id` → `slug` → `folder` → the map key,
 * so the ENTRY's own identity wins; see `foldKeyed`. Key order is preserved.
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
      // The envelope a real client box ships carries its 34 departments as a
      // MAP KEYED BY SLUG under this key, not as an array. Fold it by the same
      // rule as a top-level map — one rule, so the two cannot drift.
      if (isDepartmentMap(wrapped)) return { ok: true, departments: foldKeyed(wrapped) };
      if (wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        return {
          ok: false,
          reason:
            `departments.json: 'departments' key holds an object that is not a department ` +
            `map (it is empty, or a value is not an object); expected an array, or an ` +
            `object keyed by department slug whose values are all objects${where}`,
        };
      }
      return {
        ok: false,
        reason: `departments.json: 'departments' key holds ${describe(wrapped)}, expected an array${where}`,
      };
    }

    if (isDepartmentMap(obj)) return { ok: true, departments: foldKeyed(obj) };
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

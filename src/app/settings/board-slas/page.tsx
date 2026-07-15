import { Breadcrumb } from '@/components/Breadcrumb';
import {
  loadBoardSlaConfig,
  invalidateBoardSlaConfigCache,
  buildEffectiveSlaTable,
  BOARD_SLA_KEYS,
  BOARD_SLA_LABEL,
  BOARD_SLA_ENV_VAR,
  type BoardSlaOverrides,
} from '@/lib/board-slas';
import { BOARD_HYGIENE_GLOBAL_DEFAULTS } from '@/lib/jobs/board-hygiene';
import { STALE_TASK_SWEEP_GLOBAL_DEFAULTS } from '@/lib/jobs/stale-task-sweep';
import { loadDepartments } from '@/lib/routing/departments.config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /settings/board-slas — U101, per-department Service-Level table.
 *
 * READ-ONLY by design (per the unit's acceptance criterion c): this surface
 * exists so the operator can SEE the active effective threshold per
 * department, not to edit it in-app. Edits go through config/board-slas.json
 * directly (see config/README.md) — env var still wins for global
 * emergencies (see src/lib/board-slas.ts's precedence contract).
 *
 * Server component: reads config/board-slas.json + the two jobs' global
 * defaults + the department list directly, no client fetch needed for a
 * read-only table.
 */
export default function BoardSlasSettingsPage() {
  invalidateBoardSlaConfigCache(); // always render the current on-disk config
  const { warnings, sourcePresent } = loadBoardSlaConfig();

  const globalDefaults: Record<keyof BoardSlaOverrides, number> = {
    ...BOARD_HYGIENE_GLOBAL_DEFAULTS,
    ...STALE_TASK_SWEEP_GLOBAL_DEFAULTS,
  };

  let departmentSlugs: string[] = [];
  try {
    departmentSlugs = loadDepartments().map((d) => d.id);
  } catch {
    departmentSlugs = []; // fail-closed: render just the default row
  }

  const rows = buildEffectiveSlaTable(departmentSlugs, globalDefaults);

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <h1 className="text-page-title text-gray-900">Board SLAs</h1>
          <p className="text-base text-gray-600 mt-1">
            Per-department lane thresholds (read-only). Edit <code>config/board-slas.json</code> to change overrides.
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8 space-y-6">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Settings', href: '/settings' },
            { label: 'Board SLAs' },
          ]}
        />

        {!sourcePresent && (
          <div className="rounded-xl border border-gray-200 bg-white p-4 text-base text-gray-600">
            No <code>config/board-slas.json</code> found (or it could not be parsed) — every department is using the
            global default below. This is expected, safe, byte-identical behavior; add department entries to that
            file to override.
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-base text-amber-900 space-y-1">
            <p className="font-medium">Some entries in config/board-slas.json were ignored (fail-closed):</p>
            <ul className="list-disc list-inside space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-base" data-testid="board-slas-table">
              <thead className="bg-gray-50 text-gray-600 text-sm uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 sticky left-0 bg-gray-50">Department</th>
                  {BOARD_SLA_KEYS.map((key) => (
                    <th key={key} className="px-4 py-3 whitespace-nowrap" title={`env: ${BOARD_SLA_ENV_VAR[key]}`}>
                      {BOARD_SLA_LABEL[key]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.department} className={row.isDefault ? 'bg-gray-50/60 font-medium' : ''}>
                    <td className="px-4 py-3 sticky left-0 bg-inherit whitespace-nowrap">{row.department}</td>
                    {BOARD_SLA_KEYS.map((key) => {
                      const overridden = row.overriddenKeys.includes(key);
                      return (
                        <td
                          key={key}
                          className={`px-4 py-3 whitespace-nowrap ${overridden ? 'text-brand-700 font-semibold' : 'text-gray-700'}`}
                        >
                          {row.values[key]}
                          {overridden && <span className="ml-1 text-xs text-brand-600">(override)</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-sm text-gray-500">
          Precedence: an explicit environment variable (named in each column&apos;s tooltip) always wins for every
          department (global emergency override) — otherwise a department&apos;s entry in{' '}
          <code>config/board-slas.json</code> applies, otherwise the fleet default shown on the{' '}
          <span className="font-medium">(default)</span> row.
        </p>
      </div>
    </div>
  );
}

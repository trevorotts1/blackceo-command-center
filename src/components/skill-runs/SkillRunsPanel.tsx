'use client';

/**
 * SkillRunsPanel: Skill 71 (blackceo-signature-page) runs on the board.
 *
 * Fix plan Item 26: the web-development department board shows every
 * Skill 71 run the Command Center has received events for (ingestion:
 * scripts/import-skill71-runs.ts on the file transport, POST
 * /api/skill-runs/ingest on the HTTP transport; reads go through GET
 * /api/skill-runs, database only).
 *
 * The panel's honesty rules, from the plan:
 *   - Review mode is impossible to miss: SELF-REVIEWED runs carry a red
 *     flag, UNKNOWN review mode an amber one. A run that reviewed itself
 *     must never read as equivalent to an independently reviewed one.
 *   - host_shape prints on every run. Coverage is shape-dependent by
 *     design (fleet-mac is local unless opted in), so the board shows
 *     WHICH fleet each run came from instead of pretending the list is
 *     the whole fleet.
 *   - A blocked stage is named, in red, with its gate failure lines one
 *     click away. A stalled run is visible, not silent.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';

interface StageRow {
  stage: string;
  status: string;
  receipt_status: string | null;
  closed_at: string | null;
  duration_s: number | null;
  artifact_hashes: Record<string, string> | null;
  failures: string[] | null;
}

interface RunSummary {
  run_id: string;
  page_name: string | null;
  brand_id: string | null;
  client: string | null;
  client_slug: string | null;
  host_shape: string | null;
  run_dir: string | null;
  test_run: number;
  overall: string;
  review_mode: string | null;
  report_md_path: string | null;
  blocked_stage: string | null;
  started_at: string | null;
  last_event_at: string | null;
  stages_closed: number;
  stages_total: number;
  cost_by_provider: Record<string, number>;
  review_flag: 'SELF-REVIEWED' | 'UNKNOWN' | null;
}

interface RunDetail {
  run: RunSummary;
  stages: StageRow[];
}

const OVERALL_STYLES: Record<string, string> = {
  complete: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  incomplete: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  'test-run': 'bg-sky-500/15 text-sky-300 border-sky-400/30',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
}

function ReviewFlag({ run }: { run: RunSummary }) {
  if (run.review_flag === 'SELF-REVIEWED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-500/15 px-2 py-0.5 text-[11px] font-bold text-red-300">
        <ShieldAlert className="h-3 w-3" /> SELF-REVIEWED
      </span>
    );
  }
  if (run.review_flag === 'UNKNOWN') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-300">
        <ShieldQuestion className="h-3 w-3" /> REVIEW MODE UNKNOWN
      </span>
    );
  }
  if (run.review_mode === 'INDEPENDENT') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
        <ShieldCheck className="h-3 w-3" /> INDEPENDENT REVIEW
      </span>
    );
  }
  return null;
}

const FOUR_IMAGE_PATHS = [
  { label: 'Desktop wireframe', glob: 'desktop-wireframe/section-*.png' },
  { label: 'Mobile wireframe', glob: 'mobile-tablet/section-*.png' },
  { label: 'Desktop mockup', glob: 'final-mockups/desktop/part-*.png' },
  { label: 'Mobile mockup', glob: 'final-mockups/mobile/part-*.png' },
] as const;

/** Run-folder-relative artifact path against the contract's glob. */
function artifactMatches(path: string, glob: string): boolean {
  const source = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Fix 12.2: the four images a page must carry, rendered from
 * artifact_hashes (which the run detail already serves). The panel never
 * serves bytes: Fix 12.5 defers the media route until the artifacts exist.
 */
function FourImageSet({ stages }: { stages: StageRow[] }) {
  const paths: string[] = [];
  for (const stage of stages) {
    for (const path of Object.keys(stage.artifact_hashes ?? {})) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <p className="text-[11px] font-bold uppercase tracking-widest text-white/50">
        Four images
      </p>
      <ul className="mt-2 space-y-1">
        {FOUR_IMAGE_PATHS.map(({ label, glob }) => {
          const matched = paths.filter((path) => artifactMatches(path, glob)).sort();
          return (
            <li key={glob} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="text-white/60">{label}</span>
              {matched.length > 0 ? (
                matched.map((path) => (
                  <code
                    key={path}
                    className="break-all font-mono text-[11px] text-white/70"
                  >
                    {path}
                  </code>
                ))
              ) : (
                <span className="font-semibold text-amber-300">missing</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StageDots({ detail }: { detail: RunDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {detail.stages.map((s) => {
        const notAuthorized =
          s.status === 'closed' && s.receipt_status === 'not_authorized';
        const color = notAuthorized
          ? 'bg-amber-400'
          : s.status === 'closed'
            ? 'bg-emerald-400'
            : s.status === 'blocked'
              ? 'bg-red-400'
              : 'bg-white/20';
        return (
          <span
            key={s.stage}
            title={`${s.stage}: ${notAuthorized ? 'closed (NOT AUTHORIZED)' : s.status}`}
            className={`h-2.5 w-2.5 rounded-full ${color}`}
          />
        );
      })}
    </div>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (!open && !detail) {
      try {
        const resp = await fetch(`/api/skill-runs?run_id=${encodeURIComponent(run.run_id)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setDetail((await resp.json()) as RunDetail);
      } catch {
        setDetailError('Could not load stage detail.');
      }
    }
    setOpen((v) => !v);
  }, [open, detail, run.run_id]);

  const costs = Object.entries(run.cost_by_provider);
  const blockedStage = detail?.stages.find((s) => s.status === 'blocked');

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <button onClick={toggle} className="flex w-full items-start gap-3 text-left">
        <span className="mt-0.5 text-white/40">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-white">
              {run.page_name ?? `Run ${run.run_id.slice(0, 8)}`}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${OVERALL_STYLES[run.overall] ?? OVERALL_STYLES.incomplete}`}
            >
              {run.overall.toUpperCase()}
            </span>
            {run.test_run === 1 && (
              <span className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-white/60">
                TEST RUN
              </span>
            )}
            <ReviewFlag run={run} />
          </span>
          <span className="mt-1 block text-xs text-white/50">
            {[run.brand_id, run.client ?? run.client_slug, run.host_shape]
              .filter(Boolean)
              .join(' · ')}
            {run.started_at ? ` · started ${formatWhen(run.started_at)}` : ''}
            {run.last_event_at ? ` · last event ${formatWhen(run.last_event_at)}` : ''}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-3 text-xs text-white/60">
            <span>
              {run.stages_closed}/{run.stages_total} stages closed
            </span>
            {run.blocked_stage && (
              <span className="inline-flex items-center gap-1 font-semibold text-red-300">
                <AlertTriangle className="h-3 w-3" /> blocked at {run.blocked_stage}
              </span>
            )}
            {costs.map(([provider, used]) => (
              <span key={provider}>
                {provider}: {used.toFixed(2)} credits
              </span>
            ))}
          </span>
        </span>
      </button>

      {open && (
        <div className="mt-3 border-t border-white/10 pt-3 pl-7">
          {detailError && <p className="text-xs text-red-300">{detailError}</p>}
          {!detail && !detailError && <p className="text-xs text-white/40">Loading stages…</p>}
          {detail && (
            <>
              <StageDots detail={detail} />
              <FourImageSet stages={detail.stages} />
              <ul className="mt-3 space-y-1">
                {detail.stages.map((s) => (
                  <li key={s.stage} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span
                      className={
                        s.status === 'closed' && s.receipt_status === 'not_authorized'
                          ? 'text-amber-300'
                          : s.status === 'closed'
                            ? 'text-emerald-300'
                            : s.status === 'blocked'
                              ? 'font-semibold text-red-300'
                              : 'text-white/40'
                      }
                    >
                      {s.stage}
                    </span>
                    {s.receipt_status === 'not_authorized' ? (
                      <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                        NOT AUTHORIZED
                      </span>
                    ) : (
                      <span className="text-white/40">{s.status}</span>
                    )}
                    {s.closed_at && (
                      <span className="text-white/30">{formatWhen(s.closed_at)}</span>
                    )}
                    {s.failures?.map((f, i) => (
                      <span key={i} className="block w-full pl-3 text-red-200/80">
                        {f}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
              {blockedStage && (
                <p className="mt-2 text-xs text-red-300">
                  Blocked at {blockedStage.stage}: the gate refused the close; the failure
                  lines above are its reasons, verbatim.
                </p>
              )}
              {run.report_md_path ? (
                <p className="mt-3 flex flex-wrap items-baseline gap-1 text-xs text-white/50">
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="text-white/60">REPORT.md</span>
                  <span className="break-all font-mono text-white/40">{run.report_md_path}</span>
                  {run.host_shape && (
                    <span className="text-white/40">on host {run.host_shape}</span>
                  )}
                </p>
              ) : (
                <p className="mt-3 text-xs text-white/30">
                  No report generated yet for this run.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillRunsPanel() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [shapeFilter, setShapeFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter) params.set('status', statusFilter);
      if (shapeFilter) params.set('host_shape', shapeFilter);
      const resp = await fetch(`/api/skill-runs?${params.toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { runs: RunSummary[] };
      setRuns(data.runs);
      setError(null);
    } catch {
      setError('Could not load Skill 71 runs.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, shapeFilter]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const selfReviewed = runs.filter((r) => r.review_flag === 'SELF-REVIEWED').length;

  return (
    <div className="rounded-2xl border border-white/10 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-widest text-white/70">
            Signature Page Runs · Skill 71
          </h3>
          <p className="mt-1 text-xs text-white/40">
            Every run the Command Center has received gate events for. fleet-mac runs appear
            only when that Mac&apos;s deployment opted into visibility; an absent fleet-mac
            run is expected, not missing data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-white/15 bg-transparent px-2 py-1 text-xs text-white/70"
          >
            <option value="">All statuses</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
            <option value="test-run">Test runs</option>
          </select>
          <select
            value={shapeFilter}
            onChange={(e) => setShapeFilter(e.target.value)}
            className="rounded-lg border border-white/15 bg-transparent px-2 py-1 text-xs text-white/70"
          >
            <option value="">All fleets</option>
            <option value="fleet-mac">fleet-mac</option>
            <option value="fleet-hostinger">fleet-hostinger</option>
            <option value="fleet-contabo">fleet-contabo</option>
          </select>
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70 hover:text-white"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {selfReviewed > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200">
          <ShieldAlert className="h-4 w-4" />
          {selfReviewed} run{selfReviewed === 1 ? '' : 's'} on this board reviewed{' '}
          {selfReviewed === 1 ? 'itself' : 'themselves'}: no independent reviewer.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {loading && <p className="text-sm text-white/40">Loading runs…</p>}
        {error && <p className="text-sm text-red-300">{error}</p>}
        {!loading && !error && runs.length === 0 && (
          <p className="text-sm text-white/40">
            No Skill 71 runs have been delivered yet. Runs appear when their gate events are
            imported (fleet-contabo file transport) or pushed (fleet-hostinger, or an
            opted-in fleet-mac).
          </p>
        )}
        {runs.map((run) => (
          <RunRow key={run.run_id} run={run} />
        ))}
      </div>
    </div>
  );
}

'use client';

/**
 * Setup readiness panel (T-31).
 *
 * Renders exactly what the server computed: one row per item with the state,
 * the evidence that decided it, and — when blocked — the reason. Owner actions
 * that cannot succeed are rendered DISABLED with their reason shown, so the
 * operator never clicks something that quietly does nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, XCircle } from 'lucide-react';

import type {
  OwnerAction,
  ReadinessEvidence,
  ReadinessItem,
  ReadinessState,
  SetupReadiness,
} from '@/lib/readiness/types';

const STATE_STYLE: Record<
  ReadinessState,
  { badge: string; row: string; icon: React.ReactNode; text: string }
> = {
  READY: {
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    row: 'border-bcc-border bg-bcc-white',
    icon: <CheckCircle2 className="w-4 h-4" aria-hidden />,
    text: 'Ready',
  },
  BLOCKED: {
    badge: 'bg-red-100 text-red-800 border-red-200',
    row: 'border-red-200 bg-red-50',
    icon: <XCircle className="w-4 h-4" aria-hidden />,
    text: 'Blocked',
  },
  // Deliberately NOT green and deliberately not red: unknown is its own state,
  // and it must never read as a pass.
  UNKNOWN: {
    badge: 'bg-amber-100 text-amber-900 border-amber-300',
    row: 'border-amber-200 bg-amber-50',
    icon: <HelpCircle className="w-4 h-4" aria-hidden />,
    text: 'Unknown',
  },
};

/**
 * What counts as evidence behind a claim: a real evidence object carrying a
 * probe that names what ran. An EMPTY object is not evidence — it is a blank
 * where the claim would have to stand — and neither is an empty or absent probe
 * name, because a claim nobody can check is not backed. Mirrors the
 * observed-empty rule in src/lib/readiness/setup.ts, and is the single
 * definition every read-side check below consults.
 */
function hasEvidence(item: ReadinessItem): boolean {
  const evidence = item.evidence as Partial<ReadinessEvidence> | null | undefined;
  if (!evidence || Object.keys(evidence).length === 0) return false;
  const probe = evidence.probe;
  return typeof probe === 'string' && probe.trim().length > 0;
}

function EvidenceLine({ item }: { item: ReadinessItem }) {
  // A row whose evidence is missing must still render: it says so, instead of
  // throwing and blanking the whole panel. An empty evidence object, or one
  // with no probe name, is the same case — there is nothing there to show.
  if (!hasEvidence(item)) {
    return (
      <p className="mt-1 text-xs text-bcc-text-muted break-words">
        <span className="font-mono">no evidence recorded</span>
      </p>
    );
  }
  const { probe, observed, at } = item.evidence;
  const observedText = JSON.stringify(observed ?? {});
  return (
    <p className="mt-1 text-xs text-bcc-text-muted break-words">
      <span className="font-mono">{probe}</span>
      {' · '}
      <span className="font-mono">{observedText}</span>
      {' · '}
      <span>{at}</span>
    </p>
  );
}

/** Exported for the T-31 unit test: this is the row render, nothing else. */
export function ItemRow({ item }: { item: ReadinessItem }) {
  // A row with no evidence cannot back any claim — it reads UNKNOWN even if the
  // payload says READY. Fail-closed on the read side too. "No evidence" is
  // hasEvidence(): an empty evidence object and an empty/absent probe name are
  // both a claim with nothing behind it.
  const state: ReadinessState = hasEvidence(item) ? item.state : 'UNKNOWN';
  const style = STATE_STYLE[state];
  return (
    <li className={`rounded-xl border p-4 ${style.row}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-bcc-text">{item.label}</p>
          <p className="text-xs text-bcc-text-secondary">{item.group}</p>
          {state === 'BLOCKED' && item.reason && (
            <p className="mt-1 text-sm text-red-800">{item.reason}</p>
          )}
          <EvidenceLine item={item} />
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${style.badge}`}
        >
          {style.icon}
          {style.text}
        </span>
      </div>
    </li>
  );
}

const STATE_RANK: Record<ReadinessState, number> = { READY: 0, UNKNOWN: 1, BLOCKED: 2 };

/**
 * The header badge for a payload. Fail-closed on the read side:
 *   • zero rows is NOT a pass — an empty item set reads UNKNOWN;
 *   • a row with no evidence reads UNKNOWN, so it cannot leave READY at the top;
 *   • the badge is the WORST of the payload's `overall` and what the rows
 *     actually support — this surface never paints a claim it cannot back.
 * "No evidence" is hasEvidence(): an empty evidence object and an empty/absent
 * probe name are both a claim with nothing behind it.
 * Exported for the T-31 unit test — this is the exact expression the header
 * renders from.
 */
export function resolveOverallBadge(readiness: SetupReadiness | null): ReadinessState | null {
  if (!readiness) return null;
  const rowStates = readiness.items.map((item) => (hasEvidence(item) ? item.state : 'UNKNOWN'));
  const states: ReadinessState[] = rowStates.length > 0 ? rowStates : ['UNKNOWN'];
  states.push(readiness.overall);
  return states.reduce((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst));
}

/** The explicit empty state. Exported so the T-31 unit test can render it. */
export function EmptyReadinessNotice() {
  return (
    <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
      No readiness rows were computed — this surface is Unknown, not Ready.
    </p>
  );
}

function ActionButton({
  action,
  busy,
  onRun,
}: {
  action: OwnerAction;
  busy: boolean;
  onRun: (id: OwnerAction['id']) => void;
}) {
  return (
    <li className="rounded-xl border border-bcc-border bg-bcc-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-bcc-text">{action.label}</p>
          <p className="text-xs text-bcc-text-secondary">{action.description}</p>
          {!action.enabled && (
            <p className="mt-1 text-xs font-semibold text-amber-900">
              Cannot run: <span className="font-mono">{action.disabledReason ?? 'unavailable'}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRun(action.id)}
          disabled={!action.enabled || busy}
          title={action.enabled ? undefined : action.disabledReason}
          className="shrink-0 rounded-lg border border-bcc-border px-3 py-1.5 text-sm font-semibold text-bcc-text enabled:hover:bg-bcc-border-light disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
    </li>
  );
}

export default function SetupReadinessPanel() {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/readiness', { cache: 'no-store' });
      const body = (await res.json()) as SetupReadiness & { error?: string; detail?: string };
      if (!res.ok) {
        setError(body.error ? `${body.error}: ${body.detail ?? ''}`.trim() : `http_${res.status}`);
        return;
      }
      setError(null);
      setReadiness(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request_failed');
    }
  }, []);

  useEffect(() => {
    // One-shot read of a server-computed surface on mount. The rule's
    // "subscribe to an external system" shape does not apply here — there is
    // nothing to subscribe to, and polling readiness would be wasted work.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const run = useCallback(
    async (action: OwnerAction['id']) => {
      setBusyAction(action);
      setNotice(null);
      try {
        const res = await fetch('/api/setup/readiness', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json()) as {
          result?: { applied: boolean; detail: string };
          readiness?: SetupReadiness;
          error?: string;
          detail?: string;
        };
        if (body.result) {
          setNotice(
            `${action}: ${body.result.applied ? 'applied' : 'refused'} — ${body.result.detail}`,
          );
        } else {
          setNotice(`${action}: ${body.error ?? `http_${res.status}`} ${body.detail ?? ''}`.trim());
        }
        if (body.readiness) setReadiness(body.readiness);
      } catch (err) {
        setNotice(`${action}: ${err instanceof Error ? err.message : 'request_failed'}`);
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const items = readiness?.items ?? [];
  const overall = resolveOverallBadge(readiness);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-bcc-text">Setup readiness</h1>
          <p className="mt-1 text-sm text-bcc-text-secondary">
            Each row is decided by a probe that actually ran. Unknown is never treated as ready.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overall && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${STATE_STYLE[overall].badge}`}
            >
              {STATE_STYLE[overall].icon}
              {STATE_STYLE[overall].text}
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-bcc-border px-3 py-1.5 text-sm font-semibold text-bcc-text hover:bg-bcc-border-light"
          >
            <RefreshCw className="w-4 h-4" aria-hidden />
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" aria-hidden />
          <span>Readiness could not be read: {error}</span>
        </div>
      )}

      {notice && (
        <p className="rounded-xl border border-bcc-border bg-bcc-white p-3 text-sm text-bcc-text">
          {notice}
        </p>
      )}

      {!readiness && !error && <p className="text-sm text-bcc-text-muted">Reading readiness…</p>}

      {readiness && (
        <>
          {readiness && items.length === 0 && <EmptyReadinessNotice />}

          <ul className="grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>

          <div>
            <h2 className="text-lg font-semibold text-bcc-text">Owner actions</h2>
            <p className="mt-1 text-sm text-bcc-text-secondary">
              Only actions that can actually unblock a blocked row are enabled.
            </p>
            <ul className="mt-3 grid gap-3 md:grid-cols-2">
              {readiness.actions.map((action) => (
                <ActionButton
                  key={action.id}
                  action={action}
                  busy={busyAction === action.id}
                  onRun={(id) => void run(id)}
                />
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

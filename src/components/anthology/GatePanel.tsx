'use client';

/**
 * The producer Gate Panel (SPEC B11 / Unit U12) — rendered inside TaskModal for
 * an `task.source === 'anthology'` card. Three zones:
 *
 *   1. THE WORK      the current deliverable's PDF (primary) + editable Doc,
 *                    with the prior-stage artifact trail collapsed underneath.
 *   2. THE DECISION  EXACTLY the actions `GET /api/anthology/gate` returns for
 *                    the open gate (the one sole writer, gate_engine.py, is the
 *                    authority — no hand-maintained action table). Approve calls
 *                    `POST /api/anthology/gate` (Unit U11) and the card advances
 *                    when the mc_board mirror re-syncs.
 *   3. THE TRAIL     who did what when, from task_activities (ActivityLog).
 *
 * ENGINE-GATED FACES (flag, never fake): the cover 2×2 grid and the producer
 * "request rewrite with notes" control depend on engine gates (B8/U8, B9/U9)
 * that are not live yet, so those actions never come back from `status` on a
 * producer board card today and their faces never render. If a future engine
 * unit surfaces them, gate-actions.ts marks them `engineGated` and the panel
 * shows an honest "pending" affordance — the cover preview stays absent because
 * `status` carries no cover-style data to draw it from.
 *
 * `done` is never an action here: it is owned solely by the QC auto-scorer
 * (≥ 8.5) and the U11 route 403s it. We never render a Done control.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  FileEdit,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  History,
} from 'lucide-react';
import { ActivityLog } from '../ActivityLog';
import {
  parseAnthologyCard,
  extractArtifacts,
  type AnthologyTaskLike,
  type Artifact,
} from './anthology-card';
import {
  fetchBoardStatus,
  postGateDecision,
  orderedActions,
  decisionErrorCopy,
  type BoardStatusResult,
  type BoardDecideOk,
  type ActionPresentation,
  type DecideFields,
} from './gate-actions';

type PanelTask = AnthologyTaskLike & { id: string };

interface GatePanelProps {
  task: PanelTask;
  /** Called after a decision commits, so the modal/board can refresh or close. */
  onDecided?: () => void;
}

export function GatePanel({ task, onDecided }: GatePanelProps) {
  const card = useMemo(() => parseAnthologyCard(task), [task]);
  const subjectKey = card?.subjectKey ?? null;
  const firstName = card?.firstName ?? null;

  const artifacts = useMemo(() => extractArtifacts(task.description), [task.description]);

  const [status, setStatus] = useState<BoardStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [openAction, setOpenAction] = useState<string | null>(null);
  const [draft, setDraft] = useState<DecideFields>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<BoardDecideOk | null>(null);

  const load = useCallback(async () => {
    if (!subjectKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await fetchBoardStatus(subjectKey);
    setStatus(res);
    setLoading(false);
  }, [subjectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (action: string, fields: DecideFields) => {
      if (!subjectKey) return;
      setSubmitting(action);
      setError(null);
      const res = await postGateDecision(subjectKey, action, fields);
      setSubmitting(null);
      if (res.ok) {
        setSuccess(res);
        setOpenAction(null);
        setDraft({});
        onDecided?.();
        void load(); // reflect the advanced gate (or nothing_open) after commit
        return;
      }
      setError(decisionErrorCopy(res));
      // The gate moved under us — reload so the producer sees the live options.
      if (res.reason === 'action_not_allowed_at_gate') void load();
    },
    [subjectKey, onDecided, load]
  );

  // ── Not an anthology card / no subject linkage ────────────────────────────
  if (!card) return null;
  if (!subjectKey) {
    return (
      <PanelShell>
        <EmptyNote>
          This card is not linked to an anthology subject yet, so there is no gate
          to act on. It will link once the engine posts its first status.
        </EmptyNote>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {/* ── Zone 1: The work ─────────────────────────────────────────────── */}
      <WorkZone artifacts={artifacts} />

      {/* ── Zone 2: The decision ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <ZoneHeading>The decision</ZoneHeading>

        {success ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
              <div className="text-sm text-emerald-900">
                <p className="font-semibold">Recorded.</p>
                <p className="mt-0.5 text-emerald-800">
                  {decisionSuccessCopy(success, firstName)}
                </p>
                <p className="mt-1 text-xs text-emerald-700">
                  The board updates as the editors pick it up.
                </p>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the open gate…
          </div>
        ) : (
          <DecisionZone
            status={status}
            firstName={firstName}
            openAction={openAction}
            setOpenAction={setOpenAction}
            draft={draft}
            setDraft={setDraft}
            submitting={submitting}
            onSubmit={submit}
            onRetry={load}
          />
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}
      </section>

      {/* ── Zone 3: The trail ────────────────────────────────────────────── */}
      <section className="space-y-2">
        <ZoneHeading>
          <History className="w-4 h-4 inline-block mr-1 -mt-0.5" aria-hidden="true" />
          The trail
        </ZoneHeading>
        <div className="rounded-lg border border-gray-200 bg-white p-2">
          <ActivityLog taskId={task.id} />
        </div>
      </section>
    </PanelShell>
  );
}

// --------------------------------------------------------------------------- //
// Zone 1 — the work
// --------------------------------------------------------------------------- //

function WorkZone({ artifacts }: { artifacts: Artifact[] }) {
  const [showTrail, setShowTrail] = useState(false);
  const pdf = artifacts.find((a) => a.kind === 'pdf');
  const doc = artifacts.find((a) => a.kind === 'doc');
  const primary = pdf ?? doc ?? artifacts[0];
  const rest = artifacts.filter((a) => a !== primary && a !== pdf && a !== doc);

  return (
    <section className="space-y-2">
      <ZoneHeading>The work</ZoneHeading>
      {artifacts.length === 0 ? (
        <EmptyNote>
          No deliverable is posted for this stage yet. Once the editors post the
          PDF and Doc, they appear here; the full artifact list is on the
          Deliverables tab.
        </EmptyNote>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {pdf && (
              <ArtifactLink
                href={pdf.url}
                icon={<FileText className="w-4 h-4" />}
                label="Open the PDF"
                primary
              />
            )}
            {doc && (
              <ArtifactLink
                href={doc.url}
                icon={<FileEdit className="w-4 h-4" />}
                label="Open the editable Doc"
              />
            )}
            {!pdf && !doc && primary && (
              <ArtifactLink
                href={primary.url}
                icon={<ExternalLink className="w-4 h-4" />}
                label="Open the deliverable"
                primary
              />
            )}
          </div>

          {rest.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowTrail((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
              >
                {showTrail ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                Prior-stage artifacts ({rest.length})
              </button>
              {showTrail && (
                <ul className="mt-1.5 space-y-1 pl-4">
                  {rest.map((a) => (
                    <li key={a.url}>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline break-all"
                      >
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        {a.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ArtifactLink({
  href,
  icon,
  label,
  primary,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors no-underline ${
        primary
          ? 'bg-indigo-600 text-white hover:bg-indigo-700'
          : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {icon}
      {label}
      <ExternalLink className="w-3 h-3 opacity-70" />
    </a>
  );
}

// --------------------------------------------------------------------------- //
// Zone 2 — the decision
// --------------------------------------------------------------------------- //

function DecisionZone({
  status,
  firstName,
  openAction,
  setOpenAction,
  draft,
  setDraft,
  submitting,
  onSubmit,
  onRetry,
}: {
  status: BoardStatusResult | null;
  firstName: string | null;
  openAction: string | null;
  setOpenAction: (a: string | null) => void;
  draft: DecideFields;
  setDraft: (f: DecideFields) => void;
  submitting: string | null;
  onSubmit: (action: string, fields: DecideFields) => void;
  onRetry: () => void;
}) {
  if (!status) return null;

  if (!status.ok) {
    if (status.reason === 'unknown_subject') {
      return (
        <EmptyNote>
          This card is not linked to an anthology subject the engine knows yet.
        </EmptyNote>
      );
    }
    if (status.reason === 'not_ready') {
      return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The anthology engine is not reachable from this box yet, so no
            decision can be recorded. It will work once the engine is provisioned.
          </span>
        </div>
      );
    }
    return (
      <div className="text-sm text-gray-600">
        Could not load the open gate.{' '}
        <button type="button" onClick={onRetry} className="text-indigo-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  // ok — but no open gate / no actions => nothing to decide right now.
  if (!status.openGate || status.actions.length === 0) {
    return (
      <EmptyNote>
        No decision is waiting on you right now. This chapter is with the editors;
        it returns to your queue when the next deliverable is ready.
      </EmptyNote>
    );
  }

  const actions = orderedActions(status.actions);

  return (
    <div className="space-y-2">
      {actions.map((p) => (
        <ActionControl
          key={p.action}
          presentation={p}
          firstName={firstName}
          open={openAction === p.action}
          onOpen={() => {
            setOpenAction(openAction === p.action ? null : p.action);
            setDraft({});
          }}
          draft={draft}
          setDraft={setDraft}
          submitting={submitting === p.action}
          disabledAll={submitting !== null}
          onSubmit={onSubmit}
        />
      ))}
    </div>
  );
}

const TONE_CLASSES: Record<string, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
  secondary: 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50',
  destructive: 'bg-white border border-red-300 text-red-700 hover:bg-red-50',
};

function ActionControl({
  presentation,
  firstName,
  open,
  onOpen,
  draft,
  setDraft,
  submitting,
  disabledAll,
  onSubmit,
}: {
  presentation: ActionPresentation;
  firstName: string | null;
  open: boolean;
  onOpen: () => void;
  draft: DecideFields;
  setDraft: (f: DecideFields) => void;
  submitting: boolean;
  disabledAll: boolean;
  onSubmit: (action: string, fields: DecideFields) => void;
}) {
  const { action, tone, field, engineGated, optionalSubtitle } = presentation;
  const label = presentation.label(firstName);
  // Destructive (exclude) and any field-bearing action expand an inline confirm
  // step; a plain primary/secondary action posts on the first click.
  const needsInput = field !== null || tone === 'destructive' || engineGated === 'cover';
  const isPrimary = tone === 'primary';

  const confirm = () => onSubmit(action, draft);

  if (!needsInput) {
    return (
      <button
        type="button"
        disabled={disabledAll}
        onClick={confirm}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
          TONE_CLASSES[tone]
        } ${isPrimary ? 'w-full py-2.5 shadow-sm' : ''}`}
      >
        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
        {label}
      </button>
    );
  }

  return (
    <div className={`rounded-lg border ${open ? 'border-gray-300 bg-gray-50 p-3' : 'border-transparent'}`}>
      <button
        type="button"
        disabled={disabledAll && !open}
        onClick={onOpen}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
          TONE_CLASSES[tone]
        } ${isPrimary ? 'w-full py-2.5 shadow-sm' : ''}`}
      >
        {label}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {/* Cover 2x2 forward-stub (SPEC B11): renders ONLY when a future
              producer cover gate (U8) registers an action with
              engineGated:'cover' AND status carries its four cover-style
              images. No action carries that today, so this stays flagged and
              unrendered rather than faking a grid. */}
          {engineGated === 'cover' && (
            <p className="rounded-md bg-indigo-50 px-2.5 py-1.5 text-xs text-indigo-700">
              The four named cover styles will preview here as a grid once the
              cover gate ships. For now, confirm the current selection below.
            </p>
          )}
          {engineGated === 'rewrite' && (
            <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              Editors may rewrite a chapter up to twice. Add clear notes for them
              below.
            </p>
          )}

          {field === 'reason' && (
            <textarea
              value={draft.reason ?? ''}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
              rows={2}
              placeholder="Why is this on hold? (required)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}
          {field === 'notes' && (
            <textarea
              value={draft.notes ?? ''}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="Notes for the editors (required)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}
          {field === 'title' && (
            <>
              <input
                type="text"
                value={draft.title ?? ''}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Selected title (required)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {optionalSubtitle && (
                <input
                  type="text"
                  value={draft.subtitle ?? ''}
                  onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
                  placeholder="Subtitle (optional)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              )}
            </>
          )}
          {field === 'confirmName' && (
            <input
              type="text"
              value={draft.confirmName ?? ''}
              onChange={(e) => setDraft({ ...draft, confirmName: e.target.value })}
              placeholder="Type the anthology name to confirm (required)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}
          {tone === 'destructive' && field === null && (
            <textarea
              value={draft.reason ?? ''}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
              rows={2}
              placeholder="Reason (optional)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={submitting || !fieldSatisfied(presentation, draft)}
              onClick={confirm}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                tone === 'destructive'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Confirm
            </button>
            <button
              type="button"
              onClick={onOpen}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether the required input for a known action is present (mirror of the
 *  engine's requirement, for inline enable/disable only — the engine remains the
 *  authority and refuses `missing_fields` regardless). */
function fieldSatisfied(p: ActionPresentation, draft: DecideFields): boolean {
  switch (p.field) {
    case 'reason':
      return !!draft.reason?.trim();
    case 'notes':
      return !!draft.notes?.trim();
    case 'title':
      return !!draft.title?.trim();
    case 'confirmName':
      return !!draft.confirmName?.trim();
    default:
      return true; // destructive-with-optional-reason and no-field actions
  }
}

// --------------------------------------------------------------------------- //
// Shared bits
// --------------------------------------------------------------------------- //

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-indigo-700">
          Gate Panel
        </span>
      </div>
      {children}
    </div>
  );
}

function ZoneHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-sm font-semibold text-gray-900">{children}</h4>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}

function decisionSuccessCopy(res: BoardDecideOk, firstName: string | null): string {
  const who = firstName || 'the author';
  switch (res.decision) {
    case 'approve':
      return `Approved and released to ${who}.`;
    case 'hold':
      return 'Placed on hold.';
    case 'exclude':
      return 'Excluded from this anthology.';
    case 'escalate':
      return 'Escalated to you.';
    case 'request_rewrite':
      return 'Rewrite requested; the notes are with the editors.';
    case 'ready_to_assemble':
      return 'Armed for assembly.';
    default:
      return 'Your decision is recorded.';
  }
}

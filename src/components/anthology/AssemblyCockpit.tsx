'use client';

/**
 * AssemblyCockpit — the producer's B12 Assembly cockpit (SPEC §6; unit U13).
 *
 * Four steps, in producer voice (never "AI"): READINESS ticker → ARM with the
 * typed anthology name → ORDER the book (drag, pick the opener + the last
 * co-author, confirm the finalized set) → SIGN OFF & deliver. Every decision goes
 * through the session-gated board door (`/api/anthology/gate`, U11), which shells
 * the single sole writer; this view enforces nothing itself and renders exactly
 * what the engine returns. All copy is "editors"/"producer" language.
 *
 * The brain lives in ./assembly-cockpit-logic (framework-free + unit-tested). This
 * file is the thin view. Where the engine has not yet surfaced U9's ordering data
 * or the confirm-order gate, the panel shows an honest "pending" state and never
 * fabricates chapters, rationale, or an order.
 */

import { useCallback, useEffect, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import {
  BookOpen,
  GripVertical,
  Loader2,
  Lock,
  RefreshCw,
  ArrowUpToLine,
  ArrowDownToLine,
  CheckCircle2,
  AlertTriangle,
  Send,
} from 'lucide-react';
import {
  loadAssemblyStatus,
  submitArm,
  submitConfirmOrder,
  submitSignOff,
  derivePhase,
  signOffEnabled,
  nameMatches,
  readinessLabel,
  reorder,
  moveToFront,
  moveToEnd,
  pickConfirmOrderAction,
  type AssemblyStatus,
  type AssemblyPhase,
  type DecideResult,
  type OrderSlot,
} from './assembly-cockpit-logic';

interface AssemblyCockpitProps {
  /** The anthology_id (subjectKey). null when the card has not surfaced it (gap #3). */
  anthologyId: string | null;
  /** Display name; the producer types this exact name to arm (engine validates it). */
  anthologyName: string;
}

const CARD = 'rounded-xl border border-gray-200 bg-white p-4 shadow-sm';
const H = 'text-sm font-semibold text-gray-900';
const SUB = 'text-xs text-gray-500';

export function AssemblyCockpit({ anthologyId, anthologyName }: AssemblyCockpitProps) {
  const [status, setStatus] = useState<AssemblyStatus | null>(null);
  const [phase, setPhase] = useState<AssemblyPhase>(anthologyId ? 'loading' : 'unresolved');
  const [typedName, setTypedName] = useState('');
  const [order, setOrder] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<DecideResult | null>(null);

  const refresh = useCallback(async () => {
    if (!anthologyId) {
      setPhase('unresolved');
      return;
    }
    setPhase('loading');
    const res = await loadAssemblyStatus(anthologyId);
    if (!res.ok) {
      setStatus({ ok: false, reason: res.reason });
      setPhase(res.reason === 'not_ready' ? 'not_ready' : 'error');
      return;
    }
    setStatus(res.status);
    setPhase(derivePhase(res.status));
    if (res.status.ok && res.status.ordering) {
      setOrder(res.status.ordering.order.slice());
    }
  }, [anthologyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runDecision = useCallback(
    async (fn: () => Promise<DecideResult>) => {
      setSubmitting(true);
      setNotice(null);
      const result = await fn();
      setSubmitting(false);
      setNotice(result);
      if (result.ok) {
        setTypedName('');
        await refresh();
      }
    },
    [refresh]
  );

  const onArm = () => {
    if (!anthologyId) return;
    void runDecision(() => submitArm(anthologyId, typedName));
  };
  const onSignOff = () => {
    if (!anthologyId) return;
    void runDecision(() => submitSignOff(anthologyId));
  };
  const onConfirmOrder = () => {
    if (!anthologyId || !status?.ok) return;
    const action = pickConfirmOrderAction(status.actions);
    void runDecision(() => submitConfirmOrder(anthologyId, order, action));
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    setOrder((prev) => reorder(prev, result.source.index, result.destination!.index));
  };

  // -- Frame ---------------------------------------------------------------- //
  return (
    <section className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-indigo-100 p-1.5">
            <BookOpen className="h-4 w-4 text-indigo-700" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-indigo-900">Assembly cockpit</h3>
            <p className="text-xs text-indigo-700/80">
              {anthologyName ? `“${anthologyName}”` : 'This anthology'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </header>

      <ReadinessTicker status={status} />

      {phase === 'loading' && <Muted icon={<Loader2 className="h-4 w-4 animate-spin" />}>Loading the anthology…</Muted>}
      {phase === 'unresolved' && <UnresolvedNotice />}
      {phase === 'not_ready' && (
        <Muted icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}>
          The editors&apos; workspace is not reachable right now. Refresh in a moment.
        </Muted>
      )}
      {phase === 'error' && (
        <Muted icon={<AlertTriangle className="h-4 w-4 text-red-600" />}>
          We couldn&apos;t read this anthology&apos;s status. Refresh to try again.
        </Muted>
      )}

      {phase === 'arm' && (
        <ArmPanel
          anthologyName={anthologyName}
          typedName={typedName}
          setTypedName={setTypedName}
          onArm={onArm}
          submitting={submitting}
        />
      )}

      {phase === 'ordering' && (
        <OrderPanel
          status={status}
          order={order}
          onDragEnd={onDragEnd}
          setOpener={(k) => setOrder((prev) => moveToFront(prev, k))}
          setCloser={(k) => setOrder((prev) => moveToEnd(prev, k))}
          onConfirmOrder={onConfirmOrder}
          submitting={submitting}
        />
      )}

      {phase === 'sign_off' && (
        <SignOffPanel status={status} onSignOff={onSignOff} submitting={submitting} />
      )}

      {phase === 'delivered' && (
        <Muted icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}>
          The anthology is signed off and delivered to every author. This card is parked for the
          quality scorer.
        </Muted>
      )}

      {notice && <Notice result={notice} />}
    </section>
  );
}

// --------------------------------------------------------------------------- //
// Readiness ticker.
// --------------------------------------------------------------------------- //
function ReadinessTicker({ status }: { status: AssemblyStatus | null }) {
  const readiness = status?.ok ? status.readiness : undefined;
  const label = readinessLabel(readiness);
  if (label) {
    return (
      <div className={CARD}>
        <p className={H}>Readiness</p>
        <p className="mt-1 text-sm text-gray-700">{label}</p>
        {readiness?.ready && (
          <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Every chapter is approved or excluded, above the
            {' '}
            {readiness.minChapters}-chapter floor.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className={CARD}>
      <p className={H}>Readiness</p>
      <p className={`mt-1 ${SUB}`}>
        The chapter-by-chapter progress line will appear here once the editors&apos; readiness
        summary is surfaced to the board.
      </p>
      <PassthroughChip note="status passthrough pending — readiness counts (U9/engine)" />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Step 1 — Arm.
// --------------------------------------------------------------------------- //
function ArmPanel({
  anthologyName,
  typedName,
  setTypedName,
  onArm,
  submitting,
}: {
  anthologyName: string;
  typedName: string;
  setTypedName: (v: string) => void;
  onArm: () => void;
  submitting: boolean;
}) {
  const matches = nameMatches(typedName, anthologyName);
  const canSubmit = typedName.trim().length > 0 && !submitting;
  return (
    <div className={CARD}>
      <p className={H}>Ready to assemble?</p>
      <p className={`mt-1 ${SUB}`}>
        Arming is one-way. The editors will only proceed once every chapter is approved or excluded
        and at least two chapters are in. Type the anthology&apos;s exact title to confirm.
      </p>
      <label className="mt-3 block text-xs font-medium text-gray-700" htmlFor="assembly-confirm-name">
        Anthology title
      </label>
      <input
        id="assembly-confirm-name"
        type="text"
        value={typedName}
        onChange={(e) => setTypedName(e.target.value)}
        placeholder={anthologyName || 'Type the anthology title'}
        autoComplete="off"
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      />
      {typedName.trim().length > 0 && anthologyName && (
        <p className={`mt-1 text-xs ${matches ? 'text-green-700' : 'text-gray-400'}`}>
          {matches ? 'Matches the anthology title.' : 'Keep typing the exact title…'}
        </p>
      )}
      <button
        type="button"
        onClick={onArm}
        disabled={!canSubmit}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
        I&apos;m ready to assemble
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Step 2 — Order the book.
// --------------------------------------------------------------------------- //
function OrderPanel({
  status,
  order,
  onDragEnd,
  setOpener,
  setCloser,
  onConfirmOrder,
  submitting,
}: {
  status: AssemblyStatus | null;
  order: string[];
  onDragEnd: (r: DropResult) => void;
  setOpener: (k: string) => void;
  setCloser: (k: string) => void;
  onConfirmOrder: () => void;
  submitting: boolean;
}) {
  const ordering = status?.ok ? status.ordering : undefined;

  // The book is armed / underway but the ordering view is not surfaced yet.
  if (!ordering || ordering.slots.length === 0) {
    return (
      <div className={CARD}>
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-800">
          <CheckCircle2 className="h-4 w-4 text-indigo-600" /> Armed — the editors are assembling
          the book.
        </p>
        <p className={`mt-1 ${SUB}`}>
          The proposed running order, with a one-line note per chapter, will appear here for you to
          arrange once the editors&apos; ordering pass reaches the board.
        </p>
        <PassthroughChip note="ordering view + confirm-order gate pending (U9 cockpit_view)" />
      </div>
    );
  }

  const byKey = new Map(ordering.slots.map((s) => [s.participantKey, s]));
  const openerKey = order[0];
  const closerKey = order[order.length - 1];

  return (
    <div className={CARD}>
      <p className={H}>Order the book</p>
      <p className={`mt-1 ${SUB}`}>
        Drag to arrange the chapters. You decide which chapter opens the book and which co-author
        sits last.
      </p>
      {ordering.overallRationale && (
        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs italic text-gray-600">
          {ordering.overallRationale}
        </p>
      )}

      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="assembly-order">
          {(dropProvided) => (
            <ul
              ref={dropProvided.innerRef}
              {...dropProvided.droppableProps}
              className="mt-3 space-y-2"
            >
              {order.map((key, index) => {
                const slot = byKey.get(key);
                if (!slot) return null;
                return (
                  <Draggable key={key} draggableId={key} index={index}>
                    {(dragProvided, dragSnapshot) => (
                      <li
                        ref={dragProvided.innerRef}
                        {...dragProvided.draggableProps}
                        className={`rounded-lg border bg-white ${
                          dragSnapshot.isDragging ? 'border-indigo-400 shadow-md' : 'border-gray-200'
                        }`}
                      >
                        <OrderRow
                          slot={slot}
                          position={index + 1}
                          isOpener={key === openerKey}
                          isCloser={key === closerKey}
                          onOpener={() => setOpener(key)}
                          onCloser={() => setCloser(key)}
                          dragHandleProps={dragProvided.dragHandleProps}
                        />
                      </li>
                    )}
                  </Draggable>
                );
              })}
              {dropProvided.placeholder}
            </ul>
          )}
        </Droppable>
      </DragDropContext>

      <button
        type="button"
        onClick={onConfirmOrder}
        disabled={submitting || order.length < 2}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
        Confirm the finalized set &amp; order
      </button>
      <p className="mt-1 text-[11px] text-gray-400">
        This confirms these are all the co-authors and the finalized chapters, and hands the book to
        the editors to write the closing chapter and bridges.
      </p>
    </div>
  );
}

function OrderRow({
  slot,
  position,
  isOpener,
  isCloser,
  onOpener,
  onCloser,
  dragHandleProps,
}: {
  slot: OrderSlot;
  position: number;
  isOpener: boolean;
  isCloser: boolean;
  onOpener: () => void;
  onCloser: () => void;
  dragHandleProps: React.HTMLAttributes<HTMLElement> | null | undefined;
}) {
  return (
    <div className="flex items-start gap-3 p-3">
      <span
        {...(dragHandleProps ?? {})}
        className="mt-1 cursor-grab text-gray-400 hover:text-gray-600"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </span>

      <div className="flex h-12 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100 text-[10px] text-gray-400">
        {slot.coverThumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={slot.coverThumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          'cover'
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400">{position}.</span>
          <span className="truncate text-sm font-medium text-gray-900">
            {slot.chapterTitle || 'Untitled chapter'}
          </span>
        </div>
        <p className="text-xs text-gray-500">
          {slot.contributorName || 'Co-author'}
          {slot.wordCount != null && ` · ${slot.wordCount.toLocaleString()} words`}
          {slot.tone && (
            <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
              {slot.tone}
            </span>
          )}
        </p>
        {slot.rationale && <p className="mt-1 text-xs italic text-gray-500">{slot.rationale}</p>}

        <div className="mt-2 flex gap-2">
          <PickButton active={isOpener} onClick={onOpener} icon={<ArrowUpToLine className="h-3 w-3" />}>
            Opens the book
          </PickButton>
          <PickButton active={isCloser} onClick={onCloser} icon={<ArrowDownToLine className="h-3 w-3" />}>
            Closes the book
          </PickButton>
        </div>
      </div>
    </div>
  );
}

function PickButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? 'border-indigo-500 bg-indigo-600 text-white'
          : 'border-gray-200 bg-white text-gray-600 hover:border-indigo-300'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// Step 3 — Sign off.
// --------------------------------------------------------------------------- //
function SignOffPanel({
  status,
  onSignOff,
  submitting,
}: {
  status: AssemblyStatus | null;
  onSignOff: () => void;
  submitting: boolean;
}) {
  const enabled = status ? signOffEnabled(status) : false;
  return (
    <div className={CARD}>
      <p className={H}>Deliver the anthology</p>
      <p className={`mt-1 ${SUB}`}>
        {enabled
          ? 'The manuscript is compiled. Signing off stamps every author and sends the finished anthology to every contact.'
          : 'Sign-off unlocks once the manuscript is compiled by the editors.'}
      </p>
      <button
        type="button"
        onClick={onSignOff}
        disabled={!enabled || submitting}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Sign off &amp; deliver the anthology
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Shared small pieces.
// --------------------------------------------------------------------------- //
function Muted({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`${CARD} flex items-center gap-2 text-sm text-gray-600`}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

function UnresolvedNotice() {
  return (
    <div className={CARD}>
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800">
        <AlertTriangle className="h-4 w-4 text-amber-600" /> This anthology&apos;s id isn&apos;t on
        the card yet.
      </p>
      <p className={`mt-1 ${SUB}`}>
        The assembly card needs its anthology id surfaced (from the card&apos;s source reference)
        before the cockpit can arm or sign off.
      </p>
      <PassthroughChip note="card passthrough pending — anthology_id (source_ref) on the Task" />
    </div>
  );
}

function PassthroughChip({ note }: { note: string }) {
  return (
    <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
      <AlertTriangle className="h-3 w-3" /> {note}
    </span>
  );
}

function Notice({ result }: { result: DecideResult }) {
  if (result.ok) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
        <CheckCircle2 className="h-4 w-4" />
        Recorded{result.queued ? ' (queued to the local mirror)' : ''}.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <AlertTriangle className="h-4 w-4" />
      {result.message}
    </div>
  );
}

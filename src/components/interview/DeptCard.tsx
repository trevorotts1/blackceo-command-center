'use client';

/**
 * DeptCard — one department card on the Phase-5.5 decision board (P2-5).
 *
 * A PURE presentational card. It renders a single department (emoji + name +
 * one-liner), a COVERED / NOT-YET coverage badge, and the owner's YES / NO /
 * LATER choice — but it owns NO data and presses NO buttons of its own. Every
 * decision is relayed up via `onDecide`; the parent <DepartmentBoard/> is the
 * only thing that talks to POST /api/interview/decision (the single sanctioned
 * writer → record-dept-decision.sh). Keeping this component write-free means a
 * card can never fabricate a decision or drift from server truth.
 *
 * Two card shapes share this component:
 *   • kind 'core' / 'recommended' — a canonical department the client's Skill-23
 *     script knows by id. Gets the full YES / NO / LATER control. A NO becomes a
 *     provenanced, honored decline (it shows NO and is not built downstream).
 *   • kind 'custom' — an owner-added department. It has no canonical id the
 *     recorder would accept, so it is KEPT by default (opt-out model) and offers
 *     a Remove control instead of decision buttons.
 *
 * Aesthetic: the dark-panel interview theme (iv-* tokens, closeout continuity),
 * consumed via `iv`/`ivcx` so a per-client re-theme flows in for free. Copy here
 * is deliberately jargon-free (owner words, no "canonical"/"provenance"/"gate")
 * so the P3-4 jargon lint has nothing to flag.
 */

import { motion } from 'framer-motion';
import {
  Check,
  Clock3,
  Loader2,
  X,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
} from 'lucide-react';
import { iv, ivcx, ivStaggerChild } from './interview-theme';

/** The owner's verb on a department (null = not decided yet). */
export type DeptVerb = 'yes' | 'no' | 'later';

export type DeptKind = 'core' | 'recommended' | 'custom';

export interface DeptCardProps {
  /** Canonical (or custom) department id — the value sent to the decision writer. */
  id: string;
  /** Owner-facing name. */
  name: string;
  /** One-line description of what this department does. */
  oneLiner: string;
  /** Decorative emoji (never used for identity — the id set is the source of truth). */
  emoji: string;
  kind: DeptKind;
  /** The recorded / optimistic decision. null → undecided. */
  decision: DeptVerb | null;
  /** True once the server confirms a provenanced decision for this id. */
  covered: boolean;
  /** True when the server sees an un-provenanced decline for this id (gate #8):
   *  it must be re-confirmed before the board can complete. */
  needsReconfirm?: boolean;
  /** A write is in flight for this card. */
  busy?: boolean;
  /** Last write error for this card, if any. */
  error?: string | null;
  /** Disable all controls (e.g. the catalog is still loading). */
  disabled?: boolean;
  /** Relay a YES / NO / LATER press up to the board (core/recommended only). */
  onDecide?: (verb: DeptVerb) => void;
  /** Opt a custom department out of the workforce (custom only). */
  onRemove?: () => void;
}

const KIND_LABEL: Record<DeptKind, string> = {
  core: 'Core department',
  recommended: 'Recommended for your industry',
  custom: 'Your addition',
};

export default function DeptCard({
  id,
  name,
  oneLiner,
  emoji,
  kind,
  decision,
  covered,
  needsReconfirm = false,
  busy = false,
  error = null,
  disabled = false,
  onDecide,
  onRemove,
}: DeptCardProps) {
  const isCustom = kind === 'custom';
  // A custom department is kept by default, so it reads as covered even without
  // a written decision. Canonical cards are covered only on server confirmation.
  const decided = covered || decision !== null || isCustom;

  return (
    <motion.article
      layout
      variants={ivStaggerChild}
      data-dept-id={id}
      data-decision={decision ?? (isCustom ? 'kept' : 'undecided')}
      className={ivcx(iv.card, 'iv-dept-card')}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
    >
      {/* ── header: identity + coverage badge ──────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <span aria-hidden style={{ fontSize: '1.6rem', lineHeight: 1 }}>
          {emoji}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: '1.02rem',
              color: 'var(--iv-ink)',
            }}
          >
            {name}
          </h3>
          <p
            style={{
              margin: '0.15rem 0 0',
              fontSize: '0.7rem',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--iv-ink-faint)',
            }}
          >
            {KIND_LABEL[kind]}
          </p>
        </div>
        <CoverageBadge
          decided={decided}
          declined={decision === 'no'}
          later={decision === 'later'}
          needsReconfirm={needsReconfirm}
        />
      </div>

      <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--iv-ink-soft)' }}>
        {oneLiner}
      </p>

      {/* ── controls ───────────────────────────────────────────────────────── */}
      {isCustom ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--iv-accent-strong)' }}>
            <Check className="h-4 w-4" aria-hidden />
            In your workforce
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled || busy}
              className={ivcx(iv.btnQuiet, busy && 'is-busy')}
              aria-label={`Remove ${name} from your workforce`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
              Remove
            </button>
          )}
        </div>
      ) : (
        <div
          role="group"
          aria-label={`Decision for ${name}`}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}
        >
          <DecisionButton
            verb="yes"
            label="Build it"
            selected={decision === 'yes'}
            busy={busy}
            disabled={disabled}
            onClick={() => onDecide?.('yes')}
          />
          <DecisionButton
            verb="later"
            label="Decide later"
            selected={decision === 'later'}
            busy={busy}
            disabled={disabled}
            onClick={() => onDecide?.('later')}
          />
          <DecisionButton
            verb="no"
            label="Skip it"
            selected={decision === 'no'}
            busy={busy}
            disabled={disabled}
            onClick={() => onDecide?.('no')}
          />
        </div>
      )}

      {/* ── declined footnote (a NO shows NO and is not built) ──────────────── */}
      {decision === 'no' && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--iv-ink-faint)', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <X className="h-3.5 w-3.5" aria-hidden />
          We won&apos;t build this — you can change your mind any time.
        </p>
      )}

      {needsReconfirm && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: '#F0B429', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          This one needs a fresh yes or no before we can build.
        </p>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: '#F0B429', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          {error}
        </p>
      )}
    </motion.article>
  );
}

/* -------------------------------------------------------------------------- */
/* coverage badge — the COVERED / NOT-YET signal per card                      */
/* -------------------------------------------------------------------------- */

function CoverageBadge({
  decided,
  declined,
  later,
  needsReconfirm,
}: {
  decided: boolean;
  declined: boolean;
  later: boolean;
  needsReconfirm: boolean;
}) {
  if (needsReconfirm) {
    return (
      <span className={iv.badgeDeclined} style={{ whiteSpace: 'nowrap' }}>
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        Needs a second look
      </span>
    );
  }
  if (!decided) {
    return (
      <span className={iv.badgePending} style={{ whiteSpace: 'nowrap' }}>
        <CircleDashed className="h-3.5 w-3.5" aria-hidden />
        Not yet
      </span>
    );
  }
  if (declined) {
    return (
      <span className={iv.badgeDeclined} style={{ whiteSpace: 'nowrap' }}>
        <X className="h-3.5 w-3.5" aria-hidden />
        Skipped
      </span>
    );
  }
  if (later) {
    return (
      <span className={iv.badgePending} style={{ whiteSpace: 'nowrap' }}>
        <Clock3 className="h-3.5 w-3.5" aria-hidden />
        Later
      </span>
    );
  }
  return (
    <span className={iv.badgeCovered} style={{ whiteSpace: 'nowrap' }}>
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      Covered
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* one YES / NO / LATER button                                                 */
/* -------------------------------------------------------------------------- */

function DecisionButton({
  verb,
  label,
  selected,
  busy,
  disabled,
  onClick,
}: {
  verb: DeptVerb;
  label: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const base = verb === 'yes' && selected ? iv.btnPrimary : verb === 'later' ? iv.btnQuiet : iv.btnGhost;
  const Icon = verb === 'yes' ? Check : verb === 'later' ? Clock3 : X;
  // The primary variant already reads as "chosen"; give the ghost/quiet variants
  // an explicit selected ring so a chosen NO / LATER is unmistakable on the dark
  // panel (there is no generic .iv-btn.is-selected rule in globals.css).
  const selectedRing =
    selected && !(verb === 'yes')
      ? {
          borderColor: verb === 'no' ? 'var(--iv-line-strong)' : 'var(--iv-accent-ring)',
          boxShadow: '0 0 0 2px var(--iv-accent-wash)',
          color: 'var(--iv-ink)',
        }
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={selected}
      className={ivcx(base, selected && 'is-selected', busy && selected && 'is-busy')}
      style={{ padding: '0.55rem 0.5rem', fontSize: '0.85rem', width: '100%', ...(selectedRing ?? {}) }}
    >
      {busy && selected ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Icon className="h-4 w-4" aria-hidden />
      )}
      {label}
    </button>
  );
}

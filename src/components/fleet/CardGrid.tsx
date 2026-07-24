'use client';

/**
 * CardGrid — a responsive grid of quiet hairline cards, extracted from the
 * /overview KPI strip + Views grid (U016). Reusable by the /fleet page (U009)
 * to render fleet-wide stat cards (totals) and per-box entity cards.
 *
 * Three exports:
 *   • StatCard   — a KPI card: muted label, big mono tabular value, sub line,
 *                  optional alert state (red value + alert icon). Mirrors the
 *                  /overview KPI strip card exactly.
 *   • EntityCard — a destination/entity card: 10%-tint icon chip, title,
 *                  description, optional count badge. Mirrors the /overview
 *                  Views card exactly. Color lives ONLY in the icon chip.
 *   • CardGrid   — a responsive grid wrapper (cols configurable) for either
 *                  card type. Mirrors the /overview grid breakpoints.
 *
 * White-label safe: every accent uses brand-* utilities or semantic colors; no
 * hardcoded brand hues. Cards are real links (Next Link) or plain divs.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowUpRight, CircleAlert } from 'lucide-react';

/* ── StatCard (KPI card) ─────────────────────────────────────────────────── */

export interface StatCardProps {
  label: string;
  /** The big number. Pass '–' (or null → '–') while loading. */
  value: ReactNode;
  /** Muted sub-line under the value. */
  sub?: string;
  /** Alert state → red value + alert icon (e.g. blocked > 0). */
  alert?: boolean;
  /** Optional link target; omit for a non-clickable card. */
  href?: string;
}

const CARD_BASE =
  'group bg-white border border-gray-200 rounded-xl p-4 hover:border-brand-300 hover:shadow-card transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300';

export function StatCard({ label, value, sub, alert, href }: StatCardProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">{label}</span>
        {alert ? (
          <CircleAlert className="w-3.5 h-3.5 text-red-500" aria-hidden="true" />
        ) : (
          <ArrowUpRight
            className="w-3.5 h-3.5 text-gray-300 group-hover:text-brand-500 transition-colors"
            aria-hidden="true"
          />
        )}
      </div>
      <div
        className={`font-mono text-[28px] leading-none font-semibold tabular-nums tracking-tight ${
          alert ? 'text-red-600' : 'text-gray-900'
        }`}
      >
        {value ?? '–'}
      </div>
      {sub ? <p className="text-xs text-gray-400 mt-1.5 truncate">{sub}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={CARD_BASE}>
        {inner}
      </Link>
    );
  }
  return <div className={CARD_BASE}>{inner}</div>;
}

/* ── EntityCard (destination / per-box card) ─────────────────────────────── */

export interface EntityCardProps {
  title: string;
  description?: string;
  /** Icon element rendered inside the tinted chip. */
  icon?: ReactNode;
  /** 10%-tint chip classes (e.g. 'bg-indigo-50 text-indigo-600'). Color lives
   *  ONLY here, never on the card body. */
  chip?: string;
  /** Optional count badge shown next to the title. */
  badge?: number | null;
  /** Optional link target; omit for a non-clickable card. */
  href?: string;
  /** Trailing accessory (replaces the default ArrowUpRight). */
  trailing?: ReactNode;
}

export function EntityCard({
  title,
  description,
  icon,
  chip = 'bg-gray-100 text-gray-600',
  badge,
  href,
  trailing,
}: EntityCardProps) {
  const inner = (
    <>
      {icon ? (
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${chip}`}
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 truncate">{title}</span>
          {typeof badge === 'number' && badge > 0 && (
            <span className="text-xs font-mono tabular-nums font-medium text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">
              {badge}
            </span>
          )}
        </div>
        {description ? (
          <p className="text-xs text-gray-500 truncate mt-0.5">{description}</p>
        ) : null}
      </div>
      {trailing ?? (
        <ArrowUpRight
          className="w-4 h-4 text-gray-300 group-hover:text-brand-500 transition-colors shrink-0"
          aria-hidden="true"
        />
      )}
    </>
  );

  const cardClass = `${CARD_BASE} flex items-center gap-3 min-h-[72px]`;
  if (href) {
    return (
      <Link href={href} className={cardClass}>
        {inner}
      </Link>
    );
  }
  return <div className={cardClass}>{inner}</div>;
}

/* ── CardGrid (responsive grid wrapper) ──────────────────────────────────── */

export interface CardGridProps {
  children: ReactNode;
  /** Responsive column layout. Defaults to the /overview Views grid. */
  cols?: string;
  /** Accessible label for the grid section. */
  ariaLabel?: string;
  className?: string;
}

export function CardGrid({
  children,
  cols = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  ariaLabel,
  className,
}: CardGridProps) {
  return (
    <div aria-label={ariaLabel} className={`grid ${cols} gap-3 ${className ?? ''}`}>
      {children}
    </div>
  );
}

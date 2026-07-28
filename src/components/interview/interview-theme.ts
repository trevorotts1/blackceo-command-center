/**
 * interview-theme.ts  (Wave 5 · P3-6 — Superdesign / frontend-design aesthetic pass)
 *
 * THE ONE interview aesthetic, expressed as shared tokens + class bundles the
 * seven interview screens consume. Landed early so P0-6 (walking skeleton),
 * P1-* (question card, progress rail, conversation pane, welcome-back) and
 * P2-* (decision board, review screen, milestone) all render from the SAME
 * design language instead of drifting into three different products.
 *
 * ── What it reconciles ────────────────────────────────────────────────────────
 * Three palettes existed before this pass:
 *   • /onboarding/building  → an ad-hoc light-indigo gradient
 *   • bcc-*                 → the light Command Center theme (BlackCEO green)
 *   • mc-*                  → the legacy near-black dark theme
 * P3-6 collapses them into ONE calm, premium, single-focus look:
 *   • a warm paper CANVAS (no cold indigo) so the brand accent leads
 *   • a serif/display face for the question (the emotional focal point)
 *   • a DARK-PANEL surface for the department board + closeout milestones, so
 *     the last interview screen flows straight into the Skill-37 closeout reveal
 *
 * ── Why it re-themes per client for free ──────────────────────────────────────
 * Every accent token points at the SAME `--brand-*` CSS variables that
 * <BrandTheme/> (src/components/BrandTheme.tsx) rewrites from the client's
 * stored primary color. So the instant the owner answers the brand-color
 * question (P2-7), the whole interview surface — buttons, rails, badges, the
 * question underline — becomes their brand, with zero per-component work.
 *
 * ── How to consume ────────────────────────────────────────────────────────────
 *   import { iv, ivcx, ivScreenVariants } from '@/components/interview/interview-theme';
 *
 *   <section className={iv.root}>            // calm light scope
 *     <div className={iv.stage}>
 *       <p className={iv.eyebrow}>Step 3 of 7</p>
 *       <h1 className={iv.question}>What does your company make?</h1>
 *       <button className={ivcx(iv.btnPrimary, busy && 'is-busy')}>Continue</button>
 *     </div>
 *   </section>
 *
 *   <div className={iv.dark}>                 // dark-panel scope (board / closeout)
 *     <article className={iv.card}>…</article> // cards flip dark automatically
 *   </div>
 *
 * All class names resolve to the `.iv-*` layer appended to src/app/globals.css.
 * This module is pure data (no React) so both server and client components can
 * import it. It contains NO owner-facing prose — only class names and design
 * tokens — so the P3-4 jargon lint has nothing to flag here.
 */

import type { Transition, Variants } from 'framer-motion';

/* ─────────────────────────────────────────────────────────────────────────────
 * Class-name bundles — the primary API. Values are the CSS classes defined in
 * the `.iv-*` layer of globals.css. Components reference `iv.card`, never a raw
 * string, so a token rename is a one-line change here.
 * ────────────────────────────────────────────────────────────────────────── */
export const iv = {
  /** Calm light scope — sets the paper canvas, ink color and body font. */
  root: 'iv-root',
  /** Dark-panel scope — flips every nested `iv-*` surface to the closeout look. */
  dark: 'iv-dark',

  /** Single-focus centered column (max-width = one comfortable measure). */
  stage: 'iv-stage',
  /** Small letterspaced label above the question (phase / step marker). */
  eyebrow: 'iv-eyebrow',
  /** The question itself — serif/display face, the screen's focal point. */
  question: 'iv-question',
  /** Supporting sentence under the question or a screen intro line. */
  lede: 'iv-lede',

  /** Surface card. Inside `iv.dark` it becomes a dark panel automatically. */
  card: 'iv-card',
  /** Self-contained dark panel card (dark even outside an `iv.dark` scope). */
  panelCard: 'iv-panel-card',

  /** Conversation bubbles. */
  bubbleAgent: 'iv-bubble iv-bubble-agent',
  bubbleOwner: 'iv-bubble iv-bubble-owner',

  /** Buttons. `btn` is the base; the variants include it. */
  btn: 'iv-btn',
  btnPrimary: 'iv-btn iv-btn-primary',
  btnSecondary: 'iv-btn iv-btn-secondary',
  btnGhost: 'iv-btn iv-btn-ghost',
  btnQuiet: 'iv-btn iv-btn-quiet',

  /** Text / structured-card inputs. */
  input: 'iv-input',
  field: 'iv-field',

  /** Progress rail (phase stepper). */
  rail: 'iv-rail',
  railStep: 'iv-rail-step',
  railDot: 'iv-rail-dot',
  /** Derived-percent bar (also used by the build-progress screen). */
  progressTrack: 'iv-progress-track',
  progressFill: 'iv-progress-fill',

  /** Decision-board coverage badges. */
  badge: 'iv-badge',
  badgeCovered: 'iv-badge iv-badge-covered',
  badgePending: 'iv-badge iv-badge-pending',
  badgeDeclined: 'iv-badge iv-badge-declined',

  /** Welcome/consent option (A/B/C) — NEVER auto-selected; add `is-selected`
   *  only on an explicit owner click. */
  choice: 'iv-choice',
} as const;

/**
 * State modifier classes. Append with `ivcx(...)`, e.g.
 * `ivcx(iv.railStep, done && ivState.done, active && ivState.active)`.
 */
export const ivState = {
  done: 'is-done',
  active: 'is-active',
  selected: 'is-selected',
  busy: 'is-busy',
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * Raw token references. For the rare case a component needs a value in JS
 * (inline style, canvas fill, framer color). Each points at a CSS variable so
 * it still tracks the live per-client re-theme.
 * ────────────────────────────────────────────────────────────────────────── */
export const ivTokens = {
  canvas: 'var(--iv-canvas)',
  surface: 'var(--iv-surface)',
  surfaceAlt: 'var(--iv-surface-2)',
  line: 'var(--iv-line)',
  lineStrong: 'var(--iv-line-strong)',
  ink: 'var(--iv-ink)',
  inkSoft: 'var(--iv-ink-soft)',
  inkFaint: 'var(--iv-ink-faint)',
  accent: 'var(--iv-accent)',
  accentStrong: 'var(--iv-accent-strong)',
  accentWash: 'var(--iv-accent-wash)',
  accentRing: 'var(--iv-accent-ring)',
  onAccent: 'var(--iv-on-accent)',
  radius: 'var(--iv-radius)',
  radiusSm: 'var(--iv-radius-sm)',
  fontDisplay: 'var(--iv-font-display)',
  fontSans: 'var(--iv-font-sans)',
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
 * classNames helper. Kept tiny and dependency-free (no clsx in this repo).
 * Falsy entries are dropped so `ivcx(base, cond && mod)` reads cleanly.
 * ────────────────────────────────────────────────────────────────────────── */
export function ivcx(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Motion presets — one calm entrance/exit language for all seven screens, so a
 * phase change never feels janky. Consumed by framer-motion (^12) which every
 * interview component already uses.
 * ────────────────────────────────────────────────────────────────────────── */

/** Calm, slightly-decelerating ease shared by every interview transition. */
export const ivEase: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

export const ivDurations = {
  fast: 0.16,
  base: 0.28,
  slow: 0.48,
} as const;

export const ivTransition: Transition = {
  duration: ivDurations.base,
  ease: ivEase,
};

/** Whole-screen enter/leave (wrap each phase view in a motion element). */
export const ivScreenVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: ivTransition },
  exit: { opacity: 0, y: -8, transition: { duration: ivDurations.fast, ease: ivEase } },
};

/** Question swap — a touch more travel so a new question reads as "the next
 *  thing", not a flicker. */
export const ivQuestionVariants: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: ivDurations.slow, ease: ivEase } },
  exit: { opacity: 0, y: -12, transition: { duration: ivDurations.fast, ease: ivEase } },
};

/** Stagger container for lists that reveal (decision-board cards, review rows). */
export const ivStaggerParent: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

export const ivStaggerChild: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: ivTransition },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * The seven interview screens, in owner-journey order. A single labelled source
 * so the progress rail, the router phase map and the jargon-safe copy layer all
 * agree on the set. `dark: true` marks the surfaces that use the closeout panel
 * (the department board and the milestone/celebration screens).
 * ────────────────────────────────────────────────────────────────────────── */
export type IvScreenId =
  | 'welcome'
  | 'question'
  | 'recommendation'
  | 'departments'
  | 'review'
  | 'building'
  | 'welcome-back';

export interface IvScreen {
  id: IvScreenId;
  /** Short, jargon-free label safe for the rail / headers. */
  label: string;
  dark: boolean;
}

export const IV_SCREENS: readonly IvScreen[] = [
  { id: 'welcome', label: 'Welcome', dark: false },
  { id: 'question', label: 'Your answers', dark: false },
  { id: 'recommendation', label: 'Recommendation', dark: false },
  { id: 'departments', label: 'Departments', dark: true },
  { id: 'review', label: 'Review', dark: false },
  { id: 'building', label: 'Building', dark: true },
  { id: 'welcome-back', label: 'Welcome back', dark: false },
] as const;

export type InterviewTheme = typeof iv;

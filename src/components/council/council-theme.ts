/**
 * council-theme.ts (CWE-031, Skill 77 Council of Wise Elders)
 *
 * The locked council visual system as typed data: class bundles, token
 * references, the five reference screens, and the stable nine-seat room
 * geometry. Class names resolve to the scoped layer in council-theme.css
 * (import that stylesheet once from the council shell; every rule is
 * scoped under .council-theme / .council-stage, so nothing here can restyle
 * the rest of the Command Center).
 *
 * Locked by CWE-031 against Directive Sections 21, 22, 23 and the visual
 * benchmark in visual-benchmark.md. CWE-032 builds the room components
 * against these tokens; CWE-042 judges rendered screens against the locked
 * reference in visual-reference/council-screens-reference.html.
 *
 * Design law baked into the tokens (do not drift silently):
 * - Bright light product scope; the dark chamber is only the nested room
 *   stage (.council-stage), never the app theme.
 * - Seat names render at --council-text-name (16px) or larger in primary
 *   seat views and wrap to two lines; never initials-only, never clipped.
 * - Ordinary text never uses --council-accent or --council-accent-strong;
 *   the text-safe accent step is --council-accent-ink.
 * - State is label + shape + color, never color alone.
 * - Every interactive seat/control is at least the 44px touch target.
 */

/* ── Class bundles ─────────────────────────────────────────────────────── */
export const council = {
  /** Light product scope root. Sets canvas, ink, and body font. */
  theme: 'council-theme',
  /** Nested dark room-stage scope (Section 22.2 chamber backdrop). */
  stage: 'council-stage',

  display: 'council-display',
  heading: 'council-heading',
  lede: 'council-lede',
  meta: 'council-meta',
  eyebrow: 'council-eyebrow',

  card: 'council-card',
  btn: 'council-btn',
  btnPrimary: 'council-btn council-btn-primary',
  btnSecondary: 'council-btn council-btn-secondary',
  btnQuiet: 'council-btn council-btn-quiet',

  /** Seat button and its text parts (name >= 16px, wraps, never clipped). */
  seat: 'council-seat',
  seatName: 'council-seat-name',
  seatRole: 'council-seat-role',

  /** State badges: shape marker + text label + color. */
  state: 'council-state',
  stateSupport: 'council-state council-state-support',
  stateConditional: 'council-state council-state-conditional',
  stateOppose: 'council-state council-state-oppose',
  stateAbstain: 'council-state council-state-abstain',

  /** Room geometry: oval frame at >= ~920px container, grid below. */
  room: 'council-room',
  roomFrame: 'council-room-frame',
  roomSeat: 'council-room-seat',
  seatGrid: 'council-seat-grid',

  /** Phone reading view rows. */
  readingList: 'council-reading-list',
  readingRow: 'council-reading-row',
} as const;

/* ── Raw token references (values live in council-theme.css) ──────────── */
export const councilTokens = {
  fontSans: 'var(--council-font-sans)',
  fontDisplay: 'var(--council-font-display)',
  textDisplay: 'var(--council-text-display)',
  textHeading: 'var(--council-text-heading)',
  textBody: 'var(--council-text-body)',
  textBodySm: 'var(--council-text-body-sm)',
  textMeta: 'var(--council-text-meta)',
  textName: 'var(--council-text-name)',
  canvas: 'var(--council-canvas)',
  surface: 'var(--council-surface)',
  surface2: 'var(--council-surface-2)',
  line: 'var(--council-line)',
  lineStrong: 'var(--council-line-strong)',
  ink: 'var(--council-ink)',
  inkSoft: 'var(--council-ink-soft)',
  inkFaint: 'var(--council-ink-faint)',
  accent: 'var(--council-accent)',
  accentStrong: 'var(--council-accent-strong)',
  accentInk: 'var(--council-accent-ink)',
  accentWash: 'var(--council-accent-wash)',
  onAccent: 'var(--council-on-accent)',
  stage: 'var(--council-stage)',
  stageRaised: 'var(--council-stage-raised)',
  stageInk: 'var(--council-stage-ink)',
  stageMuted: 'var(--council-stage-muted)',
  radiusCard: 'var(--council-radius-card)',
  radiusControl: 'var(--council-radius-control)',
  touchTarget: 'var(--council-touch-target)',
  duration: 'var(--council-dur)',
  durationFast: 'var(--council-dur-fast)',
  ease: 'var(--council-ease)',
} as const;

/** classNames helper, same tiny pattern as interview-theme's ivcx. */
export function councilcx(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

/* ── The five locked reference screens (Sections 21.2, 22) ─────────────── */
export type CouncilScreenId =
  | 'home'
  | 'brief-review'
  | 'live-room'
  | 'verdict'
  | 'phone-reading';

export interface CouncilScreen {
  id: CouncilScreenId;
  label: string;
  /** Target route the screen reference illustrates. Built by CWE-033/034. */
  route: string;
  /** Primary action the screen exists to offer (Section 21.2). */
  primaryAction: string;
}

export const COUNCIL_SCREENS: readonly CouncilScreen[] = [
  { id: 'home', label: 'Council home', route: '/council', primaryAction: 'Ask the council' },
  { id: 'brief-review', label: 'Brief review', route: '/council/new', primaryAction: 'Start council' },
  { id: 'live-room', label: 'Live room', route: '/council/[sessionId]', primaryAction: 'Read latest findings' },
  { id: 'verdict', label: 'Verdict', route: '/council/[sessionId]', primaryAction: 'Create this action plan' },
  { id: 'phone-reading', label: 'Phone reading view', route: '/council/[sessionId]', primaryAction: 'Open a seat to read' },
] as const;

/* ── Stable seat geometry (Section 22.4) ──────────────────────────────────
   Slots are keyed by stable seat ID and never shuffle by arrival, score,
   or model. Positions are percentages of the 920x640 design frame: seats
   evenly spaced on an ellipse with radii 340px (x) and 215px (y) around
   the frame center, starting at the top in roster order, clockwise. The
   quiet center holds the current decision and round. */
export interface CouncilSeatSlot {
  seatId: string;
  /** Left position, percent of frame width (seat is centered on it). */
  xPct: number;
  /** Top position, percent of frame height (seat is centered on it). */
  yPct: number;
}

export const COUNCIL_SEAT_SLOTS: readonly CouncilSeatSlot[] = [
  { seatId: 'simon-sinek', xPct: 50.0, yPct: 16.4 },
  { seatId: 'td-jakes', xPct: 73.8, yPct: 24.3 },
  { seatId: 'oprah-winfrey', xPct: 86.4, yPct: 44.2 },
  { seatId: 'tiffany-aliche', xPct: 82.0, yPct: 66.8 },
  { seatId: 'russell-brunson', xPct: 62.6, yPct: 81.6 },
  { seatId: 'michelle-obama', xPct: 37.4, yPct: 81.6 },
  { seatId: 'brene-brown', xPct: 18.0, yPct: 66.8 },
  { seatId: 'dennis-kimbro', xPct: 13.6, yPct: 44.2 },
  { seatId: 'les-brown', xPct: 26.2, yPct: 24.3 },
] as const;

export type CouncilTheme = typeof council;

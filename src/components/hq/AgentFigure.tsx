'use client';

/**
 * AgentFigure — one employee on the Headquarters floor (unit B24, milestones V09/V11).
 *
 * Authority: SPEC.md revision 4 §S3 (roster projection), §S4 (visual hierarchy,
 * movement truth), §S11 (accessibility); swarm-plan.json rev 4 task B24. Imported
 * names come from the frozen P01 contract `@/lib/hq/types` and are never
 * redeclared. Position arrives as a `HqSeatLayout` from `buildLayout` (B04); this
 * component reads `seat.screenX/screenY` and renders upright, exactly as S4
 * requires ("upright labels rendered separately from the isometric floor").
 *
 * What the figure states, and nothing it cannot prove:
 *   - the display name and role (S3), always as text;
 *   - a head title/role marker that is a LABEL, not a colour-only distinction (S4);
 *   - an on-call badge that reports staffing rather than pretending occupancy (S4);
 *   - the reported status as shape + text, never colour alone (S11). An
 *     unrecognised status has already collapsed to `'unknown'` at the projection
 *     boundary (S3), and `'unknown'` renders the S3 verbatim string
 *     "Status not observed" — a quiet map is not proof the company is idle (S1);
 *   - the S3 conflict strings when the roster says the runtime is not there:
 *     "Runtime binding unavailable" (unbound / not runtime-bound) and
 *     "Shared department executor" (department-shared binding, S3).
 *
 * Not rendered here, deliberately: any talk affordance (the Inspector/HeadChat
 * units own that), and any "walk"/motion (B25 owns overlays; a `working` flag
 * alone never invents movement, S4). No emoji avatar: S11 allows existing avatar
 * data to carry emoji but requires a text accessible name, which is the label
 * below; a figure with no name data shows the roster ID rather than a guess.
 */
import type { HqAgent, HqAgentStatus, HqSeatLayout } from '@/lib/hq/types';

/**
 * S3 status vocabulary in plain words. `unknown` reads "Status not observed",
 * the string S3 requires when the state was not observed (as opposed to an
 * observed `offline`, and unlike `standby`, which is a reported state only).
 */
export const HQ_STATUS_LABEL: Record<HqAgentStatus, string> = {
  standby: 'Standby',
  working: 'Working',
  busy: 'Busy',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Status not observed',
};

/**
 * Mark colour per status. These classes set the group's CSS `color`, which the
 * shape inside StatusMark consumes via `fill-current` / `stroke-current` — they
 * tint the MARK only, never the status word. The word is painted `fill-bcc-text`
 * (≥14.9:1 on every surface a room can paint): colouring the word per status is
 * exactly what S11 forbids here, because amber-700 measures 4.464:1 and
 * bcc-text-secondary 4.298:1 on the selected room's brand-50 floor, which a
 * figure standing in that room sits on.
 */
const HQ_STATUS_MARK: Record<HqAgentStatus, string> = {
  standby: 'text-bcc-text-secondary',
  working: 'text-emerald-700',
  busy: 'text-blue-700',
  degraded: 'text-amber-700',
  offline: 'text-red-700',
  unknown: 'text-gray-600',
};

/**
 * Distinct SHAPE per status, so state never rides on colour alone (S11). Drawn in
 * currentColor at the origin of a small group; the text label always accompanies it.
 */
function StatusMark({ status }: { status: HqAgentStatus }) {
  const filled = 'fill-current';
  const hollow = 'fill-none stroke-current';
  switch (status) {
    case 'working':
      return <path d="M -4 -4.5 L 5 0 L -4 4.5 Z" className={filled} />;
    case 'busy':
      return <rect x={-4} y={-4} width={8} height={8} rx={1.5} className={filled} />;
    case 'standby':
      return <circle r={4} className={hollow} strokeWidth={2} />;
    case 'degraded':
      return <path d="M 0 -5 L 5 4 L -5 4 Z" className={hollow} strokeWidth={2} />;
    case 'offline':
      return (
        <g>
          <circle r={4} className={hollow} strokeWidth={2} />
          <path d="M -3 -3 L 3 3" className="stroke-current" strokeWidth={2} />
        </g>
      );
    case 'unknown':
      return <circle r={4} className={hollow} strokeWidth={2} strokeDasharray="2 2" />;
  }
}

export type AgentFigureProps = {
  agent: HqAgent;
  /** Seat from `buildLayout`; `screenX`/`screenY` place the upright figure. */
  seat: HqSeatLayout;
  selected?: boolean;
  onSelect?: (agentId: string) => void;
};

export default function AgentFigure({ agent, seat, selected = false, onSelect }: AgentFigureProps) {
  // Keyboard focus ring is CSS (`group-focus-visible`), not React state: it costs no
  // render, survives without hydration, and keyboard reach is proven in the tests.
  // S3: conflicts stay explicit. Verbatim strings, deduped, never smoothed over.
  const notices = [
    // `department-shared` keeps its own label: the role is a labeled work area
    // sharing one runtime, which is not the same fact as "unbound" (S3).
    ...(agent.bindingKind === 'department-shared' ? ['Shared department executor'] : []),
    ...(agent.bindingKind === 'unbound' || !agent.runtimeBound ? ['Runtime binding unavailable'] : []),
  ].filter((notice, index, all) => all.indexOf(notice) === index);

  const staffingLabel = agent.staffing === 'on-call' ? 'On-call' : 'Permanent';
  const statusLabel = HQ_STATUS_LABEL[agent.status];
  // One fallback for both the visible label and the accessible name: a nameless
  // roster row must not expose "undefined"/a leading comma to assistive tech
  // (WCAG 2.5.3 label-in-name, S11 accessible names).
  const displayName = agent.displayName || agent.id;
  const ariaLabel =
    `${displayName}, ${agent.role}. ` +
    `${agent.isHead ? 'Head. ' : 'Specialist. '}${staffingLabel}. ${statusLabel}.` +
    (notices.length ? ` ${notices.join('. ')}.` : '');

  const activate = () => onSelect?.(agent.id);

  return (
    <g
      transform={`translate(${seat.screenX} ${seat.screenY})`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      data-testid={`hq-agent-${agent.id}`}
      data-agent-id={agent.id}
      data-head={agent.isHead ? 'true' : 'false'}
      data-status={agent.status}
      data-staffing={agent.staffing}
      data-binding={agent.bindingKind}
      className="group cursor-pointer outline-none"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
    >
      {/* S4 bounded hit area: the label box 128 wide, seat point to 104 above it. */}
      <rect x={-64} y={-104} width={128} height={124} fill="transparent" />
      {/* Focus ring: non-text contrast ≥3:1 (brand-700 on white), keyboard-only. */}
      <rect
        x={-64}
        y={-104}
        width={128}
        height={124}
        rx={10}
        className={`fill-none stroke-brand-700 ${
          selected ? 'stroke-2' : 'stroke-[1.5] opacity-0 group-focus-visible:opacity-100'
        }`}
      />

      {/* Figure: upright, standing on the seat's projected point. */}
      <ellipse cx={0} cy={0} rx={22} ry={8} className="fill-bcc-border" />
      <path
        d="M -13 0 L -11 -24 Q 0 -31 11 -24 L 13 0 Z"
        className="fill-brand-100 stroke-brand-600"
        strokeWidth={1.5}
      />
      <circle cx={0} cy={-34} r={9} className="fill-brand-100 stroke-brand-600" strokeWidth={1.5} />

      {/* S4: a head has a visible title/role marker — a text plate, not a tint.
          brand-800 behind white text measures 5.13:1 (brand-700 is only 4.12:1). */}
      {agent.isHead && (
        <g transform="translate(0 -100)">
          <rect x={-24} y={-9} width={48} height={16} rx={8} className="fill-brand-800" />
          <text x={0} y={2.5} textAnchor="middle" className="fill-white text-[10px] font-semibold">
            Head
          </text>
        </g>
      )}

      {/* Name and role, always legible text (S3 display name, S11 contrast). Role
          uses the name's fill, not bcc-text-secondary: the figure can stand on the
          selected room's brand-50 floor, where #6B7280 measures 4.298:1 — below the
          S11 floor — while #1A1D26 measures 14.96:1 there. */}
      <text x={0} y={-68} textAnchor="middle" className="fill-bcc-text text-[12px] font-semibold">
        {displayName}
      </text>
      <text x={0} y={-56} textAnchor="middle" className="fill-bcc-text text-[10px]">
        {agent.role}
      </text>

      {/* Status: shape + word. Unknown never renders as a cheerful quiet default.
          The word keeps the token text fill; only the mark is per-status (map above). */}
      <g transform="translate(0 14)" className={HQ_STATUS_MARK[agent.status]}>
        <g transform="translate(-14 0)">
          <StatusMark status={agent.status} />
        </g>
        <text x={-4} y={3} className="fill-bcc-text text-[10px] font-medium">
          {statusLabel}
        </text>
      </g>

      {/* S4: on-call badge reports staffing, not occupancy. */}
      {agent.staffing === 'on-call' && (
        <g transform="translate(0 30)">
          <rect x={-22} y={-8} width={44} height={15} rx={7} className="fill-bcc-border-light stroke-bcc-border" />
          {/* Token text fill, not bcc-text-secondary: the badge's own #F3F4F6 fill
              drops #6B7280 to 4.393:1 there (the token fill is 15.29:1). */}
          <text x={0} y={3} textAnchor="middle" className="fill-bcc-text text-[10px]">
            On-call
          </text>
        </g>
      )}

      {/* S3 conflict strings, in the warning tone, as words. amber-800, not amber-700:
          a figure can stand over the selected room's brand-50 floor or the rug, where
          amber-700 measures 4.464:1 — below the S11 floor (amber-800 is 6.30:1 there). */}
      {notices.map((notice, index) => (
        <text
          key={notice}
          x={0}
          y={(agent.staffing === 'on-call' ? 44 : 30) + index * 11}
          textAnchor="middle"
          className="fill-amber-800 text-[9px] font-medium"
        >
          {notice}
        </text>
      ))}
    </g>
  );
}

/**
 * review.ts — client-review derivations for the launch screens (UL-028, lane L13).
 *
 * Pure functions only: the two launch pages render whatever these return.
 * No writes, no sends, no account access — the same contract as launch-runs.ts.
 *
 * Rules this module enforces:
 *   - a preview link exists only for a page unit whose plan value parses as an
 *     http(s) URL (never a `javascript:` or relative string);
 *   - exactly one next action is offered for a run;
 *   - a run is never described as live: "draft" is the only publication state
 *     this read-only screen can observe.
 */

import type { LaunchRun, LaunchUnit, LaunchUnitState } from '@/lib/launch-runs';

/** States that still need the client's decision or work. */
const OPEN_STATES: ReadonlySet<LaunchUnitState> = new Set<LaunchUnitState>([
  'pending',
  'running',
  'failed',
  'blocked',
]);

export interface PreviewLink {
  unitId: string;
  href: string;
  /** Descriptive link text — never "click here". */
  label: string;
}

export interface Packet {
  previews: PreviewLink[];
  /** Page units with no real URL yet — the client must supply one. */
  missingPreviews: LaunchUnit[];
  messages: LaunchUnit[];
  automations: LaunchUnit[];
  /** Kinds planned nowhere in this run; the screen omits those routes. */
  absentKinds: Array<'pages' | 'emails' | 'texts' | 'automations' | 'conversation_ai'>;
}

export type NextActionKind = 'preview' | 'build' | 'resolve' | 'go-live';

export interface NextAction {
  kind: NextActionKind;
  /** One imperative sentence. */
  label: string;
  /** Why this is the next step. */
  detail: string;
  href: string | null;
  unitId: string | null;
}

export interface PublicationState {
  tone: 'draft' | 'attention' | 'ready';
  /** Short badge text. */
  label: string;
  /** One sentence the client can act on. */
  detail: string;
  /** True only when every planned unit is complete. Still a draft. */
  ready: boolean;
}

export interface DiagnosticRow {
  id: string;
  kind: LaunchUnit['kind'];
  state: LaunchUnitState;
  waitsFor: string[];
}

/** Accept only an absolute http(s) URL. Returns null for anything else. */
export function safeHttpUrl(value: string): string | null {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Preview link for a page unit. launch-runs.ts stores the plan URL in `detail`
 * for page units, and the literal "planned, no URL yet" when the plan has none.
 */
export function previewLink(unit: LaunchUnit): PreviewLink | null {
  if (unit.kind !== 'page') return null;
  const href = safeHttpUrl(unit.detail);
  if (!href) return null;
  return {
    unitId: unit.id,
    href,
    label: `Open the ${unit.label} preview (opens in a new tab)`,
  };
}

function openUnit(run: LaunchRun): LaunchUnit | undefined {
  return run.units.find((unit) => OPEN_STATES.has(unit.state));
}

/** Exactly one next action for a run, or the go-live review when all units are done. */
export function nextAction(run: LaunchRun): NextAction {
  const unit = openUnit(run);
  if (!unit) {
    if (run.totalUnits === 0) {
      return {
        kind: 'build',
        label: 'Add the launch plan',
        detail: 'No units are planned yet, so there is nothing to review.',
        href: null,
        unitId: null,
      };
    }
    return {
      kind: 'go-live',
      label: 'Review the packet, then choose go-live',
      detail:
        'Every planned unit is complete. This screen cannot approve, publish or send — go-live stays a separate, explicit decision.',
      href: null,
      unitId: null,
    };
  }

  if (unit.state === 'failed' || unit.state === 'blocked') {
    return {
      kind: 'resolve',
      label: `Resolve the ${unit.label}`,
      detail: unit.detail,
      href: null,
      unitId: unit.id,
    };
  }

  const preview = previewLink(unit);
  if (preview) {
    return {
      kind: 'preview',
      label: `Review the ${unit.label} preview`,
      detail: preview.href,
      href: preview.href,
      unitId: unit.id,
    };
  }

  return {
    kind: 'build',
    label: `Finish the ${unit.label}`,
    detail:
      unit.kind === 'page' && !safeHttpUrl(unit.detail)
        ? 'Add the real preview URL for this page, then review it.'
        : unit.detail,
    href: null,
    unitId: unit.id,
  };
}

/** Draft-ready vs live. This read-only screen can only ever observe a draft. */
export function publicationState(run: LaunchRun): PublicationState {
  const attention = run.units.some(
    (unit) => unit.state === 'failed' || unit.state === 'blocked',
  );
  if (attention) {
    return {
      tone: 'attention',
      label: 'Draft — needs attention, not live',
      detail: 'A failed or blocked unit must be resolved before this run can launch.',
      ready: false,
    };
  }
  if (run.totalUnits > 0 && run.doneUnits === run.totalUnits) {
    return {
      tone: 'ready',
      label: 'Draft complete — not live',
      detail:
        'Every planned unit is built as a draft. Going live is a separate decision this screen cannot make.',
      ready: true,
    };
  }
  if (run.totalUnits === 0) {
    return {
      tone: 'draft',
      label: 'No units planned — not live',
      detail: 'The launch plan has no units yet.',
      ready: false,
    };
  }
  return {
    tone: 'draft',
    label: 'Draft in progress — not live',
    detail: `${run.doneUnits} of ${run.totalUnits} units are complete. Nothing here sends or goes live.`,
    ready: false,
  };
}

/** Group previews and drafts into one review packet without approving anything. */
export function buildPacket(run: LaunchRun): Packet {
  const previews: PreviewLink[] = [];
  const missingPreviews: LaunchUnit[] = [];
  const messages: LaunchUnit[] = [];
  const automations: LaunchUnit[] = [];

  for (const unit of run.units) {
    if (unit.kind === 'page') {
      const preview = previewLink(unit);
      if (preview) previews.push(preview);
      else missingPreviews.push(unit);
      continue;
    }
    if (unit.kind === 'email' || unit.kind === 'text') {
      messages.push(unit);
      continue;
    }
    if (unit.kind === 'automation') automations.push(unit);
  }

  const absentKinds: Packet['absentKinds'] = [];
  if (!run.units.some((unit) => unit.kind === 'page')) absentKinds.push('pages');
  if (!run.units.some((unit) => unit.kind === 'email')) absentKinds.push('emails');
  if (!run.units.some((unit) => unit.kind === 'text')) absentKinds.push('texts');
  if (!run.units.some((unit) => unit.kind === 'automation')) absentKinds.push('automations');
  if (!run.conversationAi.requested) absentKinds.push('conversation_ai');

  return { previews, missingPreviews, messages, automations, absentKinds };
}

/** Collapsible technical detail: ids, waits and the source file. */
export function diagnosticRows(run: LaunchRun): DiagnosticRow[] {
  return run.units.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    state: unit.state,
    waitsFor: unit.waits_for,
  }));
}

/** Linked error summary text — the page renders count + anchor to the detail list. */
export function errorSummary(errors: readonly string[]): {
  count: number;
  heading: string;
  anchor: string;
} | null {
  if (errors.length === 0) return null;
  return {
    count: errors.length,
    heading:
      errors.length === 1
        ? '1 file could not be read'
        : `${errors.length} files could not be read`,
    anchor: '#file-errors',
  };
}

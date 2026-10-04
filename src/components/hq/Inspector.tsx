'use client';

/**
 * Inspector — B27 (WF-BUILD-C slot 7, milestone V10). Sole owner of this path
 * (`evidence/contracts/view-bindings.md` component-owner map).
 *
 * Detail for the selected department / agent / activity record plus the
 * authorized source links Q10 checks. Consumes the frozen P01 contract
 * (`@/lib/hq/types`) and renders only what the SPEC projects to a browser:
 * S3 identity and its conflict labels, S5 safe content (allowlisted fields,
 * escaped text), S7 foreign-or-unknown and tombstone handling, S8 detail.
 *
 * Presentational only: no fetch, no state. The shell (B30) owns selection and
 * server-authoritative data, so a panel with no selection can never be
 * mistaken for an empty company.
 *
 * Safety boundaries kept inside this component rather than in a caller:
 * - payload text renders as text (React escaping); no `dangerouslySetInnerHTML`,
 *   no markdown, no auto-executed links or commands;
 * - the only hrefs are built from canonical IDs we validate, never from payload
 *   text, so a hostile message cannot emit a navigable target;
 * - a tombstone renders a label only. The tombstone payload is `unknown` by
 *   contract (gap G-15), so it is never rendered — no retained secret names can
 *   leak through it;
 * - a foreign record and an unknown record render the SAME not-available state
 *   (S7: "404 foreign/unknown with same response shape"), so the panel cannot
 *   be used to probe which IDs exist.
 */

import type { ReactNode } from 'react';
import StatusPill from '@/components/ui/StatusPill';
import type {
  HqActivityEvent,
  HqAgent,
  HqDepartment,
  HqPublicDecisionPayload,
  HqPublicExchangePayload,
  HqPublicOwnerNotePayload,
  HqPublicTaskPayload,
} from '@/lib/hq/types';

/* ================================================================== *
 * Contract-shaped props
 * ================================================================== */

/**
 * Activity detail state. `ready`/`tombstone` mirror the S8 detail response
 * (`HqActivityDetailResponse`); the remaining states are the transport states
 * around it. `tombstone` carries no event by construction — see gap G-15.
 */
export type HqInspectorActivityDetail =
  | { state: 'loading' }
  | { state: 'ready'; event: HqActivityEvent }
  | { state: 'tombstone' }
  | { state: 'notAvailable' }
  | { state: 'error'; code: string };

/** What the panel is inspecting. Selection itself belongs to the shell. */
export type HqInspectorSelection =
  | { kind: 'department'; department: HqDepartment }
  | { kind: 'agent'; agent: HqAgent; departmentName?: string | null }
  | { kind: 'activity'; activityId: string; detail: HqInspectorActivityDetail };

export interface HqInspectorProps {
  selection: HqInspectorSelection | null;
  /** Authorized scope the viewer is already inside; used for source links only. */
  companyId?: string | null;
  /** Fallback workspace binding for source links when the selection has none. */
  departmentId?: string | null;
  onClose?: () => void;
  'data-testid'?: string;
}

/* ================================================================== *
 * Authorized source links
 * ================================================================== */

/** Existing board destination; no fork, no new route (SPEC S4 navigation). */
export const HQ_BOARD_TASK_ROUTE = '/tasks/by-department';

/**
 * Board link for a task, carrying the validated company/department/task
 * filters S4 requires. Returns null when there is no canonical task ID: an
 * unbound record is a coverage fact (S5 step 6), never a link to a guessed
 * task ("no placeholder success").
 */
export function hqBoardTaskHref(input: {
  taskId: string | null;
  companyId?: string | null;
  workspaceId?: string | null;
}): string | null {
  if (!input.taskId) return null;
  const params = new URLSearchParams();
  if (input.companyId) params.set('company', input.companyId);
  if (input.workspaceId) params.set('department', input.workspaceId);
  params.set('task', input.taskId);
  return `${HQ_BOARD_TASK_ROUTE}?${params.toString()}`;
}

export function hqAgentHref(input: { agentId: string; workspaceId?: string | null }): string {
  const params = new URLSearchParams();
  if (input.workspaceId) params.set('department', input.workspaceId);
  params.set('agent', input.agentId);
  return `/tasks/all?${params.toString()}`;
}

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-[44px] items-center text-label font-medium text-brand-800 underline decoration-brand-300 underline-offset-2 hover:text-brand-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 rounded-xl px-1"
    >
      {children}
    </a>
  );
}

/** Explicit missing-binding marker — never a dead link, never a silent blank. */
function MissingBinding({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-xl border border-dashed border-bcc-border bg-bcc-border-light px-2 py-0.5 text-caption text-bcc-text-secondary">
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-bcc-text-secondary">{label}</dt>
      <dd className="text-label text-bcc-text break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-bcc-text-secondary">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Safe text block: text is rendered as text, so hostile markup cannot execute. */
function SafeText({ text, empty }: { text: string | null; empty: string }) {
  if (text === null || text === '') {
    return <p className="text-label text-bcc-text-secondary italic">{empty}</p>;
  }
  return <p className="text-label text-bcc-text whitespace-pre-wrap break-words">{text}</p>;
}

/* ================================================================== *
 * Payload detail (S5 allowlisted public fields only)
 * ================================================================== */

function TaskDetail({ payload }: { payload: HqPublicTaskPayload }) {
  // The task's board link lives in the Links section, where the authorized
  // company/department scope is applied once for every kind.
  return (
    <div className="flex items-center gap-2">
      <StatusPill status={payload.status ?? 'unknown'} />
      {payload.previousStatus ? (
        <span className="text-caption text-bcc-text-secondary">was {payload.previousStatus}</span>
      ) : null}
    </div>
  );
}

function OwnerNoteDetail({ payload }: { payload: HqPublicOwnerNotePayload }) {
  return <SafeText text={payload.text} empty="No note text retained" />;
}

function DecisionDetail({ payload, phase }: { payload: HqPublicDecisionPayload; phase: string }) {
  return (
    <div className="flex flex-col gap-3">
      {/* S5: shadow is explicitly non-applied; unavailable is not a zero-confidence decision. */}
      {phase === 'shadow' ? (
        <p className="text-label text-bcc-text-secondary">
          Shadow — recorded for comparison, not applied.
        </p>
      ) : null}
      {phase === 'unavailable' ? (
        <p className="text-label text-bcc-text-secondary">
          Route unavailable — no decision was applied.
        </p>
      ) : null}
      <dl className="flex flex-col gap-2">
        <Field label="Intent">
          {payload.intent ?? <MissingBinding>Not recorded</MissingBinding>}
        </Field>
        <Field label="Route action">
          {payload.routeAction ?? <MissingBinding>Not recorded</MissingBinding>}
        </Field>
        <Field label="Selected department">
          {payload.departmentSlug ?? <MissingBinding>Nothing selected</MissingBinding>}
        </Field>
        <Field label="Confidence">
          {payload.confidenceBps === null
            ? 'Not supplied'
            : `${payload.confidenceBps} bps (${payload.confidenceBps / 100}%)`}
        </Field>
        <Field label="Fallback">
          {payload.fallback === null ? 'Not recorded' : payload.fallback ? 'Yes' : 'No'}
        </Field>
        <Field label="Mode">{payload.mode}</Field>
        <Field label="Resolved by">
          {payload.resolvedBy ?? <MissingBinding>Not recorded</MissingBinding>}
        </Field>
      </dl>
    </div>
  );
}

function ExchangeDetail({ payload, phase }: { payload: HqPublicExchangePayload; phase: string }) {
  return (
    <div className="flex flex-col gap-3">
      {/*
        S9 honesty: a reply-observed record is proof the receiver answered, not
        that the parent consumed it. `uncertain` never becomes a success label.
      */}
      {phase === 'replied' ? (
        <p className="text-label text-bcc-text-secondary">Reply generated.</p>
      ) : null}
      {phase === 'uncertain' ? (
        <p className="text-label text-bcc-text-secondary">
          Outcome uncertain — send was attempted, delivery not proven.
        </p>
      ) : null}
      <Field label="Summary">
        <SafeText text={payload.summary} empty="No summary recorded" />
      </Field>
      <Field label="Message">
        <SafeText text={payload.message} empty="No message text retained" />
      </Field>
    </div>
  );
}

function SourceLinkForEvent({
  event,
  companyId,
  workspaceId,
}: {
  event: HqActivityEvent;
  companyId?: string | null;
  workspaceId?: string | null;
}) {
  const href = hqBoardTaskHref({ taskId: event.taskId, companyId, workspaceId });
  if (!href) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-caption text-bcc-text-secondary">Task</span>
        <div>
          <MissingBinding>No task binding — coverage only</MissingBinding>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-bcc-text-secondary">Task</span>
      <SourceLink href={href}>Open task {event.taskId} in Board</SourceLink>
    </div>
  );
}

/* ================================================================== *
 * Activity detail
 * ================================================================== */

function ActivityDetail({
  selection,
  companyId,
  departmentId,
}: {
  selection: Extract<HqInspectorSelection, { kind: 'activity' }>;
  companyId?: string | null;
  departmentId?: string | null;
}) {
  const { detail } = selection;

  if (detail.state === 'loading') {
    return (
      <p className="text-label text-bcc-text-secondary" role="status">
        Loading detail…
      </p>
    );
  }

  if (detail.state === 'tombstone') {
    return (
      <div className="flex flex-col gap-2" data-testid="hq-inspector-tombstone">
        <p className="text-label text-bcc-text">
          Source deleted — the activity record was retained.
        </p>
        <p className="text-caption text-bcc-text-secondary">
          Current state: tombstone. Deleted source detail is not shown.
        </p>
      </div>
    );
  }

  if (detail.state === 'notAvailable') {
    // Deliberately identical for foreign and unknown records (S7).
    return (
      <div className="flex flex-col gap-2" data-testid="hq-inspector-not-available">
        <p className="text-label text-bcc-text">Not available</p>
        <p className="text-caption text-bcc-text-secondary">
          This record is not part of your authorized company.
        </p>
      </div>
    );
  }

  if (detail.state === 'error') {
    return (
      <div className="flex flex-col gap-2" data-testid="hq-inspector-error">
        <p className="text-label text-bcc-text">Detail could not be read</p>
        <p className="text-caption text-bcc-text-secondary">Error code: {detail.code}</p>
      </div>
    );
  }

  const { event } = detail;
  const workspaceId = departmentId ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="hq-inspector-activity">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-xl border border-bcc-border bg-bcc-border-light px-2 py-0.5 text-caption font-semibold text-bcc-text">
          {event.kind}
        </span>
        <span className="rounded-xl border border-bcc-border bg-bcc-white px-2 py-0.5 text-caption text-bcc-text-secondary">
          {event.phase}
        </span>
        <span className="text-caption text-bcc-text-secondary">seq {event.seq}</span>
      </div>

      <Section title="Source">
        <dl className="flex flex-col gap-2">
          <Field label="Reference">{event.reference}</Field>
          <Field label="Activity ID">{event.id}</Field>
          <Field label="Actor">{event.actorLabel ?? 'Not recorded'}</Field>
          <Field label="Recipient">{event.recipientLabel ?? 'Not recorded'}</Field>
          <Field label="Occurred">
            <time dateTime={event.occurredAt ?? undefined}>
              {event.occurredAt ?? 'Not recorded'}
            </time>
          </Field>
          <Field label="Received">
            <time dateTime={event.receivedAt}>{event.receivedAt}</time>
          </Field>
        </dl>
      </Section>

      <Section title="Detail">
        {event.kind === 'task' ? (
          <TaskDetail payload={event.payload as HqPublicTaskPayload} />
        ) : null}
        {event.kind === 'owner_note' ? (
          <OwnerNoteDetail payload={event.payload as HqPublicOwnerNotePayload} />
        ) : null}
        {event.kind === 'decision' ? (
          <DecisionDetail payload={event.payload as HqPublicDecisionPayload} phase={event.phase} />
        ) : null}
        {event.kind === 'exchange' ? (
          <ExchangeDetail payload={event.payload as HqPublicExchangePayload} phase={event.phase} />
        ) : null}
      </Section>

      <Section title="Links">
        <SourceLinkForEvent event={event} companyId={companyId} workspaceId={workspaceId} />
      </Section>
    </div>
  );
}

/* ================================================================== *
 * Agent and department detail
 * ================================================================== */

/** S3 identity precedence conflict labels, kept verbatim. */
function agentStateLabels(agent: HqAgent): string[] {
  const labels: string[] = [];
  if (agent.status === 'unknown') labels.push('Status not observed');
  if (!agent.runtimeBound) labels.push('Runtime binding unavailable');
  if (agent.bindingKind === 'department-shared') labels.push('Shared department executor');
  return labels;
}

function AgentDetail({
  agent,
  departmentName,
  companyId,
  departmentId,
}: {
  agent: HqAgent;
  departmentName?: string | null;
  companyId?: string | null;
  departmentId?: string | null;
}) {
  const labels = agentStateLabels(agent);
  const workspaceId = agent.workspaceId || departmentId || null;

  return (
    <div className="flex flex-col gap-4" data-testid="hq-inspector-agent">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-card-title text-bcc-text break-words">{agent.displayName}</h2>
          {agent.isHead ? (
            <span className="rounded-xl border border-brand-300 bg-brand-50 px-2 py-0.5 text-caption font-semibold text-brand-800">
              Head
            </span>
          ) : null}
          {agent.staffing === 'on-call' ? (
            <span className="rounded-xl border border-bcc-border bg-bcc-white px-2 py-0.5 text-caption text-bcc-text-secondary">
              On-call
            </span>
          ) : null}
        </div>
        <p className="text-label text-bcc-text-secondary">{agent.role}</p>
        {departmentName ? (
          <p className="text-caption text-bcc-text-secondary">{departmentName}</p>
        ) : null}
      </div>

      <Section title="Current state">
        <dl className="flex flex-col gap-2">
          <Field label="Status">
            <span>
              {agent.status}
              {agent.observedAt ? (
                <>
                  {' '}
                  — observed <time dateTime={agent.observedAt}>{agent.observedAt}</time>
                </>
              ) : (
                ' — observation time not recorded'
              )}
            </span>
          </Field>
          <Field label="Runtime binding">
            {agent.runtimeBound ? (
              agent.runtimeAgentId ?? (
                <MissingBinding>Runtime ID not observed</MissingBinding>
              )
            ) : (
              <MissingBinding>Runtime binding unavailable</MissingBinding>
            )}
          </Field>
          <Field label="Binding kind">{agent.bindingKind}</Field>
          {agent.sharedRoleIds.length > 0 ? (
            <Field label="Shared with">
              {agent.sharedRoleIds.length} additional role seat
              {agent.sharedRoleIds.length === 1 ? '' : 's'}
            </Field>
          ) : null}
        </dl>
        {labels.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <li
                key={label}
                className="rounded-xl border border-bcc-border bg-bcc-border-light px-2 py-0.5 text-caption text-bcc-text-secondary"
              >
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        {agent.bindingKind === 'unbound' || !agent.canTalk ? (
          <p className="text-caption text-bcc-text-secondary">
            Talk unavailable — this role has no runtime binding, so no conversation
            can be opened. Setup incomplete.
          </p>
        ) : null}
      </Section>

      <Section title="Assigned tasks">
        {agent.activeTaskIds.length === 0 ? (
          <MissingBinding>No task binding observed</MissingBinding>
        ) : (
          <ul className="flex flex-col">
            {agent.activeTaskIds.map((taskId) => {
              const href = hqBoardTaskHref({ taskId, companyId, workspaceId });
              return (
                <li key={taskId}>
                  {href ? (
                    <SourceLink href={href}>Open task {taskId} in Board</SourceLink>
                  ) : (
                    <span className="text-label text-bcc-text">{taskId}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function DepartmentDetail({ department }: { department: HqDepartment }) {
  const head = department.headAgentId
    ? department.agents.find((agent) => agent.id === department.headAgentId) ?? null
    : null;

  return (
    <div className="flex flex-col gap-4" data-testid="hq-inspector-department">
      <div className="flex flex-col gap-1">
        <h2 className="text-card-title text-bcc-text break-words">{department.name}</h2>
        <p className="text-caption text-bcc-text-secondary">{department.slug}</p>
      </div>

      <Section title="Current state">
        <dl className="flex flex-col gap-2">
          <Field label="Setup">
            {department.provisioning === 'incomplete'
              ? 'Setup incomplete'
              : department.provisioning === 'unknown'
                ? 'Setup not observed'
                : 'Setup complete'}
          </Field>
          <Field label="Head">
            {department.headAgentId === null ? (
              <MissingBinding>No head binding</MissingBinding>
            ) : head ? (
              head.displayName
            ) : (
              <MissingBinding>Head not present in this roster</MissingBinding>
            )}
          </Field>
          <Field label="Seats">{department.agents.length}</Field>
        </dl>
      </Section>

      <Section title="Team">
        <ul className="flex flex-col gap-2">
          {department.agents.map((agent) => (
            <li key={agent.id} className="flex flex-col gap-0.5">
              <span className="text-label text-bcc-text break-words">
                {agent.displayName}
                {agent.isHead ? ' — Head' : ''}
              </span>
              <span className="text-caption text-bcc-text-secondary">
                {agent.role} · {agent.staffing} · {agent.status}
              </span>
              {agentStateLabels(agent).length > 0 ? (
                <span className="text-caption text-bcc-text-secondary">
                  {agentStateLabels(agent).join(' · ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/* ================================================================== *
 * Panel
 * ================================================================== */

export default function Inspector({
  selection,
  companyId = null,
  departmentId = null,
  onClose,
  'data-testid': testId,
}: HqInspectorProps) {
  return (
    <aside
      data-testid={testId ?? 'hq-inspector'}
      aria-label="Detail panel"
      className="flex h-full w-full flex-col gap-4 overflow-y-auto rounded-2xl border border-bcc-border bg-bcc-white p-4 shadow-card"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-label font-semibold uppercase tracking-wide text-bcc-text-secondary">
          {selection?.kind === 'department'
            ? 'Department'
            : selection?.kind === 'agent'
              ? 'Agent'
              : selection?.kind === 'activity'
                ? 'Activity'
                : 'Detail'}
        </h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl border border-bcc-border px-3 text-label text-bcc-text-secondary hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            Close
          </button>
        ) : null}
      </header>

      {selection === null ? (
        <p className="text-label text-bcc-text-secondary" data-testid="hq-inspector-empty">
          Select a department, agent, or activity to see its detail.
        </p>
      ) : null}

      {selection?.kind === 'department' ? (
        <DepartmentDetail department={selection.department} />
      ) : null}

      {selection?.kind === 'agent' ? (
        <AgentDetail
          agent={selection.agent}
          departmentName={selection.departmentName}
          companyId={companyId}
          departmentId={departmentId}
        />
      ) : null}

      {selection?.kind === 'activity' ? (
        <ActivityDetail
          selection={selection}
          companyId={companyId}
          departmentId={departmentId}
        />
      ) : null}
    </aside>
  );
}

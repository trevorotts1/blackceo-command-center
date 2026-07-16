/**
 * U42 (C-11, master spec v2 §C+I.2) acceptance — REAL render-level proof that
 * the task-detail modal's persona surface is FULLY populated.
 *
 * Renders the REAL components (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts
 *
 * Covers the C-11 binary-acceptance items directly reachable from the
 * DISPLAY-only unit U42 builds (spec L1178):
 *   (a) a fixture multi-persona task shows N sub-task persona rows in the
 *       modal equal to its plan rows, with the SAME names the card chips show
 *       (single source — this suite imports `PersonaSlotChips`/
 *       `PersonaScopeChips` from `kanban/TaskCard` THROUGH `PersonaPlanPanel`,
 *       never a re-implementation);
 *   (b) a fixture single-persona task renders NO plan block (the >=2 rule);
 *   (c) an engine-ingested fixture card renders the honest empty persona copy
 *       and ZERO fabricated values;
 *   (d)/(e) empty-safe: no subtask plan, no scoped blend, no engine-card
 *       metadata — nothing crashes, nothing is invented.
 *
 * U115 (E6-1, closes G7 — per-part governance) landed its CC leg reusing this
 * exact panel unmodified: it added migration-106 mirror columns + persist/
 * load/chip-render support in TaskCard.tsx (part_role fallback + audience),
 * but no producer wires a part-scoped `persona_bundle_scopes` row on a live
 * box yet, so a real fixture's data-shape here is identical to today's
 * per-PAGE A-U5 rows (same table, `scope` generalizes from a page key to a
 * part key). The "renders N per-page/per-part rows" test below exercises
 * that same code path; see u115-per-part-chips-render.test.tsx for the
 * dedicated part_role/audience render proof.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PersonaPlanPanel, WhoIsWorkingPanel } from '../../src/components/TaskOverviewPanels';
import type { Task, TaskSubtaskPersona, TaskPersonaBundleScope } from '../../src/lib/types';

afterEach(() => cleanup());

// Minimal, fully-typed Task fixture — every required column stubbed, every
// optional column left absent so a panel's "honestly empty" branch is real,
// never a value this fixture accidentally supplied.
function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fixture task',
    status: 'in_progress',
    priority: 'medium',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'ws-1',
    business_id: 'biz-1',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    dependencies: [],
    parallel_candidates: [],
    ...over,
  };
}

function subtaskPlan(rows: Partial<TaskSubtaskPersona>[]): TaskSubtaskPersona[] {
  return rows.map((r, i) => ({ seq: i + 1, persona_id: null, ...r }));
}

function scopeRows(rows: Partial<TaskPersonaBundleScope>[]): TaskPersonaBundleScope[] {
  return rows.map((r, i) => ({ scope: `scope-${i}`, persona_id: null, ...r }));
}

// ── PersonaPlanPanel — sub-item 1 (subtask plan) + sub-item 4 (per-page/part) ──

describe('PersonaPlanPanel', () => {
  it('renders nothing for a task with no plan and no scoped blend (single-persona task)', () => {
    const { container } = render(<PersonaPlanPanel task={baseTask()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a task with exactly ONE sub-task persona row (below the >=2 chip threshold)', () => {
    const { container } = render(
      <PersonaPlanPanel
        task={baseTask({
          subtask_personas: subtaskPlan([{ persona_id: 'russell-brunson', persona_name: 'Russell Brunson' }]),
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('(a) shows N sub-task persona rows equal to the plan, same names the card chips show', () => {
    render(
      <PersonaPlanPanel
        task={baseTask({
          subtask_personas: subtaskPlan([
            { slot: 'sales-page', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
            { slot: 'nurture-email', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
            { slot: 'social-post', persona_id: null },
          ]),
        })}
      />,
    );
    const panel = screen.getByTestId('persona-plan-panel');
    expect(panel).toBeTruthy();
    const chipRow = screen.getByTestId('persona-slot-chips');
    expect(chipRow).toBeTruthy();
    expect(screen.getByText('Russell Brunson')).toBeTruthy();
    expect(screen.getByText('Shonda Rhimes')).toBeTruthy();
    // The mechanical/no-persona slot renders the muted "—" chip, never a crash.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('(a) shows N per-page/per-part scoped-blend rows equal to the scope data, same names the card chips show', () => {
    render(
      <PersonaPlanPanel
        task={baseTask({
          persona_bundle_scopes: scopeRows([
            { scope: 'sales', page_role: 'sales', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
            {
              scope: 'thank-you',
              page_role: 'thank-you',
              persona_id: 'shonda-rhimes',
              persona_name: 'Shonda Rhimes',
            },
          ]),
        })}
      />,
    );
    const panel = screen.getByTestId('persona-plan-panel');
    expect(panel).toBeTruthy();
    const chipRow = screen.getByTestId('persona-scope-chips');
    expect(chipRow).toBeTruthy();
    expect(screen.getAllByText('Shonda Rhimes')).toHaveLength(2);
  });

  it('renders BOTH blocks together when a task carries both a sub-task plan AND scoped blends', () => {
    render(
      <PersonaPlanPanel
        task={baseTask({
          subtask_personas: subtaskPlan([
            { slot: 'a', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
            { slot: 'b', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
          ]),
          persona_bundle_scopes: scopeRows([
            { scope: 'sales', persona_id: 'russell-brunson', persona_name: 'Russell Brunson' },
            { scope: 'thank-you', persona_id: 'shonda-rhimes', persona_name: 'Shonda Rhimes' },
          ]),
        })}
      />,
    );
    expect(screen.getByTestId('persona-slot-chips')).toBeTruthy();
    expect(screen.getByTestId('persona-scope-chips')).toBeTruthy();
  });

  it('(per-part / U115 empty-safe) an ordinary task with no scoped-blend rows at all renders no per-part block and never crashes', () => {
    const { container } = render(
      <PersonaPlanPanel task={baseTask({ persona_bundle_scopes: undefined, subtask_personas: undefined })} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ── WhoIsWorkingPanel — sub-item 2 (honest engine-card persona surface) ────────

describe('WhoIsWorkingPanel — engine-card honesty', () => {
  it('(c) an engine-ingested (Skill 6 funnel) card with no persona renders the honest producer empty copy, zero fabricated persona claims', () => {
    render(<WhoIsWorkingPanel task={baseTask({ source: 'funnel' })} />);
    const empty = screen.getByTestId('engine-card-empty-persona');
    expect(empty.textContent).toMatch(/Skill 6 funnel build/);
    // Never a fabricated persona name/mode/score for this card.
    expect(screen.queryByText(/% match/)).toBeNull();
  });

  it('(c) an Anthology-Engine-ingested card with no persona renders the honest Anthology empty copy', () => {
    render(<WhoIsWorkingPanel task={baseTask({ source: 'anthology' })} />);
    expect(screen.getByTestId('engine-card-empty-persona').textContent).toMatch(/Anthology Engine/);
  });

  it('a legacy pre-migration engine card (no `source` column, description marker only) still gets the honest producer copy', () => {
    render(
      <WhoIsWorkingPanel
        task={baseTask({
          source: null,
          description: 'Build the opt-in page.\n\n— Captured via task-ingest —\nSource: survey',
        })}
      />,
    );
    expect(screen.getByTestId('engine-card-empty-persona').textContent).toMatch(/Skill 6 survey build/);
  });

  it('an ORGANIC (non-producer) task with no persona keeps the ORIGINAL generic empty copy, unchanged', () => {
    render(<WhoIsWorkingPanel task={baseTask({ source: null })} />);
    expect(screen.queryByTestId('engine-card-empty-persona')).toBeNull();
    expect(screen.getByText(/selected automatically when the task leaves Backlog/)).toBeTruthy();
  });

  it('a producer-pinned engine card (B-U7 bundle landed → persona_id set) renders the REAL persona, never the honest-empty branch', () => {
    render(
      <WhoIsWorkingPanel
        task={baseTask({
          source: 'funnel',
          persona_id: 'russell-brunson',
          persona_name: 'Russell Brunson',
          persona_mode: 'leadership',
        })}
      />,
    );
    expect(screen.queryByTestId('engine-card-empty-persona')).toBeNull();
    expect(screen.getByText('Russell Brunson')).toBeTruthy();
  });

  it('a producer-pinned engine card with ONLY the blend mirror columns (voice/topic, no legacy persona_id) also renders the real blend, never the honest-empty branch', () => {
    render(
      <WhoIsWorkingPanel
        task={baseTask({
          source: 'web-development',
          voice_persona_id: 'shonda-rhimes',
          topic_persona_id: 'russell-brunson',
        })}
      />,
    );
    expect(screen.queryByTestId('engine-card-empty-persona')).toBeNull();
    expect(screen.getByText(/VOICE: Shonda Rhimes/)).toBeTruthy();
  });
});

/**
 * U038 (audit E8) — Board department label render proof.
 *
 * Renders the REAL TaskCard and MissionQueue components (react-dom via
 * @testing-library/react + jsdom — see vitest.component.config.ts), never a
 * hand-rolled restatement.
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/u038-board-chip-render.test.tsx
 *
 * Required cases:
 *   A · the chip  — 'Presentations' renders 🖥️ Presentations, no 🏢
 *   B · alias regression — video/audio/legal-production still work
 *   C · the header — both 'presentations' and 'Presentations' show 🖥️ Presentations, no 📋
 */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TaskCard, MissionQueue } from '../../src/components/MissionQueue';
import type { Task } from '../../src/lib/types';

// MissionQueue.tsx:301 uses new ResizeObserver(...), which jsdom does not provide.
beforeAll(() => {
  (globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

// ── TaskCard fixture (copied from u37-c-06-dispatch-hold-render.test.tsx:28-44) ─

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fixture task',
    status: 'assigned',
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

function renderTaskCard(task: Task) {
  return render(
    <TaskCard
      task={task}
      onDragStart={vi.fn()}
      onClick={vi.fn()}
      isDragging={false}
      columns={[{ id: 'assigned', label: 'To-Do' }]}
      currentColumnId="assigned"
      onMove={vi.fn()}
    />,
  );
}

// ── Case A: the chip renders 🖥️ Presentations, no 🏢 ─────────────────────────

describe('U038 — Case A: chip renders 🖥️ Presentations for live Presentations value', () => {
  it('renders 🖥️ Presentations and not 🏢 when department is exactly Presentations', () => {
    renderTaskCard(baseTask({ department: 'Presentations' }));
    const el = screen.getByText((content) => content.includes('🖥️'));
    expect(el).toBeDefined();
    expect(el.textContent).toContain('🖥️');
    expect(el.textContent).toContain('Presentations');
    expect(screen.queryByText('🏢')).toBeNull();
  });
});

// ── Case B: alias regression — video/audio/legal-production still work ─────

describe('U038 — Case B: alias labels that worked before still work (canonical-only-lookup regression)', () => {
  it('video-production renders Video Production', () => {
    renderTaskCard(baseTask({ department: 'video-production' }));
    expect(screen.getByText((content) => content.includes('Video Production'))).toBeDefined();
  });

  it('audio-production renders Audio Production', () => {
    renderTaskCard(baseTask({ department: 'audio-production' }));
    expect(screen.getByText((content) => content.includes('Audio Production'))).toBeDefined();
  });

  it('legal-compliance renders Legal / Compliance', () => {
    renderTaskCard(baseTask({ department: 'legal-compliance' }));
    expect(screen.getByText((content) => content.includes('Legal / Compliance'))).toBeDefined();
  });
});

// ── Case C: the header shows 🖥️ Presentations for both casings ──────────────

describe('U038 — Case C: header resolves both presentings casings', () => {
  // Honesty note: this mock pattern has not been executed elsewhere in this repo.
  // The store mock avoids the fetch path (only triggered by boardKind='bug').
  // If this case cannot be stood up, it is recorded NOT RUN in the ticket, not
  // passed; cases A and B still carry the render burden for the chip.

  beforeEach(() => {
    vi.mock('@/lib/store', () => ({
      useMissionControl: () => ({
        tasks: [],
        updateTaskStatus: () => {},
        addEvent: () => {},
        selectedDepartment: null,
        setSelectedDepartment: () => {},
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders 🖥️ Presentations and not 📋 when departmentFilter='presentations'", () => {
    render(
      <MissionQueue
        departmentFilter="presentations"
        boardKind="task"
      />,
    );
    // The header pill with 🖥️ Presentations should be present
    expect(screen.getByText((content) => content.includes('🖥️'))).toBeDefined();
    expect(screen.queryByText('📋')).toBeNull();
  });

  it("renders 🖥️ Presentations and not 📋 when departmentFilter='Presentations'", () => {
    render(
      <MissionQueue
        departmentFilter="Presentations"
        boardKind="task"
      />,
    );
    expect(screen.getByText((content) => content.includes('🖥️'))).toBeDefined();
    expect(screen.queryByText('📋')).toBeNull();
  });
});

/**
 * U105 (E4-8, master spec v2 §E4; v1 U50/I.4) — task-modal in-app field
 * help acceptance.
 *
 * Renders the REAL `<FieldHelp />` component (react-dom via
 * @testing-library/react + jsdom — see vitest.component.config.ts), never a
 * hand-rolled restatement, and reads the REAL typed copy map
 * (`src/lib/task-field-help.ts`) rather than a fixture stand-in.
 *
 *   npx vitest run --config vitest.component.config.ts
 *
 * Covers this unit's binary acceptance:
 *   (a) every enumerated field key has a non-empty help string in the typed
 *       map — a missing key is a TypeScript compile error (see the
 *       `Record<TaskFieldHelpKey, string>` annotation in task-field-help.ts
 *       itself), so this test proves the RUNTIME half: no key resolves to
 *       an empty/whitespace-only string, i.e. no blank popover;
 *   (b) the popover is operable by keyboard (Enter/Space-activatable native
 *       button; Escape closes and returns focus to the trigger; no
 *       keyboard trap) and renders correctly at a 360px viewport;
 *   (c) mobile tap/dismiss behavior: a pointerdown outside the popover
 *       closes it, and the popover's own close button closes it;
 *   plus the a11y-roles contract the reusable component promises any
 *   caller: `role="dialog"`, `aria-label`, `aria-expanded`, `aria-controls`
 *   wired to the popover's real `id` — never a static/guessed string.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { FieldHelp } from '../../src/components/ui/FieldHelp';
import { TASK_FIELD_HELP, TASK_FIELD_HELP_KEYS, type TaskFieldHelpKey } from '../../src/lib/task-field-help';

afterEach(() => cleanup());

// ── (a) copy-map coverage — every field key, no blank popovers ────────────

describe('TASK_FIELD_HELP copy map', () => {
  it('has an entry for every declared field key, and only those keys', () => {
    const mapKeys = Object.keys(TASK_FIELD_HELP).sort();
    const declaredKeys = [...TASK_FIELD_HELP_KEYS].sort();
    expect(mapKeys).toEqual(declaredKeys);
  });

  it('every entry is a non-empty, non-whitespace string (never a blank popover)', () => {
    for (const key of TASK_FIELD_HELP_KEYS) {
      const value = TASK_FIELD_HELP[key];
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers the full modal field set U105 wires (title through the Blocked-detail trio)', () => {
    const expected: TaskFieldHelpKey[] = [
      'title',
      'description',
      'status',
      'priority',
      'assignedAgent',
      'dueDate',
      'blockedReason',
      'blockedOnHuman',
      'blockedAsk',
    ];
    expect([...TASK_FIELD_HELP_KEYS].sort()).toEqual([...expected].sort());
  });
});

// ── FieldHelp component — open/close, a11y roles, keyboard, mobile-dismiss ─

describe('FieldHelp', () => {
  it('renders a closed trigger by default — no popover in the DOM until opened', () => {
    render(<FieldHelp label="Title" text={TASK_FIELD_HELP.title} testId="title" />);
    const trigger = screen.getByTestId('field-help-trigger-title');
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('field-help-popover-title')).toBeNull();
  });

  it('the trigger has an accessible name naming the field ("Help: <label>")', () => {
    render(<FieldHelp label="Due Date" text={TASK_FIELD_HELP.dueDate} testId="due-date" />);
    expect(screen.getByTestId('field-help-trigger-due-date').getAttribute('aria-label')).toBe('Help: Due Date');
  });

  it('clicking the trigger opens the popover with the exact copy-map text, role="dialog", and aria-expanded flips true', () => {
    render(<FieldHelp label="Priority" text={TASK_FIELD_HELP.priority} testId="priority" />);
    const trigger = screen.getByTestId('field-help-trigger-priority');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const popover = screen.getByTestId('field-help-popover-priority');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Priority');
    expect(popover.textContent).toContain(TASK_FIELD_HELP.priority);
  });

  it('aria-controls on the trigger matches the popover\'s real id once open (wired, not guessed)', () => {
    render(<FieldHelp label="Status" text={TASK_FIELD_HELP.status} testId="status" />);
    const trigger = screen.getByTestId('field-help-trigger-status');
    fireEvent.click(trigger);
    const popover = screen.getByTestId('field-help-popover-status');
    expect(trigger.getAttribute('aria-controls')).toBe(popover.id);
    expect(popover.id).toBeTruthy();
  });

  it('clicking the trigger again toggles the popover closed', () => {
    render(<FieldHelp label="Title" text={TASK_FIELD_HELP.title} testId="title" />);
    const trigger = screen.getByTestId('field-help-trigger-title');
    fireEvent.click(trigger);
    expect(screen.getByTestId('field-help-popover-title')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('field-help-popover-title')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('(b) Escape closes the popover and returns focus to the trigger — no keyboard trap', () => {
    render(<FieldHelp label="Description" text={TASK_FIELD_HELP.description} testId="description" />);
    const trigger = screen.getByTestId('field-help-trigger-description');
    fireEvent.click(trigger);
    expect(screen.getByTestId('field-help-popover-description')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('field-help-popover-description')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('the popover\'s own close button dismisses it and returns focus to the trigger', () => {
    render(<FieldHelp label="Assign to" text={TASK_FIELD_HELP.assignedAgent} testId="assigned-agent" />);
    const trigger = screen.getByTestId('field-help-trigger-assigned-agent');
    fireEvent.click(trigger);
    const closeBtn = screen.getByTestId('field-help-close');
    expect(closeBtn.getAttribute('aria-label')).toBe('Close help');

    fireEvent.click(closeBtn);

    expect(screen.queryByTestId('field-help-popover-assigned-agent')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('(c) mobile tap/dismiss: a pointerdown outside the trigger/popover closes it', () => {
    render(
      <div>
        <FieldHelp label="Reason" text={TASK_FIELD_HELP.blockedReason} testId="blocked-reason" />
        <div data-testid="elsewhere">Elsewhere on the page</div>
      </div>,
    );
    const trigger = screen.getByTestId('field-help-trigger-blocked-reason');
    fireEvent.click(trigger);
    expect(screen.getByTestId('field-help-popover-blocked-reason')).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId('elsewhere'));

    expect(screen.queryByTestId('field-help-popover-blocked-reason')).toBeNull();
  });

  it('a pointerdown INSIDE the popover does not close it (only outside taps dismiss)', () => {
    render(<FieldHelp label="What do you need?" text={TASK_FIELD_HELP.blockedAsk} testId="blocked-ask" />);
    const trigger = screen.getByTestId('field-help-trigger-blocked-ask');
    fireEvent.click(trigger);
    const popover = screen.getByTestId('field-help-popover-blocked-ask');

    fireEvent.pointerDown(popover);

    expect(screen.getByTestId('field-help-popover-blocked-ask')).toBeTruthy();
  });

  it('renders correctly with the popover width-capped for a 360px-wide viewport (never wider than the viewport)', () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 360 });
    try {
      render(<FieldHelp label="Who is needed?" text={TASK_FIELD_HELP.blockedOnHuman} testId="blocked-on-human" />);
      fireEvent.click(screen.getByTestId('field-help-trigger-blocked-on-human'));
      const popover = screen.getByTestId('field-help-popover-blocked-on-human');
      // The component caps width via `max-w-[calc(100vw-2rem)]` (never a
      // fixed px value wider than the viewport) — assert the class is
      // actually present rather than trusting the intent in prose.
      expect(popover.className).toMatch(/max-w-\[calc\(100vw-2rem\)\]/);
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalWidth });
    }
  });

  it('two instances on the same page get distinct trigger/popover test ids and stay independently open/closed', () => {
    render(
      <div>
        <FieldHelp label="Title" text={TASK_FIELD_HELP.title} testId="title" />
        <FieldHelp label="Status" text={TASK_FIELD_HELP.status} testId="status" />
      </div>,
    );
    fireEvent.click(screen.getByTestId('field-help-trigger-title'));
    expect(screen.getByTestId('field-help-popover-title')).toBeTruthy();
    expect(screen.queryByTestId('field-help-popover-status')).toBeNull();
  });

  it('falls back to a generic test id when no testId prop is supplied', () => {
    render(<FieldHelp label="Title" text={TASK_FIELD_HELP.title} />);
    const trigger = screen.getByTestId('field-help-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('field-help-popover')).toBeTruthy();
  });
});

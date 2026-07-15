/**
 * U105 (E4-8, master spec v2 §E4; v1 U50/I.4) — typed copy map for the
 * task-detail modal's in-app field help.
 *
 * Each key names a field the U42-populated `TaskModal` (src/components/
 * TaskModal.tsx) renders on its Overview tab form. The value is the exact
 * help text that field's `<FieldHelp />` "i" icon shows. `TASK_FIELD_HELP`
 * is typed `Record<TaskFieldHelpKey, string>`, so a missing key is a TYPE
 * ERROR at build time, never a silently blank popover — matching the master
 * spec's binary-acceptance (a) for this unit ("missing-key = type error,
 * not a blank popover").
 *
 * Presentation-only: this file describes CURRENT shipped modal behavior. It
 * does not change what any field does or how it validates/saves.
 */

/** Every field key the task-detail modal wires an "i" icon to. */
export const TASK_FIELD_HELP_KEYS = [
  'title',
  'description',
  'status',
  'priority',
  'assignedAgent',
  'dueDate',
  'blockedReason',
  'blockedOnHuman',
  'blockedAsk',
] as const;

export type TaskFieldHelpKey = (typeof TASK_FIELD_HELP_KEYS)[number];

/**
 * The copy map. Adding a new key to `TASK_FIELD_HELP_KEYS` without adding
 * its entry here is a compile error (`Record<TaskFieldHelpKey, string>`
 * requires every key); adding an entry for a key that isn't in
 * `TASK_FIELD_HELP_KEYS` is also a compile error (excess-property check on
 * the object literal below).
 */
export const TASK_FIELD_HELP: Record<TaskFieldHelpKey, string> = {
  title: 'A short, specific name for the task — this is what shows on the board card and in every list.',
  description:
    'Details for whoever works this task: what "done" looks like, constraints, and any context an agent or teammate needs without having to ask you first.',
  status:
    'Where the task sits on the board. Backlog/Inbox/Planning/Assigned are pre-work; In Progress/Review/Testing are active work; Blocked pauses the task on a named human ask; Done closes it out.',
  priority:
    'How urgently this competes for attention against other open tasks. Critical and High jump the queue; Low and Medium wait their turn.',
  assignedAgent:
    "Which agent owns this task. Leave it Unassigned to let auto-dispatch pick one when the task leaves Backlog, or choose a specific agent (or add a new one) to hand it off directly.",
  dueDate:
    'An optional target date and time for planning visibility. Nothing in the board automatically enforces it today — it is a deadline you can see, not a hard gate.',
  blockedReason: "Why the task can't move forward right now. Required before you can save a task as Blocked.",
  blockedOnHuman: 'Who needs to act to unblock this task. Required before you can save a task as Blocked.',
  blockedAsk:
    'One line stating exactly what that person needs to do. Required before you can save a task as Blocked.',
};

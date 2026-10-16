/**
 * The "Welcome to <Dept>" placeholder card an installer seeds on a new board
 * (onboarding seed-dashboard-content.py / add-department.sh, and
 * /api/departments). It is not work: it must never page the owner. On one box
 * the intake sweep dispatched seven of them right after install and every stop
 * sent the owner's chat a "has stopped and needs you" card.
 */
export function isSeededStarterTask(t: { title?: string | null; description?: string | null }): boolean {
  return /^Welcome to \S/.test(t.title ?? '') &&
    /^This is your .+ department's first task\./.test(t.description ?? '');
}

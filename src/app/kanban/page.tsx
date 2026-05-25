import { permanentRedirect } from 'next/navigation';

/**
 * /kanban - PRD 3.8 permanent redirect to /tasks/all.
 *
 * The cross-department all-tasks Kanban now lives at /tasks/all so the
 * URL matches the card label on the home page. We use permanentRedirect
 * (308) so bookmarks update.
 */
export default function KanbanRedirect(): never {
  permanentRedirect('/tasks/all');
}

import { permanentRedirect } from 'next/navigation';

/**
 * /workspace - PRD 3.8 permanent redirect to /tasks/by-department.
 *
 * The department picker now lives at /tasks/by-department so the URL
 * matches the card label on the home page. /workspace/[slug] is unchanged
 * and still serves the focused department view. We use permanentRedirect
 * (308) so bookmarks update.
 */
export default function WorkspaceRedirect(): never {
  permanentRedirect('/tasks/by-department');
}

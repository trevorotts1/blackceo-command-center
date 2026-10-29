/**
 * /council (CWE-033, Skill 77)
 *
 * The council home: the one registered entry target, and the visual
 * chamber (CTR-104) — the room renders first and the question is asked
 * inside it, so entry never depends on finishing an intake form.
 * Authorization is enforced by the council API on every read behind this
 * page (CWE-007); this page renders no session data of its own.
 */

import { CouncilPageShell } from '@/components/council/CouncilPageShell';
import { CouncilHome } from '@/components/council/CouncilHome';

export default function CouncilHomePage() {
  return (
    <CouncilPageShell
      title="Council of Wise Elders"
      lede="The chamber opens first. Bring one decision; nine advisors deliberate against one frozen brief."
    >
      <CouncilHome />
    </CouncilPageShell>
  );
}

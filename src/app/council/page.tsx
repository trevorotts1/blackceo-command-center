/**
 * /council (CWE-033, Skill 77)
 *
 * The council home: the one registered entry target. Authorization is
 * enforced by the council API on every read behind this page
 * (CWE-007); this page renders no session data of its own.
 */

import { CouncilPageShell } from '@/components/council/CouncilPageShell';
import { CouncilHome } from '@/components/council/CouncilHome';

export default function CouncilHomePage() {
  return (
    <CouncilPageShell
      title="Council of Wise Elders"
      lede="Nine advisors, one frozen brief, a verdict you can inspect."
    >
      <CouncilHome />
    </CouncilPageShell>
  );
}

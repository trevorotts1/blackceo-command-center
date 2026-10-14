/**
 * /council/new (CWE-033, Skill 77)
 *
 * The guided intake journey: one question at a time, progress
 * persisted on the device, resume at the exact unanswered question.
 * Prefilled facts arrive only through authorized retrieval; until
 * CWE-050 binds the CC draft service to the CWE-022/CWE-023 ports,
 * this page passes no prefilled facts, and the composer's prefill
 * path stands proven by its render tests with fixture facts.
 */

import { CouncilPageShell } from '@/components/council/CouncilPageShell';
import { DecisionComposer } from '@/components/council/DecisionComposer';

export default function CouncilNewPage() {
  return (
    <CouncilPageShell
      title="Ask the council"
      lede="One question at a time. Your progress is saved on this device as you go, and you can leave and resume exactly where you stopped."
    >
      <DecisionComposer />
    </CouncilPageShell>
  );
}

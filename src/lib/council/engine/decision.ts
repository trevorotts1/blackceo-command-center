/**
 * Deterministic hard-constraint derivation used by the canonical verdict
 * builder (CWE-026, Section 12.3; ported verbatim from
 * 77-council-of-wise-elders/runtime/src/scoring/decision.ts).
 *
 * Findings are APPLIED, never assumed away: where no checker recorded a
 * result, the honest state is `unknown` from deterministic_code. An
 * unchecked hard constraint is not a passed one.
 */
import type { DecisionBrief, HardConstraintFinding } from '../contracts';

export function deriveHardConstraintFindings(
  brief: DecisionBrief,
  recorded: readonly HardConstraintFinding[] = [],
): HardConstraintFinding[] {
  const recordedByKey = new Map<string, HardConstraintFinding>(
    recorded.map((f) => [`${f.constraint_id}::${f.option_id}`, f]),
  );
  const findings: HardConstraintFinding[] = [];
  for (const constraint of brief.constraints) {
    if (!constraint.hard) continue;
    const optionIds =
      constraint.applies_to_option_ids.length > 0
        ? constraint.applies_to_option_ids
        : brief.options.map((o) => o.id);
    for (const optionId of optionIds) {
      const existing = recordedByKey.get(`${constraint.id}::${optionId}`);
      if (existing) {
        findings.push(existing);
      } else {
        findings.push({
          constraint_id: constraint.id,
          option_id: optionId,
          result: 'unknown',
          checker: 'deterministic_code',
          evidence_ids: [],
        });
      }
    }
  }
  return findings;
}

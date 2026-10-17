'use client';

/**
 * VerdictView (CWE-033, Skill 77)
 *
 * The verdict page content in Section 21's fixed order, asserted by
 * the render tests: (1) recommendation, (2) conditions, (3) the three
 * main reasons, (4) the strongest concern, (5) immediate next
 * actions, (6) the full scorecard, (7) detailed rounds and sources.
 * Everything rendered comes from the committed verdict record; scores
 * that do not exist render as "Not scored", never as zero, and
 * weighted support renders as counts, never as a probability
 * (Sections 11.6 and 12). A consult result renders its own bounded
 * shape with no invented scores (Section 11.5).
 */

import type { DecisionBrief, Verdict } from '@/lib/council/contracts/types';
import { council } from './council-theme';
import { seatDisplayName } from './council-journey-types';

const VERDICT_LABEL_TEXT: Record<string, string> = {
  GO: 'Go',
  GO_WITH_CONDITIONS: 'Go, with conditions',
  RESHAPE: 'Reshape the decision',
  DONT_DO_IT: 'Do not do it',
  WAIT: 'Wait',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

function Section({
  order,
  name,
  title,
  children,
}: {
  order: number;
  name: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="council-journey-verdict-section"
      data-section={name}
      data-section-order={order}
      data-testid={`verdict-section-${name}`}
    >
      <h2 className={council.heading}>{title}</h2>
      {children}
    </section>
  );
}

export function VerdictView({
  verdict,
  brief,
}: {
  verdict: Verdict;
  brief: DecisionBrief | null;
}) {
  if (verdict.result_kind === 'consult') {
    const card = verdict.consult_card;
    return (
      <div data-testid="verdict-view" data-result-kind="consult">
        <Section order={1} name="recommendation" title="Consult answer">
          <p className={council.meta}>
            This session was a bounded consult, not a scored council decision. No scores were
            produced.
          </p>
          <p>{card.answer}</p>
          {card.assumptions.length > 0 ? (
            <>
              <h3>Assumptions</h3>
              <ul>
                {card.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          ) : null}
          {card.limits.length > 0 ? (
            <>
              <h3>Limits of this answer</h3>
              <ul>
                {card.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>
        <Section order={2} name="next-actions" title="Next step">
          <p>{verdict.next_step}</p>
        </Section>
      </div>
    );
  }

  const optionLabel = (id: string | null): string => {
    if (!id) return 'No option recommended';
    return brief?.options.find((o) => o.id === id)?.label ?? id;
  };

  return (
    <div data-testid="verdict-view" data-result-kind="scored">
      <Section order={1} name="recommendation" title="Recommendation">
        <p>
          <strong>{VERDICT_LABEL_TEXT[verdict.label] ?? verdict.label}:</strong>{' '}
          {optionLabel(verdict.recommended_option_id)}
        </p>
        <p className={council.meta}>
          Evidence strength: {verdict.evidence_strength}. Validation:{' '}
          {verdict.validation_status}. Ratification: {verdict.ratification_status}.
        </p>
      </Section>

      <Section order={2} name="conditions" title="Conditions">
        {verdict.prerequisites.length === 0 && verdict.hard_constraint_findings.length === 0 ? (
          <p className={council.meta}>No conditions or prerequisites were recorded.</p>
        ) : null}
        {verdict.prerequisites.length > 0 ? (
          <>
            <h3>Prerequisites</h3>
            <ul>
              {verdict.prerequisites.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : null}
        {verdict.hard_constraint_findings.length > 0 ? (
          <>
            <h3>Hard constraint findings</h3>
            <ul>
              {verdict.hard_constraint_findings.map((finding) => (
                <li key={`${finding.constraint_id}-${finding.option_id}`}>
                  {optionLabel(finding.option_id)}: {finding.result} (checked by{' '}
                  {finding.checker})
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {verdict.stop_criteria.length > 0 ? (
          <>
            <h3>Stop criteria</h3>
            <ul>
              {verdict.stop_criteria.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      <Section order={3} name="main-reasons" title="Three main reasons">
        {verdict.main_reasons.length === 0 ? (
          <p className={council.meta}>No main reasons were recorded.</p>
        ) : (
          <ol>
            {verdict.main_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ol>
        )}
      </Section>

      <Section order={4} name="strongest-concern" title="Strongest concern">
        <p>{verdict.strongest_dissent ?? 'No dissent was recorded.'}</p>
        {verdict.critical_unknowns.length > 0 ? (
          <>
            <h3>Critical unknowns</h3>
            <ul>
              {verdict.critical_unknowns.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      <Section order={5} name="next-actions" title="Immediate next actions">
        {verdict.action_proposals.length === 0 ? (
          <p className={council.meta}>No action proposals were recorded.</p>
        ) : (
          <ul>
            {verdict.action_proposals.map((proposal) => (
              <li key={proposal.action_id}>
                <strong>{proposal.title}.</strong> {proposal.description}
                {proposal.department_id ? (
                  <span className={council.meta}> Department: {proposal.department_id}.</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {verdict.cheapest_informative_test ? (
          <p>
            <strong>Cheapest informative test:</strong> {verdict.cheapest_informative_test}
          </p>
        ) : null}
      </Section>

      <Section order={6} name="scorecard" title="Full scorecard">
        <table className="council-journey-table" data-testid="verdict-scorecard">
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col">Score</th>
              <th scope="col">Coverage</th>
              <th scope="col">Spread</th>
              <th scope="col">Weighted sum</th>
            </tr>
          </thead>
          <tbody>
            {verdict.option_scores.map((score) => (
              <tr key={score.option_id}>
                <td>{optionLabel(score.option_id)}</td>
                <td>{score.display_score === null ? 'Not scored' : score.display_score}</td>
                <td>{Math.round(score.coverage * 100)}%</td>
                <td>{score.spread === null ? 'Not scored' : score.spread}</td>
                <td>
                  {score.weighted_sum} / {score.denominator}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={council.meta}>
          Active weights:{' '}
          {Object.entries(verdict.active_weights)
            .map(([seatId, weight]) => `${seatDisplayName(seatId)} ${weight}`)
            .join(', ') || 'none recorded'}
          .
        </p>
        {verdict.resolution_support ? (
          <p className={council.meta}>
            Resolution support (weighted counts, never a probability): support{' '}
            {verdict.resolution_support.support}, conditional{' '}
            {verdict.resolution_support.conditional_support}, opposition{' '}
            {verdict.resolution_support.opposition}, abstention{' '}
            {verdict.resolution_support.abstention}.
          </p>
        ) : null}
      </Section>

      <Section order={7} name="rounds-and-sources" title="Detailed rounds and sources">
        <p className={council.meta}>
          Per-seat rounds are read in the room and reading views on this session page. The
          committed verdict record behind this page:
        </p>
        <ul>
          <li>
            Brief hash <span className="council-journey-hash">{verdict.brief_sha256}</span>
          </li>
          <li>
            Verdict content hash{' '}
            <span className="council-journey-hash">{verdict.content_sha256}</span>
          </li>
          <li>
            Amendments accepted: {verdict.accepted_amendments.length}; rejected:{' '}
            {verdict.rejected_amendments.length}.
          </li>
        </ul>
        {verdict.review_criteria.length > 0 ? (
          <>
            <h3>Review criteria</h3>
            <ul>
              {verdict.review_criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>
    </div>
  );
}

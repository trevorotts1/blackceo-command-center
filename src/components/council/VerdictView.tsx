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
import {
  acceptanceCriteriaDisplay,
  dedupeExact,
  planListDisplay,
  readConsultVerdict,
  readScoredVerdict,
  summarizeConditions,
} from '@/lib/council/report-reading';
import { council } from './council-theme';
import { seatDisplayName } from './council-journey-types';

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
    const reading = readConsultVerdict({
      seat_display_name: seatDisplayName(card.seat_id),
    });
    return (
      <div data-testid="verdict-view" data-result-kind="consult">
        <Section order={1} name="recommendation" title="Consult answer">
          <p className={council.meta} data-testid="verdict-start-here">
            Start here: one recorded seat answered. This is advice, not a scored
            council verdict, and there is no plan to approve.
          </p>
          <p>
            <strong>{reading.decision}.</strong> {reading.reading}
          </p>
          <p className={council.meta}>Readiness: {reading.readiness_headline}</p>
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
  const conditions = summarizeConditions({
    prerequisites: verdict.prerequisites,
    hardFindings: verdict.hard_constraint_findings,
  });
  const reading = readScoredVerdict({
    label: verdict.label,
    recommended_option_label:
      verdict.recommended_option_id === null
        ? null
        : optionLabel(verdict.recommended_option_id),
    conditions,
  });
  const unknowns = dedupeExact(verdict.critical_unknowns);

  return (
    <div data-testid="verdict-view" data-result-kind="scored">
      <Section order={1} name="recommendation" title="Recommendation">
        <p className={council.meta} data-testid="verdict-start-here">
          Start here: this is the recorded decision. The conditions come next; the
          full scorecard and the technical record are behind the disclosures below.
        </p>
        <p data-testid="verdict-decision">
          <strong>{reading.decision}.</strong>
        </p>
        <p data-testid="verdict-reading">{reading.reading}</p>
        <p className={council.meta} data-testid="verdict-readiness">
          Readiness: {reading.readiness_headline}
        </p>
        <p className={council.meta}>
          Evidence strength: {verdict.evidence_strength}. Validation:{' '}
          {verdict.validation_status}. Ratification: {verdict.ratification_status}.
        </p>
      </Section>

      <Section order={2} name="conditions" title="Conditions">
        <p className={council.meta} data-testid="verdict-condition-counts">
          {conditions.total} recorded · {conditions.open} open · {conditions.satisfied}{' '}
          satisfied · {conditions.waived} waived by the owner · {conditions.unresolved}{' '}
          unresolved · {conditions.blocking_open} blocking and open.
        </p>
        {conditions.items.length === 0 ? (
          <p className={council.meta}>
            No conditions or prerequisites were recorded on this verdict. Seat-level
            conditions, when a card records them, stay in the room and reading views.
          </p>
        ) : (
          <ul>
            {conditions.items.map((item) => (
              <li key={`${item.source}-${item.id}`}>
                {item.description}{' '}
                <span className={council.meta}>
                  ({item.kind}, {item.status}
                  {item.blocking ? ', blocking' : ''})
                </span>
              </li>
            ))}
          </ul>
        )}
        {verdict.stop_criteria.length > 0 ? (
          <>
            <h3>Stop criteria</h3>
            <ul>
              {verdict.stop_criteria.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className={council.meta}>
            {planListDisplay(verdict.stop_criteria, 'stop criterion').note}
          </p>
        )}
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
        {unknowns.recorded > 0 ? (
          <>
            <h3>Critical unknowns</h3>
            <p className={council.meta} data-testid="verdict-unknown-counts">
              {unknowns.recorded} recorded · {unknowns.distinct} distinct
              {unknowns.collapsed > 0
                ? ` · ${unknowns.collapsed} exact repeat(s) printed once`
                : ''}
            </p>
            {unknowns.note ? <p className={council.meta}>{unknowns.note}</p> : null}
            <ul>
              {unknowns.items.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className={council.meta}>No critical unknowns were recorded.</p>
        )}
      </Section>

      <Section order={5} name="next-actions" title="Immediate next actions">
        {verdict.action_proposals.length === 0 ? (
          <p className={council.meta}>No action proposals were recorded.</p>
        ) : (
          <ul>
            {verdict.action_proposals.map((proposal) => {
              const acceptance = acceptanceCriteriaDisplay(proposal.acceptance_criteria);
              return (
                <li key={proposal.action_id} data-testid={`verdict-action-${proposal.action_id}`}>
                  <strong>{proposal.title}.</strong> {proposal.description}
                  {proposal.department_id ? (
                    <span className={council.meta}> Department: {proposal.department_id}.</span>
                  ) : null}
                  <div className={council.meta}>
                    Done when:{' '}
                    {acceptance.not_ready ? (
                      <span data-testid={`verdict-action-${proposal.action_id}-not-ready`}>
                        {acceptance.note}
                      </span>
                    ) : (
                      acceptance.items.join('; ')
                    )}
                  </div>
                  <div className={council.meta}>
                    Depends on:{' '}
                    {proposal.depends_on_action_ids.length > 0
                      ? proposal.depends_on_action_ids.join(', ')
                      : 'none'}{' '}
                    · Risk class: {proposal.risk_class}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {verdict.cheapest_informative_test ? (
          <p>
            <strong>Cheapest informative test:</strong> {verdict.cheapest_informative_test}
          </p>
        ) : null}
      </Section>

      <Section order={6} name="scorecard" title="Full scorecard">
        <details data-testid="verdict-scorecard-disclosure">
          <summary className={council.meta}>
            Open the full scorecard and the weighting record
          </summary>
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
        </details>
      </Section>

      <Section order={7} name="rounds-and-sources" title="Detailed rounds and sources">
        <p className={council.meta}>
          Per-seat rounds are read in the room and reading views on this session page. The
          committed verdict record behind this page:
        </p>
        <details data-testid="verdict-records-disclosure">
          <summary className={council.meta}>Open the committed record identifiers</summary>
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
        </details>
      </Section>
    </div>
  );
}

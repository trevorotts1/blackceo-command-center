'use client';

/**
 * CouncilVerdict (CWE-034, Skill 77) - the verdict screen.
 *
 * Section 21.2 fixes the page order, and this component renders
 * exactly that order and nothing else first:
 *   1. Recommendation
 *   2. Conditions
 *   3. Three main reasons
 *   4. Strongest concern (the recorded strongest dissent)
 *   5. Immediate next actions
 *   6. Full scorecard
 *   7. Detailed rounds and sources
 *
 * The foreground is ONE recommendation with its strongest dissent
 * and conditions (T103), never nine equal answers. Score coverage
 * and qualification labels render exactly as recorded: a display
 * score of null reads "Not scored", never 0, and support figures are
 * counts, never a probability (Section 11.6). A verdict whose
 * recorded validation status is not 'valid', or that fails the
 * canonical shape, renders the explicit invalid-verdict state
 * (classifyVerdictRead in council-session-types.ts); a session with
 * no committed verdict renders the explicit not-ready state. Neither
 * is ever dressed up as a result.
 */

import { council } from './council-theme';
import type { CouncilCard, DecisionBrief, Verdict } from '@/lib/council/contracts';
import {
  classifyVerdictRead,
  qualificationLabel,
  type VerdictClassification,
} from './council-session-types';
import { seatIdentity, type CouncilRoomMode } from './council-room-types';
import { CouncilExportMenu } from './CouncilExportMenu';
import type { CouncilExportRequest } from './council-session-client';

const LABEL_TEXT: Readonly<Record<string, string>> = {
  GO: 'Go',
  GO_WITH_CONDITIONS: 'Go, with conditions',
  RESHAPE: 'Reshape the plan',
  DONT_DO_IT: 'Do not do it',
  WAIT: 'Wait',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

const RATIFICATION_TEXT: Readonly<Record<string, string>> = {
  not_required: 'Ratification was not required for this verdict.',
  pending: 'Ratification is pending.',
  ratified: 'The seats ratified this resolution.',
  not_run_by_quick_mode_policy:
    'Ratification was not run, by the quick mode policy recorded for this session.',
  material_change_unratified:
    'A material change after ratification has not been ratified.',
  rejected: 'Ratification was rejected.',
};

export interface CouncilVerdictProps {
  /** The raw verdict read payload, classified by this screen. */
  verdictRead: unknown;
  /** Option labels by option id, from the frozen brief. */
  optionLabels: Readonly<Record<string, string>>;
  /** Committed cards for the detailed rounds section, when the read carries them. */
  cards?: readonly CouncilCard[];
  /** The frozen brief, for the recorded evidence manifest. */
  brief?: DecisionBrief | null;
  /** Recorded source qualification per seat id (packs stand at bibliographic_only in this build). */
  qualificationBySeat?: Readonly<Record<string, string>>;
  mode: CouncilRoomMode;
  sessionId: string;
  createExport?: (
    body: CouncilExportRequest,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  onOpenSources?: (seatId: string) => void;
}

function optionLabel(labels: Readonly<Record<string, string>>, id: string | null): string {
  if (id === null) return 'No option was recommended';
  return labels[id] ?? id;
}

export function CouncilVerdict({
  verdictRead,
  optionLabels,
  cards = [],
  brief = null,
  qualificationBySeat = {},
  mode,
  sessionId,
  createExport,
  onOpenSources,
}: CouncilVerdictProps) {
  const classification: VerdictClassification = classifyVerdictRead(verdictRead);

  if (classification.kind === 'not_ready') {
    return (
      <section data-testid="council-verdict-not-ready" aria-label="Verdict not ready">
        <h2 className={council.heading}>No verdict yet</h2>
        <p>
          No validated verdict has been committed for this session. When the
          council finishes and its verdict is validated and saved, it will
          appear here exactly as recorded. Nothing is estimated or previewed
          in its place.
        </p>
      </section>
    );
  }

  if (classification.kind === 'invalid') {
    return (
      <section data-testid="council-verdict-invalid" aria-label="Invalid verdict">
        <h2 className={council.heading}>This verdict failed validation</h2>
        <p>
          A verdict record exists for this session, but it did not pass
          validation, so it is not presented as a recommendation. The
          recorded problems are:
        </p>
        <ul>
          {classification.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        <p className={council.meta}>
          Recorded validation status: {classification.recordedStatus ?? 'none recorded'}.
          Publication of an invalid revision stays blocked until it is
          revalidated (Section 29).
        </p>
      </section>
    );
  }

  const verdict: Verdict = classification.verdict;

  if (verdict.result_kind === 'consult') {
    const card = verdict.consult_card;
    return (
      <article data-testid="council-verdict">
        <section data-testid="verdict-recommendation" aria-label="Consultation result">
          <p className={council.meta}>CONSULTATION WITH ONE SEAT</p>
          <h2 className={council.heading}>
            {seatIdentity(card.seat_id).displayName}
          </h2>
          <p>{card.answer}</p>
          <p>
            <strong>Next step:</strong> {verdict.next_step}
          </p>
          {card.limits.length > 0 ? (
            <>
              <h3 className={council.heading}>Limits of this answer</h3>
              <ul>
                {card.limits.map((limit, i) => (
                  <li key={i}>{limit}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className={council.meta}>
            A one-seat consultation is advice from a single perspective. It is
            not a council verdict and carries no score.
          </p>
        </section>
        {createExport ? (
          <CouncilExportMenu sessionId={sessionId} mode={mode} createExport={createExport} />
        ) : null}
      </article>
    );
  }

  const recommended = optionLabel(optionLabels, verdict.recommended_option_id);
  const support = verdict.resolution_support;
  const blockingFindings = verdict.hard_constraint_findings.filter(
    (finding) => finding.result !== 'pass',
  );
  const advisorCards = cards.filter((c) => c.card_kind === 'advisor');
  const rounds = [1, 2, 3].filter((round) =>
    advisorCards.some((c) => c.card_kind === 'advisor' && c.round === round),
  );

  return (
    <article data-testid="council-verdict">
      {/* 1. Recommendation */}
      <section data-testid="verdict-recommendation" aria-label="Recommendation">
        <p className={council.meta}>THE COUNCIL RECOMMENDS</p>
        <h2 className={council.heading}>
          {LABEL_TEXT[verdict.label] ?? verdict.label}: {recommended}
        </h2>
        <p className={council.meta}>
          Evidence strength as recorded: {verdict.evidence_strength}.{' '}
          {RATIFICATION_TEXT[verdict.ratification_status] ?? ''}
        </p>
        {support ? (
          <p data-testid="verdict-resolution-support">
            Seat support for this exact resolution (counts, not a probability):
            support {support.support}, conditional support{' '}
            {support.conditional_support}, opposition {support.opposition},
            abstention {support.abstention}.
          </p>
        ) : null}
      </section>

      {/* 2. Conditions */}
      <section data-testid="verdict-conditions" aria-label="Conditions">
        <h3 className={council.heading}>Conditions</h3>
        {verdict.prerequisites.length === 0 && blockingFindings.length === 0 ? (
          <p>No conditions were recorded on this verdict.</p>
        ) : (
          <>
            {verdict.prerequisites.length > 0 ? (
              <ul>
                {verdict.prerequisites.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : null}
            {blockingFindings.length > 0 ? (
              <ul>
                {blockingFindings.map((finding, i) => (
                  <li key={i}>
                    Hard constraint {finding.constraint_id} on option{' '}
                    {optionLabel(optionLabels, finding.option_id)}: recorded
                    result {finding.result} (checked by {finding.checker}).
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      {/* 3. Three main reasons */}
      <section data-testid="verdict-reasons" aria-label="Main reasons">
        <h3 className={council.heading}>Main reasons</h3>
        <ol>
          {verdict.main_reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ol>
      </section>

      {/* 4. Strongest concern */}
      <section data-testid="verdict-concern" aria-label="Strongest concern">
        <h3 className={council.heading}>Strongest concern</h3>
        {verdict.strongest_dissent ? (
          <p data-testid="verdict-strongest-dissent">{verdict.strongest_dissent}</p>
        ) : (
          <p>No dissent was recorded against this recommendation.</p>
        )}
        {verdict.critical_unknowns.length > 0 ? (
          <>
            <h4 className={council.heading}>Critical unknowns</h4>
            <ul>
              {verdict.critical_unknowns.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      {/* 5. Immediate next actions */}
      <section data-testid="verdict-actions" aria-label="Immediate next actions">
        <h3 className={council.heading}>Immediate next actions</h3>
        {verdict.action_proposals.length === 0 ? (
          <p>No action proposals were recorded on this verdict.</p>
        ) : (
          <ol>
            {verdict.action_proposals.map((action) => (
              <li key={action.action_id}>
                <strong>{action.title}</strong>: {action.description}{' '}
                <span className={council.meta}>
                  (Planning only: creating or executing this work needs its own
                  approval. A favorable verdict is not permission.)
                </span>
              </li>
            ))}
          </ol>
        )}
        {verdict.cheapest_informative_test ? (
          <p>
            <strong>Cheapest informative test:</strong>{' '}
            {verdict.cheapest_informative_test}
          </p>
        ) : null}
      </section>

      {/* 6. Full scorecard */}
      <section data-testid="verdict-scorecard" aria-label="Full scorecard">
        <h3 className={council.heading}>Full scorecard</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col">Score</th>
              <th scope="col">Weighted sum</th>
              <th scope="col">Score coverage</th>
              <th scope="col">Spread</th>
            </tr>
          </thead>
          <tbody>
            {verdict.option_scores.map((score) => (
              <tr
                key={score.option_id}
                data-testid={`scorecard-row-${score.option_id}`}
                aria-current={
                  score.option_id === verdict.recommended_option_id
                    ? 'true'
                    : undefined
                }
              >
                <th scope="row">
                  {optionLabel(optionLabels, score.option_id)}
                  {score.option_id === verdict.recommended_option_id
                    ? ' (recommended)'
                    : ''}
                </th>
                <td>
                  {score.display_score === null
                    ? 'Not scored'
                    : score.display_score.toFixed(1)}
                </td>
                <td>
                  {score.weighted_sum} of {score.denominator} possible weight
                </td>
                <td>{Math.round(score.coverage * 1000) / 10}%</td>
                <td>{score.spread === null ? 'Not recorded' : score.spread}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={council.meta}>
          Scores are weighted means of the committed seat scores, computed by
          the deterministic scoring code, not by a model. Coverage is the
          share of total seat weight that scored the option. A label such as
          Go requires at least 80% coverage and no unresolved critical-domain
          abstention (Section 12).
        </p>
      </section>

      {/* 7. Detailed rounds and sources */}
      <section data-testid="verdict-detail" aria-label="Detailed rounds and sources">
        <h3 className={council.heading}>Detailed rounds and sources</h3>
        {advisorCards.length === 0 ? (
          <p>
            No advisor card detail is included in this read. The verdict above
            is the committed record; card-level detail is never reconstructed
            or paraphrased here.
          </p>
        ) : (
          rounds.map((round) => (
            <div key={round} data-testid={`verdict-round-${round}`}>
              <h4 className={council.heading}>Round {round}</h4>
              <ul>
                {advisorCards
                  .filter((c) => c.card_kind === 'advisor' && c.round === round)
                  .map((card) => {
                    if (card.card_kind !== 'advisor') return null;
                    const identity = seatIdentity(card.seat_id);
                    const qualification =
                      qualificationBySeat[card.seat_id] ?? 'bibliographic_only';
                    return (
                      <li key={`${card.seat_id}-${card.round}`}>
                        <strong>{identity.displayName}</strong>: {card.stance}
                        {card.preferred_option_id
                          ? `, prefers ${optionLabel(optionLabels, card.preferred_option_id)}`
                          : ''}
                        . Source qualification: {qualificationLabel(qualification)}{' '}
                        {onOpenSources ? (
                          <button
                            type="button"
                            className={council.btn}
                            data-testid={`verdict-sources-${card.seat_id}`}
                            onClick={() => onOpenSources(card.seat_id)}
                          >
                            View recorded sources
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))
        )}
        {brief && brief.evidence_manifest.length > 0 ? (
          <>
            <h4 className={council.heading}>Recorded evidence manifest</h4>
            <ul>
              {brief.evidence_manifest.map((entry) => (
                <li key={entry.evidence_id}>
                  {entry.source_kind}: {entry.locator}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className={council.meta}>
          Verdict revision {verdict.verdict_revision}. Content hash{' '}
          {verdict.content_sha256}. Every claim above traces to this saved
          record.
        </p>
      </section>

      {createExport ? (
        <CouncilExportMenu sessionId={sessionId} mode={mode} createExport={createExport} />
      ) : null}
    </article>
  );
}

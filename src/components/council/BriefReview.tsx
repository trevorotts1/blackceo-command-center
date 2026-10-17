'use client';

/**
 * BriefReview (CWE-033, Skill 77)
 *
 * The composed decision brief, rendered for review before freeze
 * (Section 9, T017 client half). The five content kinds are visually
 * and structurally distinguishable, each in its own labeled section
 * with a data-kind marker: the decision statement, confirmed facts
 * (with their source marks), assumptions (never dressed as facts),
 * ranges and limits (the brief's constraints), and explicit unknowns.
 * The client's private preference is set in its own separate step and
 * never appears inside this brief body; the closing note says so.
 */

import type { DecisionBrief } from '@/lib/council/contracts/types';
import { council } from './council-theme';
import { CRITICAL_DOMAIN_LABELS } from './council-journey-types';

export type BriefContentKind = 'statement' | 'fact' | 'assumption' | 'range' | 'unknown';

const KIND_TITLES: Record<BriefContentKind, string> = {
  statement: 'Decision statement',
  fact: 'Confirmed facts',
  assumption: 'Assumptions',
  range: 'Ranges and limits',
  unknown: 'Explicit unknowns',
};

function KindSection({
  kind,
  testId,
  children,
}: {
  kind: BriefContentKind;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="council-journey-kind" data-kind={kind} data-testid={testId}>
      <h3>
        <span className="council-journey-kind-tag">{KIND_TITLES[kind]}</span>
      </h3>
      {children}
    </section>
  );
}

export function BriefReview({ brief }: { brief: DecisionBrief }) {
  const manifestById = new Map(brief.evidence_manifest.map((e) => [e.evidence_id, e]));
  const optionLabel = (id: string): string =>
    brief.options.find((o) => o.id === id)?.label ?? id;

  return (
    <div className="council-journey-stack" data-testid="brief-review">
      <p className={council.meta}>
        Brief revision {brief.revision} · {brief.brief_id}
      </p>

      <KindSection kind="statement" testId="brief-kind-statement">
        <p style={{ margin: 0 }}>{brief.question}</p>
        <ul>
          {brief.options.map((option) => (
            <li key={option.id}>
              <strong>{option.id}.</strong> {option.label}
            </li>
          ))}
        </ul>
      </KindSection>

      <KindSection kind="fact" testId="brief-kind-fact">
        {brief.facts.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            No confirmed facts recorded.
          </p>
        ) : (
          <ul>
            {brief.facts.map((fact) => (
              <li key={fact.id}>
                {fact.statement}
                {fact.evidence_ids.length > 0 ? (
                  fact.evidence_ids.map((evidenceId) => {
                    const entry = manifestById.get(evidenceId);
                    return (
                      <span key={evidenceId} className="council-journey-source">
                        Source: {entry ? `${entry.locator} (${entry.source_kind})` : evidenceId}
                      </span>
                    );
                  })
                ) : (
                  <span className="council-journey-source">
                    Source: stated by the client; not in the evidence manifest
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </KindSection>

      <KindSection kind="assumption" testId="brief-kind-assumption">
        {brief.assumptions.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            No assumptions recorded. Assumptions are labeled as assumptions and are never
            silently converted to facts.
          </p>
        ) : (
          <ul>
            {brief.assumptions.map((assumption) => (
              <li key={assumption.id}>{assumption.statement}</li>
            ))}
          </ul>
        )}
      </KindSection>

      <KindSection kind="range" testId="brief-kind-range">
        {brief.constraints.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            No ranges or limits recorded. Ranges are acceptable; exact figures are never
            forced.
          </p>
        ) : (
          <ul>
            {brief.constraints.map((constraint) => (
              <li key={constraint.id}>
                {constraint.description}{' '}
                <span className="council-journey-source">
                  {constraint.hard ? 'Hard limit' : 'Soft limit'}
                  {constraint.applies_to_option_ids.length > 0
                    ? ` · applies to ${constraint.applies_to_option_ids.map(optionLabel).join(', ')}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </KindSection>

      <KindSection kind="unknown" testId="brief-kind-unknown">
        {brief.unknowns.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            No explicit unknowns recorded.
          </p>
        ) : (
          <ul>
            {brief.unknowns.map((unknown) => (
              <li key={unknown.id}>{unknown.statement}</li>
            ))}
          </ul>
        )}
      </KindSection>

      <section className="council-journey-kind" data-testid="brief-critical-domains">
        <h3>Critical domains</h3>
        {brief.critical_domains.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            No critical domains were triggered by the intake material.
          </p>
        ) : (
          <ul>
            {brief.critical_domains.map((requirement) => (
              <li key={requirement.domain}>
                <strong>{CRITICAL_DOMAIN_LABELS[requirement.domain]}:</strong>{' '}
                {requirement.status === 'not_assessed'
                  ? 'not_assessed (no responsible reviewer on the panel)'
                  : requirement.status}
                {requirement.unresolved_questions.map((q) => (
                  <span key={q} className={council.meta}>
                    {' '}
                    Open question: {q}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="council-journey-kind" data-testid="brief-evidence-manifest">
        <h3>Evidence manifest</h3>
        {brief.evidence_manifest.length === 0 ? (
          <p className={council.meta} style={{ margin: 0 }}>
            The evidence manifest is empty for this brief.
          </p>
        ) : (
          <ul>
            {brief.evidence_manifest.map((entry) => (
              <li key={entry.evidence_id}>
                {entry.locator} ({entry.source_kind}){' '}
                <span className="council-journey-hash">sha256 {entry.sha256}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className={council.meta} data-testid="brief-preference-note">
        Your private preference is stored separately and never appears inside this brief.
      </p>
    </div>
  );
}

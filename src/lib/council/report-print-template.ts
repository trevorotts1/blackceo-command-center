/**
 * The Command Center print template for council decision reports
 * (CWE-050, CWE-038's CC remainder; directive Section 24.2/24.3).
 *
 * This is the CC host's print rendering of the one report model
 * built by report-downloads.ts, mirroring CWE-038's accepted print
 * semantics exactly: a deterministic document with local assets
 * only (one embedded style block), no scripts, no network
 * references, every generated string HTML-escaped, body type at
 * 12.5pt, repeating table headers, controlled page breaks, and page
 * numbers from the print stylesheet (@page counters). It is the
 * document the approved Playwright/Chromium renderer prints to PDF
 * under CWE-044; until that renderer lands, PDF requests refuse
 * EXPORT_FORMAT_NOT_READY and this HTML is the print deliverable.
 *
 * No format re-derives anything: this renderer consumes the shared
 * report model and nothing else, so print, Markdown, and the record
 * JSON agree on scores, decisions, conditions, citations, and the
 * report revision (T105).
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function formatScore(score: number | null): string {
  if (score === null) return 'not scored';
  return String(Number(score.toFixed(4)));
}

export function formatDisplayScore(display: number | null): string {
  if (display === null) return 'not scored';
  return display.toFixed(1);
}

export function formatCoverage(coverage: number | null): string {
  if (coverage === null) return 'n/a';
  return `${(coverage * 100).toFixed(2)}%`;
}

function formatPlainNumber(value: number | null): string {
  if (value === null) return 'n/a';
  return String(Number(value.toFixed(4)));
}

function qualificationText(value: unknown): string {
  return typeof value === 'string' ? value : 'not recorded';
}

export const PRINT_CSS = [
  '@page { size: A4; margin: 20mm 18mm 20mm 18mm; @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; color: #444; } }',
  'body { font-family: Georgia, "Times New Roman", serif; font-size: 12.5pt; line-height: 1.45; color: #111; }',
  'h1 { font-size: 20pt; } h2 { font-size: 15pt; page-break-after: avoid; } h3 { font-size: 13pt; page-break-after: avoid; }',
  'table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #666; padding: 4px 6px; text-align: left; vertical-align: top; }',
  'thead { display: table-header-group; } tr { page-break-inside: avoid; }',
  '.label { border: 1px solid #666; padding: 8px 10px; } .meta { color: #333; }',
].join('\n');

function hList(items: unknown[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(asString(item))}</li>`).join('')}</ul>`;
}

export function renderPrintHtml(model: Record<string, unknown>): string {
  const verdict = asRecord(model.verdict_block);
  const brief = asRecord(model.brief);
  const out: string[] = [];
  out.push('<!DOCTYPE html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push(`<title>Council report ${escapeHtml(asString(model.session_id))} revision ${escapeHtml(String(verdict.revision))}</title>`);
  out.push(`<style>${PRINT_CSS}</style>`);
  out.push('</head>');
  out.push('<body>');
  out.push('<h1>Council of Wise Elders: Decision Report</h1>');
  out.push(`<p class="meta">Decision: ${escapeHtml(asString(model.decision_title))}<br>`);
  out.push(`Date: ${escapeHtml(asString(model.report_date))}<br>`);
  out.push(`Session: ${escapeHtml(asString(model.session_id))}<br>`);
  out.push(`Mode: ${escapeHtml(asStringOrNull(model.session_mode) ?? 'not recorded')}<br>`);
  out.push(`Route: ${escapeHtml(asString(model.route_display))}<br>`);
  out.push(`Report revision: ${escapeHtml(asString(model.report_revision_id))}<br>`);
  out.push(`Verdict revision: ${escapeHtml(String(verdict.revision))}<br>`);
  out.push(`Verdict content SHA-256: ${escapeHtml(asString(verdict.content_sha256))}<br>`);
  out.push(`Brief SHA-256: ${escapeHtml(asString(verdict.brief_sha256))}<br>`);
  out.push(`Protocol version: ${escapeHtml(asString(model.protocol_version))}</p>`);
  if (model.redacted === true) {
    out.push(`<p class="meta">Redacted report: yes (profile ${escapeHtml(asString(model.redaction_profile_id))})</p>`);
  }
  out.push(`<p class="label">${escapeHtml(asString(model.simulation_label))}</p>`);
  out.push(`<p class="label">${escapeHtml(asString(model.authorization_notice))}</p>`);

  const consult = model.consult as Record<string, unknown> | null;
  if (consult) {
    out.push('<h2>Consultation</h2>');
    out.push(`<p>${escapeHtml(asString(consult.display_name))}: ${escapeHtml(asString(consult.label))}</p>`);
    out.push(`<p>${escapeHtml(asString(consult.answer))}</p>`);
    out.push('<h3>Assumptions</h3>');
    out.push(hList(asArray(consult.assumptions)));
    out.push('<h3>Limits</h3>');
    out.push(hList(asArray(consult.limits)));
    out.push(`<p>Next step: ${escapeHtml(asString(consult.next_step))}</p>`);
    pushProvenanceHtml(out, model);
    out.push('</body>');
    out.push('</html>');
    return `${out.join('\n')}\n`;
  }

  out.push('<h2>Executive decision</h2>');
  out.push(`<p>Verdict: ${escapeHtml(asString(verdict.label))}<br>`);
  const recommended = asStringOrNull(verdict.recommended_option_id);
  out.push(
    `Recommendation: ${escapeHtml(recommended === null ? 'none' : `${recommended} (${asString(verdict.recommended_option_label)})`)}</p>`,
  );
  out.push('<h3>Prerequisites</h3>');
  const prerequisites = asArray(model.prerequisites);
  out.push(prerequisites.length > 0 ? hList(prerequisites) : '<ul><li>none</li></ul>');
  out.push('<h3>Why</h3>');
  out.push(hList(asArray(model.main_reasons)));

  out.push('<h2>Alternatives and scores</h2>');
  out.push('<table><thead><tr><th>Option</th><th>Weighted sum</th><th>Denominator</th><th>Score</th><th>Display score</th><th>Coverage</th><th>Spread</th><th>Abstentions</th></tr></thead><tbody>');
  for (const rowValue of asArray(model.score_table)) {
    const row = asRecord(rowValue);
    const abstained = asArray(row.abstained_seat_ids).map(asString).join(', ') || 'none';
    out.push(
      `<tr><td>${escapeHtml(asString(row.option_id))} (${escapeHtml(asString(row.option_label))})</td><td>${escapeHtml(formatPlainNumber(asNumberOrNull(row.weighted_sum)))}</td><td>${escapeHtml(formatPlainNumber(asNumberOrNull(row.denominator)))}</td><td>${escapeHtml(formatScore(asNumberOrNull(row.score)))}</td><td>${escapeHtml(formatDisplayScore(asNumberOrNull(row.display_score)))}</td><td>${escapeHtml(formatCoverage(asNumberOrNull(row.coverage)))}</td><td>${escapeHtml(formatPlainNumber(asNumberOrNull(row.spread)))}</td><td>${escapeHtml(abstained)}</td></tr>`,
    );
  }
  out.push('</tbody></table>');

  out.push('<h2>Main arguments and strongest dissent</h2>');
  out.push(hList(asArray(model.main_reasons)));
  out.push(`<p>Strongest dissent: ${escapeHtml(asStringOrNull(model.strongest_dissent) ?? 'none recorded')}</p>`);

  out.push('<h2>Constraints, assumptions, and unknowns</h2>');
  out.push('<h3>Hard constraints</h3>');
  const findings = asArray(model.hard_constraints);
  if (findings.length === 0) out.push('<ul><li>none recorded</li></ul>');
  else {
    out.push('<ul>');
    for (const findingValue of findings) {
      const finding = asRecord(findingValue);
      out.push(
        `<li>${escapeHtml(asString(finding.constraint_id))} on option ${escapeHtml(asString(finding.option_id))}: ${escapeHtml(asString(finding.result))} (checker: ${escapeHtml(asString(finding.checker))})</li>`,
      );
    }
    out.push('</ul>');
  }
  out.push('<h3>Assumptions</h3>');
  const assumptions = asArray(brief.assumptions);
  out.push(assumptions.length > 0 ? hList(assumptions) : '<ul><li>none recorded</li></ul>');
  out.push('<h3>Unknowns</h3>');
  const unknowns = [...asArray(brief.unknowns), ...asArray(model.critical_unknowns)];
  out.push(unknowns.length > 0 ? hList(unknowns) : '<ul><li>none recorded</li></ul>');

  out.push('<h2>Amendments and ratification</h2>');
  const amendments = asRecord(model.amendments);
  const describeAmendment = (value: unknown): string => {
    const amendment = asRecord(value);
    return `${asString(amendment.amendment_id)} by ${asString(amendment.proposing_seat_id)}: ${asString(amendment.statement)} (${asString(amendment.materiality)}, ${asString(amendment.disposition)})`;
  };
  const accepted = asArray(amendments.accepted);
  out.push('<h3>Accepted amendments</h3>');
  out.push(accepted.length > 0 ? `<ul>${accepted.map((a) => `<li>${escapeHtml(describeAmendment(a))}</li>`).join('')}</ul>` : '<ul><li>none</li></ul>');
  const rejected = asArray(amendments.rejected);
  out.push('<h3>Rejected amendments</h3>');
  out.push(rejected.length > 0 ? `<ul>${rejected.map((a) => `<li>${escapeHtml(describeAmendment(a))}</li>`).join('')}</ul>` : '<ul><li>none</li></ul>');
  const ratification = asRecord(model.ratification);
  out.push(`<p>Ratification status: ${escapeHtml(asStringOrNull(ratification.status) ?? 'not applicable')}</p>`);
  const support = ratification.resolution_support as Record<string, unknown> | null;
  if (support) {
    out.push(
      `<p>Resolution support (weighted counts, not a probability): support ${escapeHtml(formatPlainNumber(asNumberOrNull(support.support)))}, conditional support ${escapeHtml(formatPlainNumber(asNumberOrNull(support.conditional_support)))}, opposition ${escapeHtml(formatPlainNumber(asNumberOrNull(support.opposition)))}, abstention ${escapeHtml(formatPlainNumber(asNumberOrNull(support.abstention)))}, bound to resolution ${escapeHtml(asString(support.resolution_sha256))}.</p>`,
    );
  }

  out.push('<h2>Action proposals and authorization boundaries</h2>');
  const proposals = asArray(model.action_proposals);
  if (proposals.length === 0) out.push('<ul><li>none</li></ul>');
  for (const proposalValue of proposals) {
    const proposal = asRecord(proposalValue);
    out.push(`<h3>${escapeHtml(asString(proposal.action_id))}: ${escapeHtml(asString(proposal.title))}</h3>`);
    out.push(`<p>${escapeHtml(asString(proposal.description))}</p>`);
    out.push(`<p>Rationale: ${escapeHtml(asString(proposal.rationale))}</p>`);
    out.push('<p>Acceptance criteria:</p>');
    out.push(hList(asArray(proposal.acceptance_criteria)));
    const depends = asArray(proposal.depends_on_action_ids).map(asString);
    out.push(`<p>Depends on: ${escapeHtml(depends.length > 0 ? depends.join(', ') : 'none')}<br>`);
    out.push(`Risk class: ${escapeHtml(asString(proposal.risk_class))}<br>`);
    out.push('Execution authorization: separate execution authorization is required before this proposal may be acted on.</p>');
  }
  out.push(`<p class="label">${escapeHtml(asString(model.authorization_notice))}</p>`);

  out.push('<h2>Test, stop conditions, and review criteria</h2>');
  out.push(`<p>Cheapest informative test: ${escapeHtml(asStringOrNull(model.cheapest_informative_test) ?? 'none recorded')}</p>`);
  out.push('<h3>Stop conditions</h3>');
  const stop = asArray(model.stop_criteria);
  out.push(stop.length > 0 ? hList(stop) : '<ul><li>none recorded</li></ul>');
  out.push('<h3>Outcome review criteria</h3>');
  const review = asArray(model.review_criteria);
  out.push(review.length > 0 ? hList(review) : '<ul><li>none recorded</li></ul>');

  out.push('<h2>Advisor detail</h2>');
  for (const seatValue of asArray(model.participating_seats)) {
    const seat = asRecord(seatValue);
    out.push(
      `<p>Participating seat: ${escapeHtml(asString(seat.display_name))} (${escapeHtml(asString(seat.seat_id))}), source qualification: ${escapeHtml(qualificationText(seat.qualification))}</p>`,
    );
  }
  for (const seatValue of asArray(model.seats)) {
    const seat = asRecord(seatValue);
    out.push(`<h3>${escapeHtml(asString(seat.display_name))}</h3>`);
    out.push(`<p>${escapeHtml(asString(seat.label))}</p>`);
    out.push(`<p>Source qualification: ${escapeHtml(qualificationText(seat.qualification))}<br>`);
    out.push(`Stance: ${escapeHtml(asString(seat.stance))}<br>`);
    out.push(`Preferred option: ${escapeHtml(asStringOrNull(seat.preferred_option_id) ?? 'none')}</p>`);
    const abstained = asArray(seat.abstained_option_ids).map(asString);
    if (abstained.length > 0) {
      out.push(`<p>Abstained on: ${escapeHtml(abstained.join(', '))}</p>`);
    }
    out.push('<p>Decisive arguments:</p>');
    out.push(hList(asArray(seat.decisive_arguments)));
    out.push(`<p>Strongest objection: ${escapeHtml(asString(seat.strongest_objection))}<br>`);
    out.push(`What would change my mind: ${escapeHtml(asString(seat.change_my_mind))}</p>`);
    const conditions = asArray(seat.conditions);
    if (conditions.length > 0) {
      out.push('<p>Conditions:</p><ul>');
      for (const conditionValue of conditions) {
        const condition = asRecord(conditionValue);
        out.push(
          `<li>${escapeHtml(asString(condition.id))}: ${escapeHtml(asString(condition.description))} (${escapeHtml(asString(condition.kind))}, ${escapeHtml(asString(condition.status))}${condition.blocking === true ? ', blocking' : ''})</li>`,
        );
      }
      out.push('</ul>');
    }
    const stance = asStringOrNull(seat.resolution_stance);
    if (stance !== null) out.push(`<p>Resolution stance: ${escapeHtml(stance)}</p>`);
  }

  pushProvenanceHtml(out, model);
  out.push('</body>');
  out.push('</html>');
  return `${out.join('\n')}\n`;
}

function pushProvenanceHtml(out: string[], model: Record<string, unknown>): void {
  const provenance = asRecord(model.provenance);
  out.push('<h2>Source and provenance appendix</h2>');
  out.push(`<p>${escapeHtml(asString(provenance.note))}</p>`);
  out.push('<table><thead><tr><th>Evidence</th><th>Kind</th><th>Locator</th><th>SHA-256</th></tr></thead><tbody>');
  for (const entryValue of asArray(provenance.evidence_manifest)) {
    const entry = asRecord(entryValue);
    out.push(
      `<tr><td>${escapeHtml(asString(entry.evidence_id))}</td><td>${escapeHtml(asString(entry.source_kind))}</td><td>${escapeHtml(asString(entry.locator))}</td><td>${escapeHtml(asString(entry.sha256))}</td></tr>`,
    );
  }
  out.push('</tbody></table>');
}

/**
 * The Command Center print template for council decision reports
 * (CWE-050; CTR-163 corrections from audit rows FX-033/FX-036/
 * FX-037/FX-038/FX-039/FX-041/FX-043/FX-045/FX-046/FX-048/FX-053/
 * FX-054).
 *
 * This is the CC host's print rendering of the one report model built
 * by report-downloads.ts. It stays offline and deterministic: one
 * embedded style block, no scripts, no network references, every
 * generated string HTML-escaped, the same report model for Markdown,
 * record JSON, print HTML, and PDF.
 *
 * CTR-163 changes the reading surface, not the saved record:
 *   - the cover prints the nine seated chamber portraits in canonical
 *     roster order (3 x 3) when the release is complete; a redacted
 *     report prints the redaction note and no portrait at all; the
 *     empty-table hero is never used;
 *   - the cover is the exact question, date, route, verdict headline,
 *     and a short read-first list; the report itself starts on a new
 *     page so no heading-only page is produced;
 *   - the reading order is summary -> question -> plan -> how to use ->
 *     helpers, then Part 2 with the alternatives, the members, the
 *     conditions, the amendments, and the records;
 *   - every printable character, including table cells and the page
 *     number, is at least 14pt. Wide tables become stacked blocks; no
 *     shrink-to-fit trick is used;
 *   - long cards may split across pages; only small units keep
 *     break-inside: avoid, so a tall advisor card cannot leave a
 *     half-empty page and a heading is never printed alone;
 *   - exact duplicate list strings are printed once, with the count
 *     stated. An empty acceptance criterion is printed as an explicit
 *     not-ready sentence, never as a blank "Done when:".
 */

import type { ConditionSummary } from './report-reading';
import { readReportDebateInput } from './report-model-guards';

/**
 * CTR-168 consult statement, shared by every export format.
 *
 * A consultation is one seat answering one question. It is not a
 * convened council: no advisor rounds were run, no nine-seat debate
 * happened, and the record holds no chair stop note. The sentence is a
 * constant so the Markdown, record JSON, print HTML, and PDF exports
 * cannot drift into claiming a debate that was never held.
 */
export const CONSULT_NO_DEBATE_NOTE =
  'A consultation records one seat and no advisor rounds. There is no council debate, no nine-seat deliberation, and no chair stop note in this record.';

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

export interface ReportPrintPortrait {
  seat_id: string;
  display_name: string;
  data_uri: string;
}

export type ReportPrintCover =
  | { status: 'ready'; portraits: ReportPrintPortrait[] }
  | { status: 'unavailable'; reason: string };

export interface RenderPrintOptions {
  /** Cover imagery resolved from this host; absent means no portrait. */
  cover?: ReportPrintCover | null;
}

/** 14pt is the floor for every printable element, page number included. */
export const PRINT_MIN_FONT_PT = 14;

export const PRINT_CSS = [
  '@page { size: A4; margin: 17mm 20mm 22mm 20mm; @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: Georgia, "Iowan Old Style", "Times New Roman", serif; font-size: 14pt; color: #3A3934; } }',
  ':root { --paper: #FFFFFF; --paper-band: #FBF6E9; --ink: #1C1C1C; --ink-secondary: #3A3934; --navy: #16233D; --navy-deep: #0E1626; --cream-on-navy: #FFF8E7; --gold-text: #7A5C1F; --gold-rule: #B08A3E; --gold-light: #E8CFA0; --rule-hairline: #D8C9A6; }',
  'html, body { background: var(--paper); color: var(--ink); }',
  'body { font-family: Georgia, "Iowan Old Style", "Times New Roman", serif; font-size: 15pt; line-height: 1.45; margin: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }',
  'p, li, dt, dd, blockquote, figcaption, td, th, dl, ul, ol, footer, caption, label, summary, code, .note, .meta, .seat-portrait span, .cover-kicker, .cover-redaction p, .section-lead, .read-map li { font-size: 14pt; line-height: 1.45; }',
  'p { margin: 0 0 3mm 0; orphans: 3; widows: 3; }',
  'ul, ol { margin: 0 0 3mm 0; padding-left: 7mm; break-inside: auto; } li { margin: 0 0 1.5mm 0; }',
  'h1 { font-size: 27pt; line-height: 1.15; margin: 0 0 4mm 0; color: var(--navy); overflow-wrap: anywhere; }',
  'h2 { font-size: 22pt; line-height: 1.25; color: var(--navy); border-bottom: 1pt solid var(--gold-rule); padding-bottom: 2mm; margin: 0; break-after: avoid; page-break-after: avoid; }',
  'h3 { font-size: 17pt; line-height: 1.3; color: var(--navy); margin: 5mm 0 2mm 0; break-after: avoid; page-break-after: avoid; }',
  'h4 { font-size: 15pt; line-height: 1.3; color: var(--navy); margin: 4mm 0 2mm 0; break-after: avoid; page-break-after: avoid; }',
  '.section-head { margin: 9mm 0 3mm 0; break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid; }',
  '.section-head h2 { margin: 0; }',
  '.section-lead { margin: 2mm 0 0 0; color: var(--ink-secondary); }',
  '.part-banner { margin: 0 0 6mm 0; padding: 4mm 5mm; background: var(--navy); color: var(--cream-on-navy); border-left: 5mm solid var(--gold-rule); font-size: 16pt; font-weight: bold; letter-spacing: 0.04em; break-inside: avoid; page-break-inside: avoid; }',
  '.part-banner.part-start { break-before: page; page-break-before: always; }',
  '.report-cover { break-after: page; page-break-after: always; width: 100%; margin: 0; padding: 0 0 4mm 0; background: var(--paper); }',
  '.report-cover-band { background: var(--navy); border-bottom: 5pt solid var(--gold-rule); padding: 6mm 10mm 5mm 10mm; }',
  '.cover-kicker { margin: 0 0 3mm 0; color: var(--gold-light); letter-spacing: 0.16em; text-transform: uppercase; text-align: center; }',
  '.cover-redaction { margin: 0 auto; max-width: 158mm; border: 1pt solid var(--gold-light); padding: 5mm 6mm; color: var(--cream-on-navy); text-align: center; }',
  '.cover-redaction p { margin: 0; }',
  '.cover-portraits { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm 6mm; max-width: 158mm; margin: 0 auto; }',
  '.cover-portraits-single { grid-template-columns: 1fr; max-width: 42mm; }',
  '.seat-portrait { margin: 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }',
  '.seat-portrait img, .seat-portrait-fallback { display: block; width: 16mm; height: 16mm; margin: 0 auto 1mm auto; border-radius: 50%; border: 1.5pt solid var(--gold-light); background: var(--navy-deep); object-fit: cover; object-position: center top; }',
  '.seat-portrait-fallback { color: var(--cream-on-navy); line-height: 16mm; text-align: center; }',
  '.seat-portrait span { display: block; color: var(--cream-on-navy); line-height: 1.2; }',
  '.cover-body { padding: 6mm 10mm 0 10mm; }',
  '.cover-body h1 { font-size: 24pt; }',
  '.cover-meta { margin: 0 0 2mm 0; color: var(--ink-secondary); }',
  '.cover-verdict { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; margin: 3mm 0; }',
  '.cover-verdict p { margin: 0; border-top: 3pt solid var(--gold-rule); background: var(--paper-band); padding: 2.5mm 3mm; font-size: 15pt; }',
  '.cover-verdict span { display: block; color: var(--gold-text); font-size: 14pt; font-weight: bold; letter-spacing: 0.06em; text-transform: uppercase; }',
  '.cover-readfirst { margin: 2.5mm 0 3mm 0; padding: 2.5mm 4mm 2.5mm 11mm; border: 1pt solid var(--rule-hairline); background: var(--paper-band); break-inside: avoid; page-break-inside: avoid; }',
  '.summary-card { border: 1pt solid var(--gold-rule); border-left: 4mm solid var(--gold-rule); background: var(--paper-band); padding: 5mm 6mm; margin: 0 0 5mm 0; break-inside: auto; page-break-inside: auto; }',
  '.glance { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5mm 4mm; margin: 0 0 4mm 0; }',
  '.glance div { border-top: 2.5pt solid var(--gold-rule); padding: 2mm 0 0 0; break-inside: avoid; page-break-inside: avoid; }',
  '.glance dt { margin: 0; color: var(--gold-text); font-size: 14pt; font-weight: bold; letter-spacing: 0.06em; text-transform: uppercase; }',
  '.glance dd { margin: 1mm 0 0 0; font-size: 15pt; overflow-wrap: anywhere; }',
  '.label-box { border: 1pt solid var(--rule-hairline); border-left: 4mm solid var(--gold-rule); background: var(--paper-band); padding: 4mm 5mm; margin: 0 0 4mm 0; break-inside: avoid; page-break-inside: avoid; }',
  '.label-box p:last-child { margin-bottom: 0; }',
  '.advisor-card, .plan-step, .option-block, .consult-card { border: 1pt solid var(--rule-hairline); border-top: 3pt solid var(--gold-rule); background: var(--paper); padding: 4mm 5mm; margin: 0 0 4mm 0; break-inside: auto; page-break-inside: auto; }',
  '.advisor-card h3, .plan-step h3, .option-block h3 { margin-top: 0; }',
  '.advisor-head { display: flex; gap: 4mm; align-items: center; margin-bottom: 2mm; }',
  '.advisor-head .seat-portrait img, .advisor-head .seat-portrait-fallback { width: 14mm; height: 14mm; }',
  '.advisor-head .seat-portrait span { color: var(--navy); }',
  '.step-number { display: inline-block; background: var(--navy); color: var(--cream-on-navy); font-size: 14pt; font-weight: bold; padding: 1mm 3mm; margin-right: 2mm; }',
  '.small { font-size: 14pt; }',
  'table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #666; padding: 3px 5px; text-align: left; vertical-align: top; } thead { display: table-header-group; } tr { break-inside: avoid; page-break-inside: avoid; }',
  '.stacked-row { border: 1pt solid var(--rule-hairline); padding: 3mm 4mm; margin: 0 0 3mm 0; break-inside: avoid; page-break-inside: avoid; }',
  '.stacked-row dt { color: var(--gold-text); font-weight: bold; } .stacked-row dd { margin: 0 0 2mm 0; }',
  'footer.report-footer { margin-top: 8mm; padding: 4mm 0 0 0; border-top: 1pt solid var(--gold-rule); break-inside: avoid; page-break-inside: avoid; color: var(--ink-secondary); }',
  '.record dl { margin: 0; } .record dd { margin: 0 0 2mm 0; overflow-wrap: anywhere; }',
].join('\n');

/** Exact duplicate strings print once; nothing is reworded or dropped. */
function dedupeStrings(items: readonly string[]): { items: string[]; collapsed: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return { items: out, collapsed: items.length - out.length };
}

function hList(items: unknown[]): string {
  const strings = items.map((item) => asString(item));
  const deduped = dedupeStrings(strings);
  if (deduped.items.length === 0) return '<ul><li>none recorded</li></ul>';
  const note =
    deduped.collapsed > 0
      ? `<p class="meta">${deduped.collapsed} exact duplicate line(s) were recorded once; no value was removed or reworded.</p>`
      : '';
  return `${note}<ul>${deduped.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function sectionHead(number: string, title: string, lead: string | null): string {
  return `<div class="section-head"><h2>${number ? `<span class="sec-n">${escapeHtml(number)}</span>` : ''}${escapeHtml(title)}</h2>${
    lead ? `<p class="section-lead">${escapeHtml(lead)}</p>` : ''
  }</div>`;
}

function coverPortraitsHtml(cover: ReportPrintCover | null | undefined, redacted: boolean): string {
  if (redacted) {
    return '';
  }
  if (!cover || cover.status !== 'ready' || cover.portraits.length === 0) {
    const reason =
      cover && cover.status === 'unavailable'
        ? cover.reason
        : 'No portrait release was resolved for this report.';
    return `<div class="cover-portraits-single"><p class="seat-portrait-fallback" style="width:auto;height:auto;border-radius:0;padding:4mm">No portraits printed. ${escapeHtml(reason)}</p></div>`;
  }
  const single = cover.portraits.length === 1;
  return `<div class="cover-portraits${single ? ' cover-portraits-single' : ''}">${cover.portraits
    .map(
      (portrait) =>
        `<figure class="seat-portrait"><img src="${escapeHtml(portrait.data_uri)}" alt="Portrait of ${escapeHtml(
          portrait.display_name,
        )}"><span>${escapeHtml(portrait.display_name)}</span></figure>`,
    )
    .join('')}</div>`;
}

function portraitFor(
  cover: ReportPrintCover | null | undefined,
  seatId: string,
  displayName: string,
  redacted: boolean,
): string {
  if (redacted) return '';
  if (!cover || cover.status !== 'ready') return '';
  const portrait = cover.portraits.find((entry) => entry.seat_id === seatId);
  if (!portrait) return '';
  return `<figure class="seat-portrait"><img src="${escapeHtml(portrait.data_uri)}" alt="Portrait of ${escapeHtml(
    displayName,
  )}"><span>${escapeHtml(displayName)}</span></figure>`;
}

function renderCover(model: Record<string, unknown>, options: RenderPrintOptions): string {
  const verdict = asRecord(model.verdict_block);
  const summary = asRecord(model.summary);
  const redacted = model.redacted === true;
  const consult = model.consult as Record<string, unknown> | null;
  const portraits = consult
    ? coverPortraitsHtml(
        options.cover && options.cover.status === 'ready'
          ? {
              status: 'ready',
              portraits: options.cover.portraits.filter(
                (portrait) => portrait.seat_id === asString(consult.seat_id),
              ),
            }
          : (options.cover ?? null),
        redacted,
      )
    : coverPortraitsHtml(options.cover, redacted);
  const out: string[] = [];
  out.push('<section class="report-cover">');
  out.push('<div class="report-cover-band">');
  out.push('<p class="cover-kicker">Council of Wise Elders</p>');
  if (redacted) {
    out.push(
      `<div class="cover-redaction"><p><strong>Redacted report.</strong> This report carries a redaction profile (${escapeHtml(
        asString(model.redaction_profile_id),
      )}). No portrait, image, or wordmark band is printed on a redacted cover.</p></div>`,
    );
  } else {
    out.push(portraits);
  }
  out.push('</div>');
  out.push('<div class="cover-body">');
  out.push(`<h1>${escapeHtml(asString(model.decision_title) || 'Council decision report')}</h1>`);
  out.push(
    `<p class="cover-meta">${escapeHtml(asString(model.report_date))} · Session ${escapeHtml(
      asString(model.session_id),
    )} · ${escapeHtml(asStringOrNull(model.session_mode) ?? 'mode not recorded')}</p>`,
  );
  out.push(
    `<p class="cover-meta">Route: ${escapeHtml(asString(model.route_display))} · Protocol version ${escapeHtml(
      asString(model.protocol_version),
    )}</p>`,
  );
  out.push('<div class="cover-verdict">');
  out.push(
    `<p><span>Decision</span>${escapeHtml(asString(summary.decision) || 'not recorded')}</p>`,
  );
  out.push(
    `<p><span>Readiness</span>${escapeHtml(asString(summary.readiness_headline) || 'not recorded')}</p>`,
  );
  out.push('</div>');
  out.push('<div class="cover-readfirst"><strong>Start here</strong><ol>');
  out.push('<li>Read what this means, then the question.</li>');
  out.push('<li>Read the plan and its acceptance criteria.</li>');
  out.push('<li>Read each member in Part 2, then the conditions.</li>');
  out.push('</ol></div>');
  out.push(`<p class="label-box">${escapeHtml(asString(model.simulation_label))}</p>`);
  out.push(`<p class="label-box">${escapeHtml(asString(model.authorization_notice))}</p>`);
  out.push('</div>');
  out.push('</section>');
  return out.join('\n');
}

function renderSummary(model: Record<string, unknown>): string {
  const summary = asRecord(model.summary);
  const readiness = asRecord(model.readiness);
  const out: string[] = [];
  out.push(sectionHead('1', 'What this means', 'The recorded decision, read in plain language. No new judgement is added.'));
  out.push('<div class="summary-card">');
  out.push('<dl class="glance">');
  out.push(`<div><dt>Decision</dt><dd>${escapeHtml(asString(summary.decision) || 'not recorded')}</dd></div>`);
  out.push(`<div><dt>Readiness</dt><dd>${escapeHtml(asString(summary.readiness_headline) || 'not recorded')}</dd></div>`);
  out.push(`<div><dt>Evidence strength</dt><dd>${escapeHtml(asString(summary.evidence_strength) || 'not recorded')}</dd></div>`);
  out.push(`<div><dt>Conditions</dt><dd>${escapeHtml(asString(summary.conditions_display) || 'none recorded')}</dd></div>`);
  out.push(`<div><dt>Unknowns</dt><dd>${escapeHtml(asString(summary.unknowns_display) || 'none recorded')}</dd></div>`);
  out.push(`<div><dt>Report revision</dt><dd>${escapeHtml(asString(model.report_revision_id))}</dd></div>`);
  out.push('</dl>');
  out.push(`<p>${escapeHtml(asString(summary.reading) || 'No reading sentence was recorded.')}</p>`);
  const reasons = asArray(readiness.reasons).map(asString);
  if (reasons.length > 0) {
    out.push('<p><strong>Why this readiness:</strong></p>');
    out.push(hList(reasons));
  }
  out.push('</div>');
  return out.join('\n');
}

function renderQuestion(model: Record<string, unknown>): string {
  const context = asRecord(model.question_and_context);
  const unknowns = asRecord(context.unknowns);
  const out: string[] = [];
  out.push(sectionHead('2', 'The question and what was recorded', 'The frozen brief, exactly as recorded.'));
  out.push(`<p><strong>Question:</strong> ${escapeHtml(asString(context.question) || asString(model.decision_title))}</p>`);
  out.push('<h3>Confirmed facts</h3>');
  const facts = asArray(context.facts);
  if (facts.length === 0) out.push('<p class="meta">No confirmed facts were recorded.</p>');
  else {
    out.push('<ul>');
    for (const factValue of facts) {
      const fact = asRecord(factValue);
      out.push(`<li>${escapeHtml(asString(fact.statement))}</li>`);
    }
    out.push('</ul>');
  }
  out.push('<h3>Assumptions</h3>');
  out.push(hList(asArray(context.assumptions)));
  out.push('<h3>Unknowns</h3>');
  out.push(
    `<p class="meta">${escapeHtml(
      asString(unknowns.note) ||
        `${Number(unknowns.recorded ?? 0)} unknown(s) recorded; ${Number(
          unknowns.distinct ?? 0,
        )} distinct unknown(s) printed.`,
    )}</p>`,
  );
  if (unknowns.note) {
    out.push(hList(asArray(unknowns.items)));
  } else {
    out.push(hList(asArray(unknowns.items)));
  }
  const domains = asArray(context.critical_domains);
  if (domains.length > 0) {
    out.push('<h3>Critical domains</h3><ul>');
    for (const domainValue of domains) {
      const domain = asRecord(domainValue);
      out.push(
        `<li>${escapeHtml(asString(domain.domain))}: ${escapeHtml(asString(domain.status))}${
          asArray(domain.unresolved_questions).length > 0
            ? ` — open question: ${escapeHtml(asArray(domain.unresolved_questions).map(asString).join('; '))}`
            : ''
        }</li>`,
      );
    }
    out.push('</ul>');
  }
  return out.join('\n');
}

function renderPlan(model: Record<string, unknown>): string {
  const out: string[] = [];
  out.push(sectionHead('3', 'The plan', 'Ordered steps, each with the criterion that says it worked.'));
  const proposals = asArray(model.action_proposals);
  if (proposals.length === 0) out.push('<p class="meta">No action proposals were recorded.</p>');
  proposals.forEach((proposalValue, index) => {
    const proposal = asRecord(proposalValue);
    out.push('<div class="plan-step">');
    out.push(
      `<h3><span class="step-number">Step ${index + 1}</span>${escapeHtml(asString(proposal.title))}</h3>`,
    );
    out.push(`<p>${escapeHtml(asString(proposal.description))}</p>`);
    out.push(`<p><strong>Why:</strong> ${escapeHtml(asString(proposal.rationale) || 'not recorded')}</p>`);
    const criteria = asArray(proposal.acceptance_criteria).map(asString).filter((value) => value.trim().length > 0);
    if (criteria.length > 0) {
      out.push('<p><strong>Done when:</strong></p>');
      out.push(hList(criteria));
    } else {
      out.push(
        '<p class="label-box"><strong>Not ready to execute.</strong> No acceptance criterion was recorded for this step, so it cannot be started until one is recorded and approved. This is an absence in the record, not a pass.</p>',
      );
    }
    const depends = asArray(proposal.depends_on_action_ids).map(asString);
    out.push(
      `<p class="meta">Depends on: ${escapeHtml(depends.length > 0 ? depends.join(', ') : 'none')} · Risk class: ${escapeHtml(
        asString(proposal.risk_class),
      )}</p>`,
    );
    out.push(
      '<p class="meta">Execution authorization: separate execution authorization is required before this step may be acted on.</p>',
    );
    out.push('</div>');
  });
  out.push(`<p><strong>Cheapest informative test:</strong> ${escapeHtml(asStringOrNull(model.cheapest_informative_test) ?? 'none recorded')}</p>`);
  const stop = asArray(model.stop_criteria).map(asString).filter((value) => value.trim().length > 0);
  out.push('<h3>Stop if</h3>');
  if (stop.length > 0) out.push(hList(stop));
  else out.push('<p class="meta">No stop condition was recorded. That is an absence in the record, not permission to continue indefinitely.</p>');
  const review = asArray(model.review_criteria).map(asString).filter((value) => value.trim().length > 0);
  out.push('<h3>How you will know it worked</h3>');
  if (review.length > 0) out.push(hList(review));
  else out.push('<p class="meta">No outcome review criterion was recorded. That is an absence in the record, not a pass.</p>');
  return out.join('\n');
}

function renderHowToUse(model: Record<string, unknown>, number = '4'): string {
  const howToUse = asArray(model.how_to_use).map(asString);
  const out: string[] = [];
  out.push(sectionHead(number, 'How to use this report', null));
  out.push(howToUse.length > 0 ? hList(howToUse) : '<p class="meta">No reading guide was recorded.</p>');
  return out.join('\n');
}

function renderTools(model: Record<string, unknown>, number = '5'): string {
  const tools = asRecord(model.your_tools);
  const out: string[] = [];
  out.push(sectionHead(number, 'Helpers that fit the plan', null));
  const status = asString(tools.status);
  out.push(`<p>${escapeHtml(asString(tools.note) || 'No installation capability snapshot was recorded.')}</p>`);
  if (status === 'matched') {
    const matches = asArray(tools.matches);
    out.push('<ul>');
    for (const matchValue of matches) {
      const match = asRecord(matchValue);
      const actions = asArray(match.matched_action_titles).map(asString).join(', ');
      out.push(
        `<li><strong>${escapeHtml(asString(match.name))}</strong> <span class="meta">(${escapeHtml(
          asString(match.kind),
        )}, ${escapeHtml(asString(match.capability_id))}, ${escapeHtml(
          asString(match.availability),
        )})</span> — exact ${escapeHtml(asString(match.match_basis))} match for ${escapeHtml(
          actions || 'the plan',
        )}</li>`,
      );
    }
    out.push('</ul>');
  }
  if (tools.no_match_note) {
    out.push(`<p class="meta">${escapeHtml(asString(tools.no_match_note))}</p>`);
  }
  const limitations = asArray(tools.limitations).map(asString);
  if (limitations.length > 0) {
    out.push('<h3>What was read, and what was not</h3>');
    out.push(hList(limitations));
  }
  out.push(`<p class="meta">${escapeHtml(asString(tools.availability_note))}</p>`);
  out.push(
    `<p class="meta">${escapeHtml(
      asString(tools.exactness_note) ||
        'Only a recorded plan reference or an exact whole-phrase name counts. Shared words, prefixes, and fuzzy similarity are not matches.',
    )}</p>`,
  );
  return out.join('\n');
}

function renderScoreTable(model: Record<string, unknown>): string {
  const out: string[] = [];
  out.push(sectionHead('6', 'Alternatives and scores', 'Weighted means computed by deterministic scoring code, not by a model.'));
  const rows = asArray(model.score_table);
  if (rows.length === 0) {
    out.push('<p class="meta">No score rows were recorded.</p>');
    return out.join('\n');
  }
  out.push('<div class="stacked">');
  for (const rowValue of rows) {
    const row = asRecord(rowValue);
    const abstained = asArray(row.abstained_seat_ids).map(asString).join(', ') || 'none';
    out.push('<div class="stacked-row"><dl>');
    out.push(
      `<dt>${escapeHtml(asString(row.option_id))} (${escapeHtml(asString(row.option_label))})</dt>`,
    );
    out.push(
      `<dd>Score: ${escapeHtml(formatScore(asNumberOrNull(row.score)))} · Display score: ${escapeHtml(
        formatDisplayScore(asNumberOrNull(row.display_score)),
      )} · Coverage: ${escapeHtml(formatCoverage(asNumberOrNull(row.coverage)))}</dd>`,
    );
    out.push(
      `<dd>Weighted sum ${escapeHtml(formatPlainNumber(asNumberOrNull(row.weighted_sum)))} of ${escapeHtml(
        formatPlainNumber(asNumberOrNull(row.denominator)),
      )} possible weight · Spread ${escapeHtml(formatPlainNumber(asNumberOrNull(row.spread)))}</dd>`,
    );
    out.push(`<dd>Abstained: ${escapeHtml(abstained)}</dd>`);
    out.push('</dl></div>');
  }
  out.push('</div>');
  return out.join('\n');
}

/**
 * The saved-round debate. This is the ACTUAL card record: rounds saved,
 * what changed between rounds, whether the council split, and the explicit
 * absence of a chair stop note. A consult prints zero rounds and says so;
 * no nine-seat debate is invented.
 */
function renderRounds(model: Record<string, unknown>): string {
  const out: string[] = [];
  out.push(sectionHead('7', 'The debate', 'Only the saved advisor rounds. No round or reason is invented.'));
  // CTR-171: read the debate through the CTR-169 guard. A model with no
  // debate object (an absent record, or a consult whose model carries
  // debate: null) prints an explicit absence and returns here; nothing
  // reads highest_round off a bare cast.
  const debateInput = readReportDebateInput(model.debate);
  if (!debateInput.present) {
    out.push(
      '<p class="meta">No saved debate record is present in this report. Nothing is inferred: no rounds, seats, positions, or chair stop note are reported.</p>',
    );
    return out.join('\n');
  }
  const debate = debateInput.record;
  const highest = asNumberOrNull(debate.highest_round);
  out.push(
    `<p><strong>Rounds saved:</strong> ${escapeHtml(String(Number(debate.rounds_saved ?? 0)))} · ` +
      `<strong>Highest round:</strong> ${escapeHtml(
        highest === null ? 'none' : String(highest),
      )} · <strong>Split:</strong> ${debate.split === true ? 'yes' : debate.split === false ? 'no' : 'not available'}</p>`,
  );
  out.push(hList(asArray(debate.notes)));
  for (const roundValue of asArray(debate.rounds)) {
    const round = asRecord(roundValue);
    out.push(`<h3>Round ${escapeHtml(String(Number(round.round ?? 0)))}</h3>`);
    const seats = asArray(round.seats);
    if (seats.length === 0) {
      out.push('<p class="meta">No seat cards were saved for this round.</p>');
    } else {
      out.push('<ul>');
      for (const seatValue of seats) {
        const seat = asRecord(seatValue);
        out.push(
          `<li>${escapeHtml(asString(seat.display_name))}: ${escapeHtml(
            asString(seat.stance_text) || asString(seat.stance),
          )} — ${escapeHtml(asString(seat.preferred_option_label))}</li>`,
        );
      }
      out.push('</ul>');
    }
  }
  const changes = asArray(debate.changes);
  out.push('<h3>What changed between saved rounds</h3>');
  if (changes.length === 0) {
    out.push('<p class="meta">No seat changed its stance or preferred option between the saved rounds.</p>');
  } else {
    out.push('<ul>');
    for (const changeValue of changes) {
      const change = asRecord(changeValue);
      out.push(
        `<li>Round ${escapeHtml(String(Number(change.round ?? 0)))} — ${escapeHtml(
          asString(change.display_name),
        )}: ${escapeHtml(asString(change.from_stance_text))} / ${escapeHtml(
          asString(change.from_option_label),
        )} → ${escapeHtml(asString(change.to_stance_text))} / ${escapeHtml(
          asString(change.to_option_label),
        )}</li>`,
      );
    }
    out.push('</ul>');
  }
  const positions = asArray(debate.positions);
  if (positions.length > 0) {
    out.push('<h3>Final positions</h3><ul>');
    for (const positionValue of positions) {
      const position = asRecord(positionValue);
      out.push(
        `<li>${escapeHtml(asString(position.option_label))}: ${escapeHtml(
          asArray(position.seat_names).map(asString).join(', '),
        )}</li>`,
      );
    }
    out.push('</ul>');
  }
  out.push(
    `<p class="meta">${escapeHtml(
      asString(asRecord(debate.stop_record ?? {}).note) ||
        'The saved record contains no chair stop note.',
    )}</p>`,
  );
  return out.join('\n');
}


function renderDebate(model: Record<string, unknown>): string {
  const verdict = asRecord(model.verdict_block);
  const out: string[] = [];
  out.push(sectionHead('8', 'Why, and the strongest concern', null));
  out.push('<h3>Main reasons</h3>');
  out.push(hList(asArray(model.main_reasons)));
  out.push(
    `<p><strong>Strongest concern:</strong> ${escapeHtml(asStringOrNull(model.strongest_dissent) ?? 'none recorded')}</p>`,
  );
  out.push(
    `<p><strong>Evidence strength:</strong> ${escapeHtml(asStringOrNull(verdict.evidence_strength) ?? 'not recorded')}</p>`,
  );
  return out.join('\n');
}

function renderConditions(model: Record<string, unknown>): string {
  const summary = asRecord(model.conditions_summary) as unknown as ConditionSummary;
  const items = asArray(summary.items);
  const out: string[] = [];
  out.push(sectionHead('9', 'Conditions and safeguards', null));
  out.push(
    `<p>${Number(summary.total ?? 0)} recorded · ${Number(summary.open ?? 0)} open · ${Number(
      summary.satisfied ?? 0,
    )} satisfied · ${Number(summary.waived ?? 0)} waived by the owner · ${Number(
      summary.unresolved ?? 0,
    )} unresolved · ${Number(summary.blocking_open ?? 0)} blocking and open.</p>`,
  );
  if (items.length === 0) {
    out.push('<p class="meta">No conditions were recorded on this verdict or its final cards.</p>');
    return out.join('\n');
  }
  out.push('<ul>');
  for (const itemValue of items) {
    const item = asRecord(itemValue);
    out.push(
      `<li>${escapeHtml(asString(item.description))} <span class="meta">(${escapeHtml(
        asString(item.kind),
      )}, ${escapeHtml(asString(item.status))}${item.blocking === true ? ', blocking' : ''}, source: ${escapeHtml(
        asString(item.source),
      )})</span></li>`,
    );
  }
  out.push('</ul>');
  return out.join('\n');
}

function renderAdvisors(model: Record<string, unknown>, options: RenderPrintOptions): string {
  const redacted = model.redacted === true;
  const cover = options.cover ?? null;
  const out: string[] = [];
  out.push(sectionHead('10', 'Each member of the council', 'One entry per recorded seat, in roster order.'));
  for (const seatValue of asArray(model.seats)) {
    const seat = asRecord(seatValue);
    const seatId = asString(seat.seat_id);
    const displayName = asString(seat.display_name);
    out.push('<div class="advisor-card">');
    out.push('<div class="advisor-head">');
    out.push(portraitFor(cover, seatId, displayName, redacted));
    out.push(`<h3>${escapeHtml(displayName)}</h3>`);
    out.push('</div>');
    out.push(`<p class="meta">${escapeHtml(asString(seat.label))}</p>`);
    out.push(
      `<p class="meta">Source qualification: ${escapeHtml(qualificationText(seat.qualification))} · Stance: ${escapeHtml(
        asString(seat.stance),
      )} · Preferred option: ${escapeHtml(asStringOrNull(seat.preferred_option_id) ?? 'none')}</p>`,
    );
    out.push('<p><strong>Decisive arguments:</strong></p>');
    out.push(hList(asArray(seat.decisive_arguments)));
    out.push(`<p><strong>Strongest objection:</strong> ${escapeHtml(asString(seat.strongest_objection))}</p>`);
    out.push(`<p><strong>What would change my mind:</strong> ${escapeHtml(asString(seat.change_my_mind))}</p>`);
    const abstained = asArray(seat.abstained_option_ids).map(asString);
    if (abstained.length > 0) {
      out.push(`<p class="meta">Abstained on: ${escapeHtml(abstained.join(', '))}</p>`);
    }
    const stance = asStringOrNull(seat.resolution_stance);
    if (stance !== null) out.push(`<p class="meta">Resolution stance: ${escapeHtml(stance)}</p>`);
    out.push('</div>');
  }
  return out.join('\n');
}

function renderAmendments(model: Record<string, unknown>): string {
  const amendments = asRecord(model.amendments);
  const ratification = asRecord(model.ratification);
  const describe = (value: unknown): string => {
    const amendment = asRecord(value);
    return `${asString(amendment.amendment_id)} by ${asString(amendment.proposing_seat_id)}: ${asString(
      amendment.statement,
    )} (${asString(amendment.materiality)}, ${asString(amendment.disposition)})`;
  };
  const out: string[] = [];
  out.push(sectionHead('11', 'Amendments and ratification', null));
  out.push('<h3>Accepted amendments</h3>');
  const accepted = asArray(amendments.accepted);
  out.push(accepted.length > 0 ? `<ul>${accepted.map((a) => `<li>${escapeHtml(describe(a))}</li>`).join('')}</ul>` : '<p class="meta">None recorded.</p>');
  out.push('<h3>Rejected amendments</h3>');
  const rejected = asArray(amendments.rejected);
  out.push(rejected.length > 0 ? `<ul>${rejected.map((a) => `<li>${escapeHtml(describe(a))}</li>`).join('')}</ul>` : '<p class="meta">None recorded.</p>');
  out.push(
    `<p>Ratification status: ${escapeHtml(asStringOrNull(ratification.status) ?? 'not applicable')}</p>`,
  );
  const support = ratification.resolution_support as Record<string, unknown> | null;
  if (support) {
    out.push(
      `<p>Resolution support (weighted counts, not a probability): support ${escapeHtml(
        formatPlainNumber(asNumberOrNull(support.support)),
      )}, conditional support ${escapeHtml(
        formatPlainNumber(asNumberOrNull(support.conditional_support)),
      )}, opposition ${escapeHtml(formatPlainNumber(asNumberOrNull(support.opposition)))}, abstention ${escapeHtml(
        formatPlainNumber(asNumberOrNull(support.abstention)),
      )}, bound to resolution ${escapeHtml(asString(support.resolution_sha256))}.</p>`,
    );
  }
  return out.join('\n');
}

function renderRecords(model: Record<string, unknown>, number = '12'): string {
  const verdict = asRecord(model.verdict_block);
  const provenance = asRecord(model.provenance);
  const out: string[] = [];
  out.push(sectionHead(number, 'For your records', 'Identifiers and hashes only. No source text is reproduced.'));
  out.push('<div class="record"><dl>');
  out.push(`<dt>Session</dt><dd>${escapeHtml(asString(model.session_id))}</dd>`);
  out.push(`<dt>Report revision</dt><dd>${escapeHtml(asString(model.report_revision_id))}</dd>`);
  out.push(`<dt>Verdict revision</dt><dd>${escapeHtml(String(verdict.revision))}</dd>`);
  out.push(`<dt>Verdict content SHA-256</dt><dd>${escapeHtml(asString(verdict.content_sha256))}</dd>`);
  out.push(`<dt>Brief SHA-256</dt><dd>${escapeHtml(asString(verdict.brief_sha256))}</dd>`);
  out.push(`<dt>Protocol version</dt><dd>${escapeHtml(asString(model.protocol_version))}</dd>`);
  if (model.redacted === true) {
    out.push(`<dt>Redaction</dt><dd>Yes (profile ${escapeHtml(asString(model.redaction_profile_id))})</dd>`);
  }
  out.push('</dl></div>');
  out.push('<h3>Source and provenance appendix</h3>');
  out.push(`<p>${escapeHtml(asString(provenance.note))}</p>`);
  out.push('<div class="stacked">');
  for (const entryValue of asArray(provenance.evidence_manifest)) {
    const entry = asRecord(entryValue);
    out.push(
      `<div class="stacked-row"><dl><dt>${escapeHtml(asString(entry.evidence_id))}</dt><dd>Kind: ${escapeHtml(
        asString(entry.source_kind),
      )}</dd><dd>Locator: ${escapeHtml(asString(entry.locator))}</dd><dd>SHA-256: ${escapeHtml(
        asString(entry.sha256),
      )}</dd></dl></div>`,
    );
  }
  out.push('</div>');
  return out.join('\n');
}

function renderConsult(model: Record<string, unknown>): string {
  const consult = asRecord(model.consult);
  const out: string[] = [];
  out.push(
    sectionHead(
      '2',
      'The consultation',
      'One recorded seat. No score, no council verdict, no council debate.',
    ),
  );
  out.push('<div class="consult-card">');
  out.push(`<h3>${escapeHtml(asString(consult.display_name))}</h3>`);
  out.push(`<p class="meta">${escapeHtml(asString(consult.label))}</p>`);
  out.push(`<p>${escapeHtml(asString(consult.answer))}</p>`);
  out.push('<h3>Assumptions</h3>');
  out.push(hList(asArray(consult.assumptions)));
  out.push('<h3>Limits of this answer</h3>');
  out.push(hList(asArray(consult.limits)));
  out.push(`<p><strong>Next step:</strong> ${escapeHtml(asString(consult.next_step))}</p>`);
  // CTR-168: state the absence of a debate explicitly in the print/PDF
  // exports too, so a consult report never reads as a nine-seat council
  // round. The note stays inside section 2; the section numbering is
  // unchanged.
  out.push(
    `<p class="meta">${escapeHtml(asString(model.debate_note) || CONSULT_NO_DEBATE_NOTE)}</p>`,
  );
  out.push('</div>');
  out.push(renderHowToUse(model, '3'));
  out.push(renderTools(model, '4'));
  out.push(renderRecords(model, '5'));
  return out.join('\n');
}

export function renderPrintHtml(
  model: Record<string, unknown>,
  options: RenderPrintOptions = {},
): string {
  const out: string[] = [];
  out.push('<!DOCTYPE html>');
  out.push('<html lang="en">');
  out.push('<head>');
  out.push('<meta charset="utf-8">');
  out.push(
    `<title>Council report ${escapeHtml(asString(model.session_id))} revision ${escapeHtml(
      String(asRecord(model.verdict_block).revision),
    )}</title>`,
  );
  out.push(`<style>${PRINT_CSS}</style>`);
  out.push('</head>');
  out.push('<body>');
  out.push(renderCover(model, options));
  out.push(renderSummary(model));
  if (model.consult) {
    out.push(renderConsult(model));
  } else {
    out.push(renderQuestion(model));
    out.push(renderPlan(model));
    out.push(renderHowToUse(model));
    out.push(renderTools(model));
    out.push('<div class="part-banner part-start">Part 2 · The full record: options, members, conditions, and sources</div>');
    out.push(renderScoreTable(model));
    out.push(renderRounds(model));
    out.push(renderDebate(model));
    out.push(renderConditions(model));
    out.push(renderAdvisors(model, options));
    out.push(renderAmendments(model));
    out.push(renderRecords(model));
  }
  out.push('<footer class="report-footer">');
  out.push(
    `<p>${escapeHtml(asString(model.simulation_label))}</p><p>${escapeHtml(asString(model.authorization_notice))}</p>`,
  );
  out.push('</footer>');
  out.push('</body>');
  out.push('</html>');
  return `${out.join('\n')}\n`;
}

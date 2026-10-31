/**
 * CTR-171 — shared report-model guards.
 *
 * The plain-object guard and the one safe debate reader live here so both
 * the report model builder (report-downloads.ts) and the print renderer
 * (report-print-template.ts) can use them without importing each other.
 * They were exported from report-downloads by CTR-169; that module still
 * re-exports them, so the CTR-169 public interface is unchanged.
 *
 * This module has no dependencies: importing it never pulls the export
 * journal, the PDF renderer, or a database handle into a caller.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * CTR-169: the one safe debate reader. A model without a debate object
 * yields `present: false` and an empty record; callers must print an
 * explicit no-saved-debate block rather than reading properties off a
 * cast.
 */
export interface ReportDebateInput {
  present: boolean;
  record: Record<string, unknown>;
}

export function readReportDebateInput(value: unknown): ReportDebateInput {
  return isPlainRecord(value)
    ? { present: true, record: value }
    : { present: false, record: {} };
}

/**
 * Export result reading for the Council export menu (CTR-163; audit
 * row FX-024).
 *
 * The export service returns a CouncilExportResult with one artifact
 * per requested format (`artifacts[]`), each carrying a same-origin
 * `download_url`. The old menu looked only for a top-level
 * `download_url`, so a successful export never produced a clickable
 * link. This helper reads the real shape, picks the exact artifact
 * for the requested format, and refuses any URL that is not the
 * same-origin export download route.
 */

export type CouncilExportFormatName = 'markdown' | 'json' | 'pdf';

export interface CouncilExportArtifactView {
  export_id?: string;
  format?: string;
  filename?: string;
  media_type?: string;
  sha256?: string;
  byte_size?: number;
  download_url?: string;
  replayed?: boolean;
}

export interface CouncilExportLink {
  url: string;
  filename: string;
  sha256: string | null;
  format: string;
  replayed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/api/council/exports/')) return null;
  return value;
}

/**
 * Find the exact artifact for a client format. `json` maps to the
 * record_json artifact; the service names it `record_json`.
 */
export function pickCouncilExportLink(
  record: unknown,
  format: CouncilExportFormatName,
): CouncilExportLink | null {
  const body = asRecord(record);
  if (!body) return null;
  const wanted = format === 'json' ? 'record_json' : format;
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
  for (const value of artifacts) {
    const artifact = asRecord(value);
    if (!artifact) continue;
    if (artifact.format !== wanted) continue;
    const url = safeDownloadUrl(artifact.download_url);
    if (url === null) continue;
    return {
      url,
      filename:
        typeof artifact.filename === 'string' && artifact.filename.length > 0
          ? artifact.filename
          : 'council-report',
      sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null,
      format: wanted,
      replayed: artifact.replayed === true,
    };
  }
  // Legacy single-artifact shape: accepted only when it is the exact
  // requested format (or the record names no format at all).
  const legacyUrl = safeDownloadUrl(body.download_url);
  const legacyFormat = typeof body.format === 'string' ? body.format : wanted;
  if (legacyUrl !== null && legacyFormat === wanted) {
    return {
      url: legacyUrl,
      filename: typeof body.filename === 'string' ? body.filename : 'council-report',
      sha256: typeof body.sha256 === 'string' ? body.sha256 : null,
      format: wanted,
      replayed: body.replayed === true,
    };
  }
  return null;
}

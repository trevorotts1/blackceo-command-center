import { NextResponse, type NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  handleCouncil,
} from '@/lib/council/api/foundation';
import { locateExportSession, readExportDownload } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/exports/:exportId (CWE-050, CWE-038's CC
 * remainder; Sections 24.1, 24.4, B15).
 *
 * Downloads one registered report artifact. Authorization and
 * session liveness are rechecked on EVERY request: the export's
 * owning session is resolved inside the caller's scope, the
 * CWE-007 session read rule runs, a deleted session refuses with
 * EXPORT_SESSION_DELETED (T059), and the bytes are re-rendered from
 * committed state and verified against the journaled artifact hash
 * before serving — unrecorded or drifted bytes are never returned.
 * Headers follow Section 24.4: safe filename, attachment
 * disposition, registered media type, no-cache for private reports.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ exportId: string }> },
) {
  const { exportId } = await params;
  return handleCouncil(request, async (ctx) => {
    const sessionId = locateExportSession(ctx, exportId);
    const authorized = authorizeSessionRead(ctx, sessionId);
    const download = readExportDownload(ctx, authorized, sessionId, exportId);
    return new NextResponse(download.bytes, { status: 200, headers: download.headers });
  });
}

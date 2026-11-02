import { NextResponse, type NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  handleCouncil,
} from '@/lib/council/api/foundation';
import { renderSessionReportPdf } from '@/lib/council/report-downloads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/chamber-sessions/:id/report.pdf
 * (CTR-191 canonical download contract.)
 *
 * The canonical chamber links `/council/<id>/report.pdf`; next.config.mjs
 * rewrites that path here. Authorization is the same CWE-007 session read
 * rule every chamber read uses, against this app's own managed store. The
 * renderer refuses a session with no valid committed verdict, with the
 * existing typed export codes; no placeholder PDF is ever produced. Nothing
 * is journaled by a download, so a GET cannot create authority.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return handleCouncil(request, async (ctx) => {
    const { envelope } = authorizeSessionRead(ctx, sessionId);
    const file = await renderSessionReportPdf(
      { repositories: ctx.repositories, store: ctx.store },
      envelope,
      sessionId,
    );
    return new NextResponse(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'content-type': file.media_type,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'content-length': String(file.bytes.length),
        'cache-control': 'private, no-store',
      },
    });
  });
}

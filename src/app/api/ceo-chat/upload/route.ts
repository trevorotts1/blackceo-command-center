/**
 * POST /api/ceo-chat/upload (P5-01 (c) step 1)
 *
 * Multipart upload for the My AI CEO surface. Enforces an allow-list of types
 * (pdf/docx/txt/md/png/jpg/mp4/mov…) and a hard size cap (200MB) — see
 * src/lib/ceo-chat/upload.ts, the pure validator the QC break-it probes (5GB
 * file, an executable) target — then stores the bytes under
 * `<workspace>/inbox/ceo-chat/<date>/` where the on-box agent can actually read
 * them, and records an upload receipt in the transcript. Returns the PATH the
 * agent was told about.
 *
 * The size is checked from the File descriptor BEFORE the bytes are read into
 * memory, so a 5GB upload is refused without buffering it.
 *
 * Auth: same-origin + bearer via the existing middleware contract (non-webhook
 * /api route).
 */
import { NextRequest, NextResponse } from 'next/server';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { insertCeoChatMessage } from '@/lib/ceo-chat/store';
import { isMyAiCeoBetaEnabled } from '@/lib/ceo-chat/config';
import { validateUpload, resolveInboxDir, resolveWorkspaceRoot } from '@/lib/ceo-chat/upload';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Map a validator reject reason to the right HTTP status. */
function statusForReason(reason?: string): number {
  switch (reason) {
    case 'too-large':
      return 413; // Payload Too Large
    case 'type-not-allowed':
      return 415; // Unsupported Media Type
    default:
      return 400; // Bad Request (empty / bad filename)
  }
}

export async function POST(request: NextRequest) {
  if (!isMyAiCeoBetaEnabled()) {
    return NextResponse.json({ error: 'My AI CEO (BETA) is disabled on this box.' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  const sessionId = (form.get('sessionId') as string | null)?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }

  // Validate from the descriptor (name/type/size) BEFORE reading any bytes.
  const verdict = validateUpload({ filename: file.name, mimeType: file.type, size: file.size });
  if (!verdict.ok || !verdict.safeName) {
    return NextResponse.json(
      { error: verdict.message || 'Upload rejected', reason: verdict.reason },
      { status: statusForReason(verdict.reason) },
    );
  }

  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const dir = resolveInboxDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });

    // Avoid clobbering a same-named prior upload by prefixing a short unique id.
    const storedName = `${Date.now().toString(36)}-${verdict.safeName}`;
    const fullPath = path.join(dir, storedName);

    const bytes = Buffer.from(await file.arrayBuffer());
    writeFileSync(fullPath, bytes);

    // Record the upload receipt in the transcript so the agent (and the history
    // reload) sees exactly what was shared and where it landed.
    insertCeoChatMessage({
      sessionId,
      role: 'user',
      content: `Uploaded ${verdict.safeName}`,
      kind: 'upload',
      attachmentPath: fullPath,
      attachmentName: verdict.safeName,
      attachmentType: file.type || `application/${verdict.ext}`,
      attachmentSize: file.size,
    });

    console.log(`[ceo-chat upload] stored ${file.size} bytes at ${fullPath}`);
    return NextResponse.json(
      { ok: true, path: fullPath, name: verdict.safeName, size: file.size, type: file.type || null },
      { status: 201 },
    );
  } catch (err) {
    console.error('[/api/ceo-chat/upload] failed:', err);
    return NextResponse.json({ error: 'Failed to store upload' }, { status: 500 });
  }
}

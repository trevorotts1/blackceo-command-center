import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { validateLogoUrl } from '@/lib/validation';
import { getClientContext, updateClient } from '@/lib/clients';
import { uploadLogoToGhlMediaLibrary } from '@/lib/branding';
import { ensureRuntimeConfigFile } from '@/lib/runtime-config';

// Node runtime — uses fs + fetch/FormData for the GHL upload.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const LOGO_CONFIG_PATH = ensureRuntimeConfigFile('logo-config.json');

/** Serve the machine-local baseline instead of requiring a Git-tracked public file. */
export async function GET() {
  try {
    const raw = await readFile(LOGO_CONFIG_PATH, 'utf-8');
    return NextResponse.json(JSON.parse(raw) as { logoUrl?: string });
  } catch {
    return NextResponse.json({ logoUrl: '' });
  }
}

/**
 * POST /api/logo  (D3)
 *
 * Body: { logoUrl: string }
 *
 * 1. Validates the URL is a direct, public image link.
 * 2. Confirms the URL actually returns an image (HEAD).
 * 3. Uploads the logo to the SELECTED client's GoHighLevel ("Convert and Flow")
 *    media library — UNLESS it is already a GHL-hosted URL — and uses the URL
 *    GHL returns going forward (documented endpoint:
 *    POST https://services.leadconnectorhq.com/medias/upload-file).
 * 4. Persists the (GHL) URL on the client tenant record (logo_url) so the
 *    Header swaps in the client's logo, and mirrors it to logo-config.json for
 *    the host-wide baseline.
 *
 * The GHL upload is best-effort: if no Location PIT is configured or the upload
 * fails, we keep the validated source URL and still save it (the logo still
 * works; it just was not mirrored into GHL). The response reports which path
 * was taken.
 */
export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid request. Please send a JSON body with a logoUrl field.' },
      { status: 400 }
    );
  }

  const { logoUrl } = body as { logoUrl?: string };

  if (!logoUrl || typeof logoUrl !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Please provide a logoUrl in the request body.' },
      { status: 400 }
    );
  }

  // Validate URL format, extension, and blocked providers
  const validation = validateLogoUrl(logoUrl);
  if (!validation.valid) {
    return NextResponse.json(
      { success: false, message: validation.error },
      { status: 400 }
    );
  }

  // Fetch the URL to confirm it actually returns an image
  try {
    const response = await fetch(logoUrl, { method: 'HEAD' });

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: `That URL returned an error (status ${response.status}). Please make sure the image is publicly accessible.`,
        },
        { status: 400 }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return NextResponse.json(
        {
          success: false,
          message: `That URL does not point to an image file. The server returned content type "${contentType}". Please use a direct link to an image file.`,
        },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      {
        success: false,
        message: 'Could not reach that URL. Please make sure the image is publicly accessible on the internet.',
      },
      { status: 400 }
    );
  }

  // D3: mirror into the selected client's GHL media library (best-effort).
  let finalUrl = logoUrl;
  let ghlUploaded = false;
  let ghlAlreadyHosted = false;
  let ghlNote: string | undefined;
  try {
    const ghl = await uploadLogoToGhlMediaLibrary(logoUrl);
    if (ghl.ok && ghl.url) {
      finalUrl = ghl.url;
      ghlAlreadyHosted = !!ghl.alreadyHosted;
      ghlUploaded = !ghl.alreadyHosted;
    } else if (!ghl.ok) {
      ghlNote = ghl.error;
    }
  } catch (e) {
    ghlNote = (e as Error).message;
  }

  // Persist on the selected client tenant record.
  try {
    const client = getClientContext();
    if (client) {
      updateClient(client.id, { logo_url: finalUrl });
    }
  } catch (e) {
    console.warn('[POST /api/logo] could not persist logo_url on client:', e);
  }

  // Mirror to logo-config.json for the host-wide baseline / non-tenant reads.
  try {
    await writeFile(LOGO_CONFIG_PATH, JSON.stringify({ logoUrl: finalUrl }, null, 2), 'utf-8');
  } catch {
    return NextResponse.json(
      { success: false, message: 'The logo URL was valid, but there was a problem saving the configuration on the server.' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'Logo updated successfully. Your new logo will appear the next time the dashboard loads.',
    logoUrl: finalUrl,
    ghl: {
      uploaded: ghlUploaded,
      alreadyHosted: ghlAlreadyHosted,
      ...(ghlNote ? { note: ghlNote } : {}),
    },
  });
}

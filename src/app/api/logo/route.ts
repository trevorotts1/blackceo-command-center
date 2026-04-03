import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { validateLogoUrl } from '@/lib/validation';

const LOGO_CONFIG_PATH = join(process.cwd(), 'public', 'logo-config.json');

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
  } catch (error) {
    console.error('Failed to fetch logo URL:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Could not reach that URL. Please make sure the image is publicly accessible on the internet.',
      },
      { status: 400 }
    );
  }

  // Write the validated URL to logo-config.json
  try {
    await writeFile(LOGO_CONFIG_PATH, JSON.stringify({ logoUrl }, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save logo config:', error);
    return NextResponse.json(
      { success: false, message: 'The logo URL was valid, but there was a problem saving the configuration on the server.' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    message: 'Logo updated successfully. Your new logo will appear the next time the dashboard loads.',
    logoUrl,
  });
}

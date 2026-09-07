import { NextRequest, NextResponse } from 'next/server';
import { createInterviewInvitation } from '@/lib/interview/invitation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    return await createInterviewInvitation(req, body?.recipientHash);
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'private, no-store' } });
  }
}

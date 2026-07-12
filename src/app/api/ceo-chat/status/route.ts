/**
 * GET /api/ceo-chat/status (P5-01)
 *
 * Cheap surface the dashboard card + the /my-ai-ceo page poll to decide whether
 * to show the feature (BETA flag) and to render the graceful gateway-down state
 * ("Your AI CEO is restarting — Telegram still works", spec (c) step 3). Always
 * 200 with a graceful shape; never throws to the client.
 */
import { NextResponse } from 'next/server';
import { isMyAiCeoBetaEnabled } from '@/lib/ceo-chat/config';
import { gatewayStatus } from '@/lib/ceo-chat/gateway';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const enabled = isMyAiCeoBetaEnabled();
  if (!enabled) {
    return NextResponse.json({ ok: true, enabled: false, gateway: { up: false } });
  }
  let gateway: { up: boolean; detail?: string } = { up: false };
  try {
    gateway = await gatewayStatus();
  } catch (err) {
    gateway = { up: false, detail: err instanceof Error ? err.message : String(err) };
  }
  return NextResponse.json({ ok: true, enabled: true, gateway, generatedAt: new Date().toISOString() });
}

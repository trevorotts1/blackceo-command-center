/**
 * /api/operator/tts
 *
 * Track B8 (SCOPE-ADDITION Section 6.4, 6.5).
 *
 * GET  → reports which TTS providers are configured on this deployment.
 * POST → proxies a synthesis request to the chosen provider and streams the
 *        audio bytes back to the browser. The client never sees the API key.
 *
 * Provider selection order when no explicit `?provider=` is supplied:
 *   1. DEFAULT_CALL_TTS_PROVIDER env var (if set)
 *   2. openai     (OPENAI_API_KEY)
 *   3. elevenlabs (ELEVENLABS_API_KEY)
 *
 * Fish Audio and xAI voice are listed in the full priority order in
 * SCOPE-ADDITION Section 6.3 (positions 2 and 3). They are not wired here in
 * this commit; Track C2 may add them by appending to the switch statement.
 *
 * On provider error the route falls back to the next configured provider in
 * the priority list and surfaces `x-tts-provider` so the client can display
 * a "fell back to X" toast.
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProviderId = 'openai' | 'elevenlabs' | 'fish_audio' | 'xai' | 'browser';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  fish_audio: 'Fish Audio',
  xai: 'xAI Voice',
  browser: 'Browser (built-in)',
};

function isProviderConfigured(id: ProviderId): boolean {
  switch (id) {
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY);
    case 'elevenlabs':
      return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
    case 'fish_audio':
      return Boolean(process.env.FISH_AUDIO_API_KEY);
    case 'xai':
      return Boolean(process.env.X_AI_API_KEY);
    case 'browser':
      return true;
  }
}

function priorityOrder(): ProviderId[] {
  const def = (process.env.DEFAULT_CALL_TTS_PROVIDER || '').toLowerCase() as ProviderId;
  const baseline: ProviderId[] = ['openai', 'fish_audio', 'xai', 'elevenlabs', 'browser'];
  if (def && baseline.includes(def)) {
    return [def, ...baseline.filter((p) => p !== def)];
  }
  return baseline;
}

export async function GET() {
  const all: ProviderId[] = ['openai', 'elevenlabs', 'fish_audio', 'xai', 'browser'];
  const providers = all.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    available: isProviderConfigured(id),
  }));
  return NextResponse.json({ providers, default: priorityOrder()[0] });
}

interface SynthBody {
  text?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SynthBody;
  try {
    body = (await req.json()) as SynthBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: 'text exceeds 4000 character limit' }, { status: 400 });
  }

  const url = new URL(req.url);
  const requested = (url.searchParams.get('provider') || '').toLowerCase() as ProviderId | '';
  const voiceOverride = url.searchParams.get('voice') || undefined;

  const candidates: ProviderId[] = [];
  if (requested && isProviderConfigured(requested as ProviderId)) {
    candidates.push(requested as ProviderId);
  }
  for (const id of priorityOrder()) {
    if (id === 'browser') continue;
    if (!candidates.includes(id) && isProviderConfigured(id)) candidates.push(id);
  }

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: 'No server-side TTS provider configured. Use the browser fallback.' },
      { status: 503 },
    );
  }

  let lastError: string | null = null;
  for (const providerId of candidates) {
    try {
      const synth = await synthesize(providerId, text, voiceOverride);
      return new NextResponse(synth.body, {
        status: 200,
        headers: {
          'content-type': synth.contentType,
          'x-tts-provider': providerId,
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return NextResponse.json(
    { error: `All configured TTS providers failed. Last error: ${lastError}` },
    { status: 502 },
  );
}

interface SynthResult {
  body: ArrayBuffer;
  contentType: string;
}

async function synthesize(provider: ProviderId, text: string, voice: string | undefined): Promise<SynthResult> {
  if (provider === 'openai') return synthesizeOpenAi(text, voice);
  if (provider === 'elevenlabs') return synthesizeElevenLabs(text, voice);
  throw new Error(`Provider ${provider} is not implemented in this build`);
}

async function synthesizeOpenAi(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const v = voice || process.env.OPENAI_TTS_VOICE || 'alloy';
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice: v,
      input: text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`OpenAI TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function synthesizeElevenLabs(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const voiceId = voice || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID is not set');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      output_format: 'mp3_44100_128',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`ElevenLabs TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return res.statusText;
  }
}

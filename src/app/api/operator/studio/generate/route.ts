/**
 * POST /api/operator/studio/generate
 *
 * Kicks off an async media generation. Returns the job id immediately. The
 * UI polls `GET /api/operator/studio/jobs/[id]` for status + result_url.
 *
 * Request body:
 *   {
 *     kind: 'image' | 'video' | 'audio',
 *     prompt: string,
 *     model_id?: string,
 *     options?: Record<string, unknown>
 *   }
 *
 * Response: 202 with { job_id, status, model_id, provider }.
 *
 * Track B4 (Operator Studio).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createJob } from '@/lib/studio/generators';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const requestSchema = z.object({
  kind: z.enum(['image', 'video', 'audio']),
  prompt: z.string().min(1).max(8000),
  model_id: z.string().min(1).max(200).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof requestSchema>;
  try {
    const json = await req.json();
    parsed = requestSchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 }
    );
  }

  const job = await createJob({
    kind: parsed.kind,
    prompt: parsed.prompt,
    model_id: parsed.model_id ?? null,
    options: parsed.options ?? {},
  });

  return NextResponse.json(
    {
      job_id: job.id,
      status: job.status,
      model_id: job.model_id,
      provider: job.provider,
      created_at: job.created_at,
    },
    { status: 202 }
  );
}

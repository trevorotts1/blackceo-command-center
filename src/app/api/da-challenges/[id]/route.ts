import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne, run, timeNow } from '@/lib/db';
import type { DAChallenge } from '../route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PATCH /api/da-challenges/{id} — move a challenge through the four-state
 * lifecycle (pending | approved | rejected | escalated). This is the only
 * writer that can set 'escalated': the collection route's POST always inserts
 * 'pending'. It lives on the item path, NOT on /api/da-challenges, because that
 * collection path is bearer-only for writes (bearer-required-routes.ts) and the
 * browser feed has no bearer.
 *
 * approved / rejected are the resolved states and stamp resolved_at;
 * pending / escalated are open states and clear it.
 */
const UpdateStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'escalated']),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const parsed = UpdateStatusSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    if (!queryOne('SELECT id FROM da_challenges WHERE id = ?', [id])) {
      return NextResponse.json({ error: 'DA challenge not found' }, { status: 404 });
    }
    const { status } = parsed.data;
    const resolved = status === 'approved' || status === 'rejected';
    run('UPDATE da_challenges SET status = ?, resolved_at = ? WHERE id = ?', [
      status,
      resolved ? timeNow() : null,
      id,
    ]);
    const challenge = queryOne<DAChallenge>('SELECT * FROM da_challenges WHERE id = ?', [id]);
    return NextResponse.json({ challenge });
  } catch (error) {
    console.error('[PATCH /api/da-challenges/[id]]', error);
    return NextResponse.json({ error: 'Failed to update DA challenge' }, { status: 500 });
  }
}

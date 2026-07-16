import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { queryAll, queryOne, run, timeNow } from '@/lib/db';
import { resolveDepartment } from '@/lib/routing/resolve-department';

// Runtime route — opt out of static prerender (uses request data / DB).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Devil's Advocate challenges — U59 [JM/U55], decision D15 (D-J1).
 *
 * AUTH: none in this handler, deliberately. `src/middleware.ts` enforces
 * `Authorization: Bearer <MC_API_TOKEN>` globally for every /api/* path that is
 * not same-origin, and /api/da-challenges is NOT in WEBHOOK_SECRET_ROUTES, so
 * the plain bearer is the whole contract. Same convention as /api/bugs and
 * /api/campaigns, which likewise carry no auth code of their own.
 *
 * SHAPE: the canonical migration-020 table as reconciled by migration 024
 * (department_id + raw_response added; status moved to the PRD lifecycle per
 * D15 (ii)). The previous GET handler in this file targeted a shape
 * (department_id / challenge_text / response_text / response_deadline) that NO
 * migration has ever created — verified against the operator's live database
 * this pass, where the seed INSERT raises "no such column: department_id" and
 * the catch turns it into a 500. See migration 024's note for the full trail.
 */

export type DAChallengeStatus = 'pending' | 'approved' | 'rejected' | 'escalated';

export interface DAChallenge {
  id: string;
  task_id: string | null;
  campaign_id: string | null;
  department_id: string | null;
  trigger_type: string;
  challenge: string;
  specific_concern: string | null;
  assumptions: string | null;
  severity: 'low' | 'medium' | 'high' | null;
  confidence: number | null;
  raw_response: string | null;
  status: DAChallengeStatus;
  dismissal_reason: string | null;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * The WIRE-PAYLOAD CONTRACT, mirrored from the producer side:
 * `shared-utils/devils-advocate-bridge.py` (openclaw-onboarding), whose module
 * docstring states "the CC-side U55c route must accept exactly this field set;
 * a shape change here is a paired commit on both repos".
 */
const CreateDAChallengeSchema = z.object({
  trigger_type: z.string().min(1, 'trigger_type is required'),
  department: z.string(),
  challenge: z.string().min(1, 'challenge is required'),
  specific_concern: z.string().optional().default(''),
  assumptions: z.string().optional().default(''),
  severity: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  raw_response: z.string().optional().default(''),
  task_id: z.string().optional(),
});

export async function GET(): Promise<NextResponse> {
  try {
    // U55b (demo purge): the demo-seed block that used to live here is GONE,
    // not repaired. It injected three fabricated challenges ("Sales conversion
    // dropped 4% this week", ...) into a CLIENT-facing feed whenever the table
    // was empty. Fabricated board content is exactly what the demo-purge step
    // exists to remove, and an empty feed is the honest rendering of an empty
    // table. It also named columns that do not exist, so on a migrated box it
    // never seeded anything — it only produced the 500.
    const challenges = queryAll<DAChallenge>(
      'SELECT * FROM da_challenges ORDER BY created_at DESC',
    );
    return NextResponse.json({ challenges });
  } catch (error) {
    console.error('[GET /api/da-challenges]', error);
    return NextResponse.json({ error: 'Failed to fetch DA challenges' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const parsed = CreateDAChallengeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;

    // The bridge sends whatever department identifier its context JSON carried
    // (slug, name, or id). Resolve it to a real workspace id when we can. When
    // we cannot, keep the raw string rather than dropping it: a challenge must
    // never be silently lost because a slug did not match, and a NULL here
    // would strand the row off every department view with no trace of what the
    // producer meant. resolveDepartment() returns null on no-match AND on DB
    // error, and never throws.
    let departmentId: string | null = null;
    if (data.department) {
      const resolved = await resolveDepartment(data.department);
      departmentId = resolved ? resolved.id : data.department;
    }

    const id = uuidv4();
    const now = timeNow();

    run(
      `INSERT INTO da_challenges
         (id, task_id, campaign_id, department_id, trigger_type, challenge,
          specific_concern, assumptions, severity, confidence, raw_response,
          status, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        data.task_id ?? null,
        departmentId,
        data.trigger_type,
        data.challenge,
        data.specific_concern || null,
        data.assumptions || null,
        data.severity,
        data.confidence,
        data.raw_response || null,
        now,
      ],
    );

    const created = queryOne<DAChallenge>('SELECT * FROM da_challenges WHERE id = ?', [id]);

    return NextResponse.json({ challenge: created }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/da-challenges]', error);
    return NextResponse.json({ error: 'Failed to create DA challenge' }, { status: 500 });
  }
}

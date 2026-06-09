import { NextRequest, NextResponse } from 'next/server';
import { suggestSOPsForTask } from '@/lib/sops';
import { isEmbeddingAvailable } from '@/lib/sop-embeddings';

// Runtime route — opt out of static prerender (uses request data / DB).
export const dynamic = 'force-dynamic';

/**
 * GET /api/sops/suggest?department=X&task_title=Y&task_description=Z
 *
 * Returns top 3 SOPs by match score. When OPENAI_API_KEY is configured and
 * SOP embeddings exist in the DB this uses semantic (cosine) ranking blended
 * with keyword scoring. Without a key it falls back to the pure keyword path.
 *
 * Response includes `semantic_enabled: true/false` so callers can tell which
 * mode is active.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const department = searchParams.get('department');
    const taskTitle = searchParams.get('task_title') || '';
    const taskDescription = searchParams.get('task_description') || '';

    if (!taskTitle && !taskDescription && !department) {
      return NextResponse.json(
        { error: 'Provide at least one of: task_title, task_description, department' },
        { status: 400 }
      );
    }

    const suggestions = await suggestSOPsForTask(
      {
        title: taskTitle,
        description: taskDescription,
        department,
      },
      3
    );

    return NextResponse.json({
      semantic_enabled: isEmbeddingAvailable(),
      suggestions: suggestions.map((s) => ({
        sop: s.sop,
        score: Number(s.score.toFixed(3)),
        reasons: s.reasons,
      })),
    });
  } catch (error) {
    console.error('[GET /api/sops/suggest] Failed:', error);
    return NextResponse.json({ error: 'Failed to suggest SOPs' }, { status: 500 });
  }
}

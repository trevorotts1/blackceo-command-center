import { NextRequest, NextResponse } from 'next/server';
import { suggestSOPsForTask } from '@/lib/sops';

// Runtime route — opt out of static prerender (uses request data / DB).
export const dynamic = 'force-dynamic';

/**
 * GET /api/sops/suggest?department=X&task_title=Y&task_description=Z
 *
 * Returns top 3 SOPs by match score (department exact match + keyword overlap).
 * Used by the new-task dialog so operators see "suggested SOP" before saving.
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

    const suggestions = suggestSOPsForTask(
      {
        title: taskTitle,
        description: taskDescription,
        department,
      },
      3
    );

    return NextResponse.json({
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

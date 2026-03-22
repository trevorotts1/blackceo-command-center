import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

interface DAChallenge {
  id: string;
  department_id: string;
  challenge_text: string;
  response_text: string | null;
  status: 'open' | 'responded' | 'escalated';
  created_at: string;
  response_deadline: string | null;
  resolved_at: string | null;
}

const demoChallenges: Omit<DAChallenge, 'id' | 'created_at'>[] = [
  {
    department_id: 'sales-dept',
    challenge_text: 'Sales conversion dropped 4% this week. What is the root cause and what corrective action is planned?',
    response_text: null,
    status: 'open',
    response_deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    resolved_at: null,
  },
  {
    department_id: 'marketing-dept',
    challenge_text: 'Ad spend increased 20% but leads only grew 8%. Is the increased spend justified?',
    response_text: 'We tested 3 new ad formats. Results are preliminary. Will reassess in 7 days.',
    status: 'responded',
    response_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    resolved_at: null,
  },
  {
    department_id: 'operations-dept',
    challenge_text: '3 tasks have been in backlog for over 14 days. What is blocking completion?',
    response_text: null,
    status: 'escalated',
    response_deadline: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    resolved_at: null,
  },
];

export async function GET(): Promise<NextResponse> {
  try {
    // Check if table has any data
    const countResult = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM da_challenges'
    );
    
    // Seed demo data if empty
    if (!countResult || countResult.count === 0) {
      for (const challenge of demoChallenges) {
        run(
          `INSERT INTO da_challenges (id, department_id, challenge_text, response_text, status, created_at, response_deadline, resolved_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
          [
            uuidv4(),
            challenge.department_id,
            challenge.challenge_text,
            challenge.response_text,
            challenge.status,
            challenge.response_deadline,
            challenge.resolved_at,
          ]
        );
      }
    }
    
    // Fetch all challenges
    const challenges = queryAll<DAChallenge>(
      'SELECT * FROM da_challenges ORDER BY created_at DESC'
    );
    
    return NextResponse.json({ challenges });
  } catch (error) {
    console.error('Error fetching DA challenges:', error);
    return NextResponse.json(
      { error: 'Failed to fetch DA challenges' },
      { status: 500 }
    );
  }
}
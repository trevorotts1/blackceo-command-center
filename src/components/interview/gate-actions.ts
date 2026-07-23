'use server';

import { cookies } from 'next/headers';
import { readBuildState } from '@/lib/interview/seam';
import { INTERVIEW_COOKIE_NAME, INTERVIEW_BYPASS_COOKIE_NAME, signInterviewToken, signInterviewBypassToken } from '@/lib/interview/gate-cookie';

function deriveInterviewComplete(): boolean {
  const bs = readBuildState();
  if (!bs) return false;
  if (bs.buildCompletedAt) return true;
  if (bs.interviewComplete === true) return true;
  return false;
}

export async function refreshInterviewGate(): Promise<void> {
  const complete = deriveInterviewComplete();
  const { value, maxAge } = await signInterviewToken(complete);
  try { cookies().set(INTERVIEW_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge, secure: process.env.NODE_ENV === 'production' }); } catch { /* non-fatal */ }
}

export async function skipInterviewForNow(): Promise<void> {
  const { value, maxAge } = await signInterviewBypassToken();
  try { cookies().set(INTERVIEW_BYPASS_COOKIE_NAME, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge, secure: process.env.NODE_ENV === 'production' }); } catch { /* non-fatal */ }
}

import { redirect } from 'next/navigation';

/**
 * /onboarding/resume/[slug] - Nudge link redirect.
 *
 * The exact route the nudge worker builds (OPENCLAW_DASHBOARD_URL/onboarding/resume/<slug>).
 * Server component that redirects to /interview, which resumes at next_question_number
 * by reading the interview-handoff.md file.
 *
 * This route honors the nudge {link} contract without editing
 * shared-utils/nudge-incomplete-interviews.py.
 *
 * The slug parameter identifies the interview being resumed; the /interview page
 * reads the canonical handoff file to determine the resume position.
 *
 * Whitelisted by P0-5 middleware as part of /onboarding/* so it is reachable while
 * interview is incomplete.
 */
export default function ResumePage({ params }: { params: { slug: string } }) {
  // The slug identifies the interview session, but we redirect to /interview
  // which will handle reading the handoff and determining the resume position
  redirect('/interview');
}

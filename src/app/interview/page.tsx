/**
 * /interview — the AI Workforce Interview surface (P0-6 walking skeleton).
 *
 * A thin SERVER component that mounts the client experience. All of the
 * conversational + gate logic lives in InterviewClient (a client component)
 * because it talks to the browser-facing API routes:
 *
 *   • POST /api/interview/turn      — relays each owner message to the client's
 *                                     own Skill-23 agent over the local gateway.
 *   • GET  /api/interview/state     — progress rail + the three UI gate flags
 *                                     that arm the "Build my company" button.
 *   • POST /api/interview/complete  — the exact trigger the Telegram agent
 *                                     presses; on QC pass the client redirects
 *                                     to /onboarding/building.
 *
 * This route is intentionally ALWAYS reachable (the P0-5 middleware shell-lock
 * whitelists /interview so there is no redirect loop). Nothing here reads the
 * canonical files directly — the seam-backed API routes own that so the Edge/
 * Node boundary stays clean and this page can render before any state exists.
 *
 * P0 is the proof-of-wiring skeleton: consent → converse → gated build → redirect.
 * P1/P2 replace the conversational pane + progress rail with polished components
 * (QuestionCard, the department decision board) without changing this contract.
 */

import type { Metadata } from 'next';
import InterviewClient from './InterviewClient';

// The interview state changes per request (files are the source of truth); never
// statically cache this shell.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your AI Workforce Interview',
  description:
    'Answer a few questions in your own words and we will build your AI workforce.',
};

export default function InterviewPage() {
  return <InterviewClient />;
}

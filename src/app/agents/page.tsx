/**
 * /agents — Individual-agent performance board index (U58, Skill 6
 * Blended-Persona Kanban v2 Stage 2 / exec-summary item 9).
 *
 * The ceo-board "Agents" tab used to point at a dead route (see the
 * handleTabClick fix in src/app/ceo-board/page.tsx). This is that
 * destination: every real agent, linking to its own performance detail page.
 *
 * A thin SERVER component (no 'use client'): it calls
 * listPerformanceEligibleAgents() directly (the same trio-exclusion filter
 * the detail endpoint's lib uses — @/lib/agents/performance) rather than
 * fetching its own API, so the department-trio agents (qc / research /
 * devils-advocate — internal tooling, never real performers) never need a
 * second, client-side copy of the exclusion rule.
 */

import Link from 'next/link';
import { Header } from '@/components/Header';
import { listPerformanceEligibleAgents } from '@/lib/agents/performance';

// Agent roster changes over time; never statically cache this list.
export const dynamic = 'force-dynamic';

export default function AgentsIndexPage() {
  const agents = listPerformanceEligibleAgents();

  return (
    <div className="flex h-screen flex-col bg-bcc-bg">
      <Header />
      <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <div className="mx-auto w-full max-w-7xl space-y-6">
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Performance
            </p>
            <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">Agents</h1>
            <p className="mt-3 text-base text-gray-500 sm:text-lg">
              {agents.length} agent{agents.length === 1 ? '' : 's'} on the board. Each card links to
              a per-agent performance detail — completed tasks, average QC score, pass rate, and a
              weekly trend. Department QC / research / Devil&rsquo;s Advocate agents are internal
              tooling and are not shown here.
            </p>
          </section>

          {agents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
              No agents yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${encodeURIComponent(agent.id)}`}
                  className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white p-4 transition-all hover:border-indigo-300 hover:bg-indigo-50/40 hover:shadow-md"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl">
                    {agent.avatarEmoji}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-gray-900">
                      {agent.name}
                    </span>
                    <span className="block truncate text-xs text-gray-500">{agent.role}</span>
                  </span>
                  <span
                    className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      agent.status === 'working'
                        ? 'bg-emerald-50 text-emerald-700'
                        : agent.status === 'offline'
                          ? 'bg-gray-100 text-gray-500'
                          : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {agent.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

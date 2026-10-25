/**
 * PBB-327 / T-34 — the MOUNTED surface for bookings, failures and outcomes.
 *
 * Before this route existed, `src/components/ClientExceptionsOutcomes.tsx` and
 * the `bug_tickets` failure adapter had no consumer under `src/app/**`: the view
 * was unit-proven and unreachable at runtime. This server component is that
 * consumer — the real route, the real adapter, one tenant.
 *
 * Tenancy: `?client=<slug>` selects the client tag to read; without it the
 * workspace slug is used. `bug_tickets.client_slug` is a free-text tag written
 * by the bug reporter, so a ticket tagged for another client (or untagged) is
 * never shown here — cross-tenant dumps are not a client view.
 *
 * The bookings and outcomes producers (T-28 / T-30) are not on main, so those
 * two inputs are `null`: the view renders them as UNKNOWN with a reason, never
 * as an empty success.
 *
 * `ponytail:` tenant tag = workspace slug by default; when the client tag and
 * the workspace slug diverge, add a real tenant mapping table and read it here.
 */

import Link from 'next/link';
import ClientExceptionsOutcomes from '@/components/ClientExceptionsOutcomes';
import { buildExceptionsOutcomesView } from '@/lib/cc/exceptions-outcomes';
import { loadFailureAlerts } from '@/lib/cc/exceptions-outcomes-db';

export const dynamic = 'force-dynamic';

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function WorkspaceExceptionsPage(props: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await props.params;
  const search = (await props.searchParams) ?? {};
  const tenantSlug = firstParam(search.client) ?? slug;

  const view = buildExceptionsOutcomesView({
    tenantSlug,
    failures: loadFailureAlerts(tenantSlug),
    bookings: null,
    outcomes: null,
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <Link href={`/workspace/${slug}`} className="text-sm text-indigo-600 hover:underline">
        ← Back to {slug}
      </Link>
      <ClientExceptionsOutcomes view={view} />
    </main>
  );
}

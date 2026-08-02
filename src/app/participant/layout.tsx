import type { Metadata } from 'next';
import { PLATFORM_NAME } from './_lib/serialize';

/**
 * Layout for the public participant token page.
 *
 * The root layout mounts operator-only chrome (command palette, mobile nav,
 * walkthrough) as siblings of the page — a nested layout can't unmount those,
 * so this one renders a full-viewport, opaque, high-z surface that sits OVER
 * them. External co-author participants therefore see a clean, single-purpose
 * page and never any operator navigation. `z-50` clears the mobile nav bar
 * (`z-40`); the command palette only appears on Cmd+K and, if opened, would only
 * route to CF-Access/interview-gated operator pages that a participant can't
 * reach anyway.
 *
 * The title is the platform-neutral "Convert and Flow" (SPEC 11.5) — never a
 * client-identifying name — overriding the operator dashboard's tab title for
 * this subtree.
 *
 * Dark-mode activation is scoped to this subtree ONLY, via a client component
 * that adds/removes the `dark` class on <html> keyed to prefers-color-scheme.
 * The root layout (src/app/layout.tsx) is NEVER touched, so out-of-scope
 * dashboard pages remain in light mode regardless of OS preference.
 */

import { ParticipantDarkActivator } from './_lib/dark-activator';

export const metadata: Metadata = {
  title: PLATFORM_NAME,
  robots: { index: false, follow: false },
};

export default function ParticipantLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ParticipantDarkActivator />
      <div className="fixed inset-0 z-50 overflow-y-auto bg-bcc-bg text-bcc-text dark:bg-gray-950 dark:text-gray-100">{children}</div>
    </>
  );
}

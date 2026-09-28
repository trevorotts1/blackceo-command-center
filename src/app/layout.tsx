import type { Metadata, Viewport } from 'next';
import './globals.css';
import localFont from 'next/font/local';
import CommandPalette from '@/components/CommandPalette';
import MobileNav from '@/components/MobileNav';
import AppWalkthrough from '@/components/walkthrough/AppWalkthrough';
import BrandTheme from '@/components/BrandTheme';
import InterviewGateSync from '@/components/interview/InterviewGateSync';
import InterviewBypassBanner from '@/components/interview/InterviewBypassBanner';
import { loadCompanyConfig } from '@/lib/company-config';
// DemoBanner removed by Track A1 (Wave 1 cleanup). Top header + breadcrumbs
// handle navigation; AppShell sidebar import also retired.
// import AppShell from '@/components/AppShell';

// Fonts are vendored in ./fonts (latin subset, variable wght, SIL OFL 1.1 —
// see the *-OFL.txt files) instead of next/font/google. next/font/google
// downloads Google Fonts CSS at BUILD time; when that fetch hiccups the
// unattended daily rebuild crashes ("Cannot read properties of null (reading
// '1')") and rolls back. Local files make the build network-independent.
// Family names, CSS variables, weight ranges and display are unchanged.
// ponytail: latin subset only (same as the preloaded subset before); add
// other subsets as extra files if non-latin glyphs ever matter.
const inter = localFont({
  src: './fonts/Inter-latin-wght.woff2',
  variable: '--font-inter',
  weight: '400 900',
  style: 'normal',
  display: 'swap',
  declarations: [{ prop: 'font-family', value: 'Inter' }],
});

const jetbrainsMono = localFont({
  src: './fonts/JetBrainsMono-latin-wght.woff2',
  variable: '--font-jetbrains-mono',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  declarations: [{ prop: 'font-family', value: 'JetBrains Mono' }],
});

// Product name now reads from the configured company-config.json
// (commandCenterName) instead of a build-time env var, so a white-labeled
// deployment gets the right browser-tab title without a rebuild.
export async function generateMetadata(): Promise<Metadata> {
  const config = loadCompanyConfig();
  const title =
    config.commandCenterName ||
    (process.env.COMPANY_NAME ? `${process.env.COMPANY_NAME} Command Center` : 'Command Center');

  return {
    title,
    description: 'AI Agent Orchestration Dashboard',
    icons: {
      icon: '/favicon.svg',
    },
  };
}

// Next 14 moved viewport out of the Metadata object into its own export.
// maximumScale removed (v4.66.0): capping zoom at 1 blocked pinch-zoom on
// mobile, a WCAG 1.4.4 failure. Layouts must survive zoom, not forbid it.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      {/* min-h-dvh (not 100vh): on mobile Safari 100vh includes the space
          under the retractable URL bar, so “100vh” shells hid their last row
          of content behind browser chrome — the bottom-cutoff bug (v4.66.0). */}
      <body className={`${inter.className} bg-bcc-bg text-bcc-text min-h-dvh`}>
        {/* D2: per-client brand theme — re-themes brand-* utilities + --bcc-*
            variables from the selected client's primary color (BlackCEO green
            fallback). Mounted first so its :root vars are in the cascade. */}
        <BrandTheme />
        {/* P0-5: keeps the Edge-readable mc_interview_complete cookie warm so
            the middleware shell lock (WG-9) can gate the dashboard without
            reading fs/DB from the Edge runtime. Renders nothing. */}
        <InterviewGateSync />
        <InterviewBypassBanner />
        {/* pb-16 md:pb-0: reserves room for the fixed MobileNav bar below
            md so it never overlaps page content; no-op at md+ where
            MobileNav renders nothing. */}
        <div className="min-h-dvh pb-16 md:pb-0">{children}</div>
        <CommandPalette />
        {/* Mobile bottom nav (md:hidden) — replaces the retired AppShell
            sidebar's navigation affordance on phones. */}
        <MobileNav />
        {/* App-wide interactive walkthrough; mounts once and selects the deck
            for the current route (B3). */}
        <AppWalkthrough />
      </body>
    </html>
  );
}

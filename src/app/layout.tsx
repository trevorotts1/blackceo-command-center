import type { Metadata } from 'next';
import './globals.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import CommandPalette from '@/components/CommandPalette';
import AppWalkthrough from '@/components/walkthrough/AppWalkthrough';
import BrandTheme from '@/components/BrandTheme';
import InterviewGateSync from '@/components/interview/InterviewGateSync';
// DemoBanner removed by Track A1 (Wave 1 cleanup). Top header + breadcrumbs
// handle navigation; AppShell sidebar import also retired.
// import AppShell from '@/components/AppShell';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700', '800', '900'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: process.env.COMPANY_NAME ? `${process.env.COMPANY_NAME} Command Center` : 'Command Center',
  description: 'AI Agent Orchestration Dashboard',
  icons: {
    icon: '/favicon.svg',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className={`${inter.className} bg-bcc-bg text-bcc-text min-h-screen`}>
        {/* D2: per-client brand theme — re-themes brand-* utilities + --bcc-*
            variables from the selected client's primary color (BlackCEO green
            fallback). Mounted first so its :root vars are in the cascade. */}
        <BrandTheme />
        {/* P0-5: keeps the Edge-readable mc_interview_complete cookie warm so
            the middleware shell lock (WG-9) can gate the dashboard without
            reading fs/DB from the Edge runtime. Renders nothing. */}
        <InterviewGateSync />
        {children}
        <CommandPalette />
        {/* App-wide interactive walkthrough; mounts once and selects the deck
            for the current route (B3). */}
        <AppWalkthrough />
      </body>
    </html>
  );
}

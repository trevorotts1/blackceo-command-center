import type { Metadata } from 'next';
import './globals.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import CommandPalette from '@/components/CommandPalette';
import AppWalkthrough from '@/components/walkthrough/AppWalkthrough';
import BrandTheme from '@/components/BrandTheme';
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
  // openGraph.siteName emits <meta property="og:site_name" content="COMPANY_NAME" />
  // into the served HTML.  cc-health-check.sh (B.1 Check 3) uses this to extract the
  // company name from HTML without string-mangling the title suffix.
  ...(process.env.COMPANY_NAME
    ? { openGraph: { siteName: process.env.COMPANY_NAME } }
    : {}),
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
        {children}
        <CommandPalette />
        {/* App-wide interactive walkthrough; mounts once and selects the deck
            for the current route (B3). */}
        <AppWalkthrough />
      </body>
    </html>
  );
}

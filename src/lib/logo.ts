/**
 * Logo Configuration
 *
 * Priority order (resolved at runtime by useLogoUrl hook):
 * 1. logo-config.json in public/ (set via the /api/logo endpoint)
 * 2. NEXT_PUBLIC_LOGO_URL environment variable
 * 3. Generic "BLACKCEO COMMAND CENTER" text placeholder (no image)
 */

// Generic fallback logo (text-based SVG, no image required)
export const FALLBACK_LOGO = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 60" fill="none">
  <text x="0" y="44" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#1e293b" letter-spacing="1">BLACKCEO COMMAND CENTER</text>
</svg>
`)}`;

/**
 * Get the baseline logo URL (env var or fallback).
 * This is client-safe and does NOT read from the filesystem.
 * Use the useLogoUrl() hook in components for the full priority chain.
 */
export function getLogoUrl(): string {
  return process.env.NEXT_PUBLIC_LOGO_URL || FALLBACK_LOGO;
}

/**
 * Logo configuration for the application.
 * Include alt text and default dimensions.
 *
 * Note: .url reflects the env var / fallback.
 * In components, prefer useLogoUrl() to also pick up logo-config.json.
 */
export const LogoConfig = {
  url: getLogoUrl(),
  alt: 'Command Center',
  defaultHeight: 40,
} as const;

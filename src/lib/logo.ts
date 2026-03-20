/**
 * Logo Configuration
 * 
 * Provides a configurable logo URL via environment variable.
 * Clients can set their own logo by setting NEXT_PUBLIC_LOGO_URL.
 */

// Generic fallback logo (simple building icon as SVG data URI)
const FALLBACK_LOGO = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 21h18"/>
  <path d="M5 21V7l8-4 8 4v14"/>
  <path d="M9 21v-6h6v6"/>
</svg>
`)}`;

/**
 * Get the configured logo URL.
 * Uses NEXT_PUBLIC_LOGO_URL env var if set, otherwise returns a generic fallback.
 */
export function getLogoUrl(): string {
  return process.env.NEXT_PUBLIC_LOGO_URL || FALLBACK_LOGO;
}

/**
 * Logo configuration for the application.
 * Include alt text and default dimensions.
 */
export const LogoConfig = {
  url: getLogoUrl(),
  alt: 'Command Center',
  defaultHeight: 40,
} as const;

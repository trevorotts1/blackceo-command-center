/**
 * Per-client branding helpers (D1–D3).
 *
 * D1  resolveBrandColor()  — the AI Workforce interview asks the client for
 *     their brand colors as HEX codes; if they don't know the hex it accepts a
 *     color NAME ("forest green", "navy", "coral") and resolves it to hex
 *     automatically via the COLOR_NAME_MAP below.
 *
 * D2  Theming is driven from the single stored primary color via
 *     src/lib/colors.ts derivePaletteFromPrimary() + the runtime CSS-variable
 *     overrides emitted by <BrandTheme/> (src/components/BrandTheme.tsx).
 *
 * D3  uploadLogoToGhlMediaLibrary() — uploads a client logo to that client's
 *     GoHighLevel ("Convert and Flow") media library using the documented
 *     endpoint and returns the hosted URL GHL gives back.
 *
 * The BlackCEO brand green is the universal fallback when a client has no
 * brand color of their own.
 */

import { derivePaletteFromPrimary, type BrandScale } from '@/lib/colors';

/** BlackCEO Command Center default primary (brand-600). Used as the fallback. */
export const BLACKCEO_GREEN = '#43A047';

/* ------------------------------------------------------------------ *
 * D1 — color name → hex resolution
 * ------------------------------------------------------------------ */

/**
 * Name → hex map. Covers the CSS named colors plus the everyday descriptive
 * names clients actually say in an interview ("navy", "forest green",
 * "burgundy", "teal", "charcoal", ...). Keys are normalized (lowercased,
 * spaces/dashes stripped) by `resolveBrandColor`.
 */
export const COLOR_NAME_MAP: Record<string, string> = {
  // neutrals
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  charcoal: '#36454f',
  slate: '#475569',
  silver: '#c0c0c0',
  // reds
  red: '#ef4444',
  crimson: '#dc143c',
  maroon: '#800000',
  burgundy: '#800020',
  scarlet: '#ff2400',
  brick: '#b22222',
  rose: '#f43f5e',
  // pinks
  pink: '#ec4899',
  magenta: '#d946ef',
  fuchsia: '#d946ef',
  coral: '#ff7f50',
  salmon: '#fa8072',
  // oranges / browns
  orange: '#f97316',
  amber: '#f59e0b',
  tangerine: '#f28500',
  brown: '#8b4513',
  tan: '#d2b48c',
  beige: '#f5f5dc',
  bronze: '#cd7f32',
  // yellows / golds
  yellow: '#eab308',
  gold: '#d4af37',
  mustard: '#e1ad01',
  // greens
  green: '#22c55e',
  forestgreen: '#228b22',
  forest: '#228b22',
  emerald: '#10b981',
  lime: '#84cc16',
  olive: '#808000',
  mint: '#3eb489',
  sage: '#9caf88',
  teal: '#14b8a6',
  jade: '#00a86b',
  // blues
  blue: '#3b82f6',
  navy: '#1e3a8a',
  navyblue: '#1e3a8a',
  royalblue: '#4169e1',
  royal: '#4169e1',
  sky: '#0ea5e9',
  skyblue: '#0ea5e9',
  cyan: '#06b6d4',
  azure: '#007fff',
  cobalt: '#0047ab',
  indigo: '#4f46e5',
  // purples
  purple: '#a855f7',
  violet: '#8b5cf6',
  lavender: '#b57edc',
  plum: '#8e4585',
  // brand-ish
  blackceogreen: BLACKCEO_GREEN,
};

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize a hex string to `#rrggbb` lowercase, expanding #rgb. Null if bad. */
export function normalizeHex(input: string): string | null {
  const m = input.trim().match(HEX_RE);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return `#${h}`;
}

export interface BrandColorResolution {
  /** Resolved #rrggbb hex, or null when the input could not be understood. */
  hex: string | null;
  /** How it resolved — for transparency in the interview UI. */
  source: 'hex' | 'name' | 'unknown';
  /** The normalized lookup key (for names) or the raw input. */
  matched: string;
}

/**
 * D1: resolve a brand-color answer that is EITHER a hex code OR a color name.
 * - "#1e3a8a" / "1e3a8a" / "#39f"  → treated as hex.
 * - "navy" / "Forest Green" / "royal-blue" → looked up in COLOR_NAME_MAP.
 * Returns hex=null when neither matches (caller can re-prompt or fall back).
 */
export function resolveBrandColor(input: string): BrandColorResolution {
  const raw = (input ?? '').trim();
  if (!raw) return { hex: null, source: 'unknown', matched: raw };

  // 1. Hex first.
  const hex = normalizeHex(raw);
  if (hex) return { hex, source: 'hex', matched: raw };

  // 2. Name lookup (strip spaces/dashes/underscores, lowercase).
  const key = raw.toLowerCase().replace(/[\s\-_]+/g, '');
  if (COLOR_NAME_MAP[key]) {
    return { hex: COLOR_NAME_MAP[key], source: 'name', matched: key };
  }

  return { hex: null, source: 'unknown', matched: key };
}

/* ------------------------------------------------------------------ *
 * D2 — CSS-variable payload for the whole-app re-theme
 * ------------------------------------------------------------------ */

/**
 * Build the CSS custom-property map that re-themes the Command Center from a
 * single primary color. Drives both the `--bcc-primary*` variables (used in
 * globals.css) and a `--brand-50..950` scale that the runtime overrides map the
 * Tailwind `brand-*` utilities onto. Pass `null` to get the BlackCEO defaults.
 */
export function buildThemeVars(primary: string | null): Record<string, string> {
  const base = primary && normalizeHex(primary) ? normalizeHex(primary)! : BLACKCEO_GREEN;
  const palette = derivePaletteFromPrimary(base);
  const s: BrandScale = palette.scale;
  return {
    '--bcc-primary': palette.primaryColor!,
    '--bcc-primary-hover': palette.primaryDark!,
    '--bcc-primary-light': s[50],
    '--bcc-secondary': palette.secondaryColor!,
    '--bcc-accent': palette.accent!,
    '--brand-50': s[50],
    '--brand-100': s[100],
    '--brand-200': s[200],
    '--brand-300': s[300],
    '--brand-400': s[400],
    '--brand-500': s[500],
    '--brand-600': s[600],
    '--brand-700': s[700],
    '--brand-800': s[800],
    '--brand-900': s[900],
    '--brand-950': s[950],
  };
}

/* ------------------------------------------------------------------ *
 * D3 — GoHighLevel media-library upload
 * ------------------------------------------------------------------ */

export interface GhlUploadResult {
  ok: boolean;
  /** Hosted URL GHL returns (storage.googleapis.com/msgsndr/...). */
  url?: string;
  fileId?: string;
  /** True when we skipped the upload because the logo is already a GHL URL. */
  alreadyHosted?: boolean;
  error?: string;
}

/** A logo URL that already lives in GHL media storage needs no re-upload. */
export function isGhlHostedUrl(url: string): boolean {
  return /storage\.googleapis\.com\/msgsndr\//i.test(url) || /\.leadconnectorhq\.com\//i.test(url);
}

/**
 * D3: upload a client logo to the client's GoHighLevel (Convert and Flow) media
 * library, returning the hosted URL.
 *
 * Endpoint (per TOOLS.md → Convert and Flow (GHL) → Media upload):
 *   POST https://services.leadconnectorhq.com/medias/upload-file
 *   Headers: Authorization: Bearer <Location PIT>, Version: 2021-07-28
 *   Body: multipart/form-data with `file`
 *   Response: { fileId, url }
 *
 * The Location PIT lives in `GOHIGHLEVEL_API_KEY` (a PIT despite the legacy
 * name — TOOLS.md is explicit: media uploads REQUIRE the Location PIT; the
 * Agency PIT returns 401). Skips the upload when the logo is already a GHL URL.
 */
export async function uploadLogoToGhlMediaLibrary(
  logoUrl: string,
  opts?: { locationId?: string; folderId?: string },
): Promise<GhlUploadResult> {
  if (isGhlHostedUrl(logoUrl)) {
    return { ok: true, url: logoUrl, alreadyHosted: true };
  }

  const pit = process.env.GOHIGHLEVEL_API_KEY; // Location PIT (legacy var name)
  if (!pit) {
    return {
      ok: false,
      error:
        'GOHIGHLEVEL_API_KEY (Location PIT) is not set — cannot upload to the GHL media library.',
    };
  }
  const locationId = opts?.locationId || process.env.GOHIGHLEVEL_LOCATION_ID || undefined;

  // Fetch the source image so we can re-upload its bytes to GHL.
  let blob: Blob;
  let filename = 'logo';
  try {
    const src = await fetch(logoUrl);
    if (!src.ok) {
      return { ok: false, error: `Could not fetch the logo (status ${src.status}).` };
    }
    blob = await src.blob();
    const last = new URL(logoUrl).pathname.split('/').pop();
    if (last) filename = last;
  } catch (e) {
    return { ok: false, error: `Could not fetch the logo: ${(e as Error).message}` };
  }

  const form = new FormData();
  form.append('file', blob, filename);
  if (locationId) form.append('locationId', locationId);
  if (opts?.folderId) form.append('folderId', opts.folderId);

  try {
    const res = await fetch('https://services.leadconnectorhq.com/medias/upload-file', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: '2021-07-28',
        // NOTE: do not set Content-Type — fetch sets the multipart boundary.
      },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `GHL upload failed (status ${res.status}): ${text.slice(0, 300)}` };
    }
    let data: { url?: string; fileId?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON success body — fall through */
    }
    return { ok: true, url: data.url || logoUrl, fileId: data.fileId };
  } catch (e) {
    return { ok: false, error: `GHL upload request failed: ${(e as Error).message}` };
  }
}

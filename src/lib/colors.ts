/**
 * Color utility functions for generating palettes from hex colors.
 * Uses HSL color space for perceptually uniform adjustments.
 */

interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

/** Parse a hex color string (#RGB or #RRGGBB) into HSL. */
export function hexToHsl(hex: string): HSL {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) {
      h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
      h = ((b - r) / delta + 2) / 6;
    } else {
      h = ((r - g) / delta + 4) / 6;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

/** Convert HSL back to a hex color string. */
export function hslToHex(h: number, s: number, l: number): string {
  const hNorm = ((h % 360) + 360) % 360; // wrap negative hues
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const lNorm = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((hNorm / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0,
    g = 0,
    b = 0;

  if (hNorm < 60) {
    r = c; g = x;
  } else if (hNorm < 120) {
    r = x; g = c;
  } else if (hNorm < 180) {
    g = c; b = x;
  } else if (hNorm < 240) {
    g = x; b = c;
  } else if (hNorm < 300) {
    r = x; b = c;
  } else {
    r = c; b = x;
  }

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Lighten a hex color by a percentage (default 20%). */
export function lighten(hex: string, amount = 20): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, l + amount);
}

/** Darken a hex color by a percentage (default 20%). */
export function darken(hex: string, amount = 20): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, l - amount);
}

/** Get the complementary color (opposite on the color wheel). */
export function complementary(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + 180, s, l);
}

/** Rotate the hue by `deg` degrees, keeping saturation + lightness. */
export function rotateHue(hex: string, deg: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + deg, s, l);
}

/**
 * Full Tailwind-style 50→950 brand scale derived from ONE primary color (D2).
 * Anchors the supplied primary at the 600 step (matches the historical BlackCEO
 * #43A047 = brand-600) and walks lightness up/down for the lighter/darker steps,
 * so a client's primary slots in exactly where the hardcoded green used to live.
 */
export interface BrandScale {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
  950: string;
}

export function brandScaleFromPrimary(primary: string): BrandScale {
  const { h, s } = hexToHsl(primary);
  // Target lightness per step (tuned to mirror the original green scale spread).
  const L: Record<keyof BrandScale, number> = {
    50: 95,
    100: 88,
    200: 78,
    300: 66,
    400: 56,
    500: 48,
    600: 42,
    700: 35,
    800: 28,
    900: 20,
    950: 12,
  };
  const at = (l: number) => hslToHex(h, s, l);
  return {
    50: at(L[50]),
    100: at(L[100]),
    200: at(L[200]),
    300: at(L[300]),
    400: at(L[400]),
    500: at(L[500]),
    600: at(L[600]),
    700: at(L[700]),
    800: at(L[800]),
    900: at(L[900]),
    950: at(L[950]),
  };
}

/**
 * Auto-derived palette from a SINGLE primary brand color (D2). Produces the
 * complementary + analogous accents the UI needs without requiring a second
 * color from the client. `secondary` is the analogous (+30°) shade used for
 * gradients; `accent` is the true complement (+180°).
 */
export interface DerivedPalette extends BrandPalette {
  scale: BrandScale;
}

export function derivePaletteFromPrimary(primary: string): DerivedPalette {
  const secondary = rotateHue(primary, 30); // analogous
  const accent = complementary(primary); // +180°
  return {
    primaryColor: primary,
    secondaryColor: secondary,
    primaryLight: lighten(primary),
    primaryDark: darken(primary),
    secondaryLight: lighten(secondary),
    secondaryDark: darken(secondary),
    accent,
    accentLight: lighten(accent),
    scale: brandScaleFromPrimary(primary),
  };
}

export interface BrandPalette {
  primaryColor: string | null;
  secondaryColor: string | null;
  primaryLight: string | null;
  primaryDark: string | null;
  secondaryLight: string | null;
  secondaryDark: string | null;
  accent: string | null;
  accentLight: string | null;
}

/**
 * Generate a full palette from primary and secondary hex colors.
 * Returns null-safe partial when colors are missing.
 */
export function generatePalette(
  primary: string | null,
  secondary: string | null,
): BrandPalette | null {
  if (!primary || !secondary) return null;
  const accent = complementary(primary);
  return {
    primaryColor: primary,
    secondaryColor: secondary,
    primaryLight: lighten(primary),
    primaryDark: darken(primary),
    secondaryLight: lighten(secondary),
    secondaryDark: darken(secondary),
    accent,
    accentLight: lighten(accent),
  };
}

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

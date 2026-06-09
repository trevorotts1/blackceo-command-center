import { getClientContext } from '@/lib/clients';
import { buildThemeVars, BLACKCEO_GREEN } from '@/lib/branding';

/**
 * BrandTheme (D2) — re-themes the entire Command Center from the SELECTED
 * client's primary brand color, with an auto-derived complementary/analogous
 * palette. Falls back to the BlackCEO green (#43A047) when the client has no
 * brand color set.
 *
 * HOW IT RE-THEMES THE WHOLE UI:
 *   1. Emits the brand palette as CSS custom properties on :root (drives the
 *      `--bcc-primary*` variables already used in globals.css).
 *   2. Remaps the heavily-used Tailwind `brand-*` utility classes
 *      (bg/text/border/ring/from/to + brand-50..950) onto those same variables
 *      with a small, build-safe `<style>` block. Because the utilities now
 *      resolve to the client's palette, every component that already uses
 *      `bg-brand-600`, `text-brand-700`, gradients, etc. re-themes with no
 *      per-component edits.
 *
 * Server component: reads the tenant record directly via getClientContext().
 * Rendered once in the root layout. When no brand color is set the emitted
 * values equal the original BlackCEO scale, so the look is unchanged.
 */
export default function BrandTheme() {
  let primary: string | null = null;
  let secondary: string | null = null;
  try {
    const ctx = getClientContext();
    primary = ctx?.brand_color ?? null;
    secondary = ctx?.brand_secondary_color ?? null;
  } catch {
    primary = null;
    secondary = null;
  }

  const vars = buildThemeVars(primary ?? BLACKCEO_GREEN, secondary);

  const rootVars = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');

  // Map the Tailwind brand-* utilities onto the emitted --brand-* variables.
  const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const overrides = steps
    .map((n) => {
      const v = `var(--brand-${n})`;
      const sv = `var(--brand-secondary-${n})`;
      return [
        // Primary brand utilities
        `.bg-brand-${n}{background-color:${v} !important;}`,
        `.text-brand-${n}{color:${v} !important;}`,
        `.border-brand-${n}{border-color:${v} !important;}`,
        `.ring-brand-${n}{--tw-ring-color:${v} !important;}`,
        `.from-brand-${n}{--tw-gradient-from:${v} !important;--tw-gradient-to:rgb(255 255 255 / 0) !important;--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to) !important;}`,
        `.to-brand-${n}{--tw-gradient-to:${v} !important;}`,
        `.via-brand-${n}{--tw-gradient-stops:var(--tw-gradient-from),${v},var(--tw-gradient-to) !important;}`,
        `.hover\\:bg-brand-${n}:hover{background-color:${v} !important;}`,
        `.hover\\:text-brand-${n}:hover{color:${v} !important;}`,
        `.hover\\:border-brand-${n}:hover{border-color:${v} !important;}`,
        `.focus\\:ring-brand-${n}:focus{--tw-ring-color:${v} !important;}`,
        `.focus\\:border-brand-${n}:focus{border-color:${v} !important;}`,
        // Secondary brand utilities (brand-secondary-*)
        `.bg-brand-secondary-${n}{background-color:${sv} !important;}`,
        `.text-brand-secondary-${n}{color:${sv} !important;}`,
        `.border-brand-secondary-${n}{border-color:${sv} !important;}`,
        `.ring-brand-secondary-${n}{--tw-ring-color:${sv} !important;}`,
        `.from-brand-secondary-${n}{--tw-gradient-from:${sv} !important;--tw-gradient-to:rgb(255 255 255 / 0) !important;--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to) !important;}`,
        `.to-brand-secondary-${n}{--tw-gradient-to:${sv} !important;}`,
        `.hover\\:bg-brand-secondary-${n}:hover{background-color:${sv} !important;}`,
        `.hover\\:text-brand-secondary-${n}:hover{color:${sv} !important;}`,
      ].join('');
    })
    .join('');

  const css = `:root{${rootVars}}${overrides}`;

  // eslint-disable-next-line react/no-danger
  return <style id="bcc-brand-theme" dangerouslySetInnerHTML={{ __html: css }} />;
}

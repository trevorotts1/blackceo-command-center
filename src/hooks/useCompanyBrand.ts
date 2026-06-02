'use client';

import { useState, useEffect } from 'react';
import { BrandPalette, generatePalette, derivePaletteFromPrimary } from '@/lib/colors';

export type CompanyBrand = BrandPalette;

/**
 * useCompanyBrand
 *
 * Resolves the active brand palette, preferring the SELECTED client's primary
 * brand color (D1/D2) and falling back to the company record's brand colors.
 *
 * Priority:
 *   1. Selected client's brand_color (/api/clients) → derive full palette from
 *      that single primary (complementary + analogous).
 *   2. Company record primary (+ optional secondary) (/api/company).
 *   3. All-null palette when nothing is configured (callers fall back to green).
 */
export function useCompanyBrand(): CompanyBrand {
  const [brand, setBrand] = useState<CompanyBrand>({
    primaryColor: null,
    secondaryColor: null,
    primaryLight: null,
    primaryDark: null,
    secondaryLight: null,
    secondaryDark: null,
    accent: null,
    accentLight: null,
  });

  useEffect(() => {
    let cancelled = false;

    const fromClient = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/clients', { cache: 'no-store' });
        if (!res.ok) return false;
        const data = await res.json();
        const selectedId: string | null =
          (typeof data.selected_id === 'string' ? data.selected_id : null) ?? null;
        const list: Array<{ id: string; is_self: boolean; brand_color?: string | null }> =
          Array.isArray(data.clients) ? data.clients : [];
        const selected =
          list.find((c) => c.id === selectedId) ?? list.find((c) => c.is_self) ?? list[0];
        const primary = selected?.brand_color ?? null;
        if (primary) {
          if (!cancelled) setBrand(derivePaletteFromPrimary(primary));
          return true;
        }
      } catch {
        /* fall through to company */
      }
      return false;
    };

    const fromCompany = async () => {
      try {
        const res = await fetch('/api/company', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data) return;
        const primaryColor =
          data.primaryColor ?? data.primary_color ?? data.config?.brand?.primaryColor ?? null;
        const secondaryColor =
          data.secondaryColor ?? data.secondary_color ?? data.config?.brand?.secondaryColor ?? null;
        // Prefer a full palette from primary alone when no secondary is given.
        const palette = secondaryColor
          ? generatePalette(primaryColor, secondaryColor)
          : primaryColor
            ? derivePaletteFromPrimary(primaryColor)
            : null;
        if (palette && !cancelled) setBrand(palette);
      } catch {
        /* keep null palette */
      }
    };

    (async () => {
      const got = await fromClient();
      if (!got) await fromCompany();
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return brand;
}

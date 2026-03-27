'use client';

import { useState, useEffect } from 'react';
import { BrandPalette, generatePalette } from '@/lib/colors';

export type CompanyBrand = BrandPalette;

/**
 * useCompanyBrand
 *
 * Fetches the company record and extracts brand colors.
 * Generates a full palette (light/dark/accent variants) from primary + secondary.
 * All palette fields are null when brand colors are not configured.
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
    fetch('/api/company', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          const primaryColor =
            data.primaryColor ?? data.primary_color ?? data.config?.brand?.primaryColor ?? null;
          const secondaryColor =
            data.secondaryColor ?? data.secondary_color ?? data.config?.brand?.secondaryColor ?? null;

          const palette = generatePalette(primaryColor, secondaryColor);
          if (palette) {
            setBrand(palette);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return brand;
}

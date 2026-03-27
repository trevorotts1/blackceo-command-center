'use client';

import { useState, useEffect } from 'react';

export interface CompanyBrand {
  primaryColor: string | null;
  secondaryColor: string | null;
}

/**
 * useCompanyBrand
 *
 * Fetches the company record and extracts brand colors.
 * Returns { primaryColor, secondaryColor } — both null if not configured.
 * Brand colors can live at top-level fields or inside config.brand.primaryColor / config.brand.secondaryColor.
 */
export function useCompanyBrand(): CompanyBrand {
  const [brand, setBrand] = useState<CompanyBrand>({ primaryColor: null, secondaryColor: null });

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
          setBrand({
            primaryColor: primaryColor || null,
            secondaryColor: secondaryColor || null,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return brand;
}

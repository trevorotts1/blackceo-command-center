'use client';

import { useState, useEffect } from 'react';
import { getLogoUrl } from '@/lib/logo';

/**
 * useLogoUrl
 *
 * Returns the best available logo URL with this priority:
 * 1. URL saved in public/logo-config.json (set via /api/logo)
 * 2. NEXT_PUBLIC_LOGO_URL environment variable
 * 3. Generic "BLACKCEO COMMAND CENTER" text placeholder
 *
 * Falls back immediately to the env/default while the JSON file loads.
 */
export function useLogoUrl(): string {
  const [logoUrl, setLogoUrl] = useState<string>(getLogoUrl());

  useEffect(() => {
    let cancelled = false;
    fetch('/logo-config.json', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) return null;
        return res.json() as Promise<{ logoUrl?: string }>;
      })
      .then((data) => {
        if (!cancelled && data?.logoUrl && typeof data.logoUrl === 'string') {
          setLogoUrl(data.logoUrl);
        }
      })
      .catch(() => {
        // No config file — keep the default
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return logoUrl;
}

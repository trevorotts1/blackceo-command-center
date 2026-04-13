import { NextResponse } from 'next/server';
import { loadCompanyConfig, invalidateCompanyConfigCache } from '@/lib/company-config';

/**
 * GET /api/company/config
 * Returns the company configuration from company-config.json.
 * Used by the CEO Board to determine KPIs, benchmarks, weights, and company name.
 */
export async function GET() {
  try {
    invalidateCompanyConfigCache(); // Always read fresh for API calls
    const config = loadCompanyConfig();
    return NextResponse.json(config);
  } catch (error) {
    console.error('GET /api/company/config error:', error);
    return NextResponse.json(
      { error: 'Failed to load company config' },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { loadCompanyConfig, invalidateCompanyConfigCache } from '@/lib/company-config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

/**
 * POST /api/company/config
 *
 * Writes the editable subset of company-config.json (Bug 5, v4.0.2). The
 * /settings/company form posts:
 *   { companyName, commandCenterName, industry, logoUrl, brandPrimaryColor }
 *
 * Merges into the existing file (preserves KPIs, departments, weights),
 * writes atomically (temp + rename), invalidates the in-process cache.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: Record<string, unknown> = {};
    const allowedStrings = ['companyName', 'commandCenterName', 'industry', 'logoUrl', 'brandPrimaryColor', 'brandSecondaryColor'];
    for (const key of allowedStrings) {
      if (typeof body?.[key] === 'string') {
        updates[key] = body[key];
      }
    }

    const configPath = path.join(process.cwd(), 'config', 'company-config.json');
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch (err) {
      console.warn('POST /api/company/config: existing file unreadable, starting fresh', err);
    }

    const merged = { ...existing, ...updates };

    // Atomic write via temp file
    const tmp = `${configPath}.tmp`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath);

    invalidateCompanyConfigCache();

    return NextResponse.json({ ok: true, config: merged });
  } catch (error) {
    console.error('POST /api/company/config error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save company config' },
      { status: 500 }
    );
  }
}

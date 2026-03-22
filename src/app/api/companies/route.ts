import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { Company } from '@/lib/types';

// GET /api/companies - List all companies with workspace counts
export async function GET() {
  try {
    const db = getDb();

    const companies = db.prepare(`
      SELECT c.*, COUNT(w.id) as workspace_count
      FROM companies c
      LEFT JOIN workspaces w ON w.company_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all() as (Company & { workspace_count: number })[];

    return NextResponse.json(companies);
  } catch (error) {
    console.error('Failed to fetch companies:', error);
    return NextResponse.json({ error: 'Failed to fetch companies' }, { status: 500 });
  }
}

// POST /api/companies - Create a new company
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, slug, industry, logo_url, config } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!slug || typeof slug !== 'string' || slug.trim().length === 0) {
      return NextResponse.json({ error: 'Slug is required' }, { status: 400 });
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const finalSlug = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Check if slug already exists
    const existing = db.prepare('SELECT id FROM companies WHERE slug = ?').get(finalSlug);
    if (existing) {
      return NextResponse.json({ error: 'A company with this slug already exists' }, { status: 400 });
    }

    db.prepare(`
      INSERT INTO companies (id, name, slug, industry, logo_url, config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name.trim(), finalSlug, industry || null, logo_url || null, JSON.stringify(config || {}));

    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    return NextResponse.json(company, { status: 201 });
  } catch (error) {
    console.error('Failed to create company:', error);
    return NextResponse.json({ error: 'Failed to create company' }, { status: 500 });
  }
}

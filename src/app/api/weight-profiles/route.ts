import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function getProfilesPath(): string {
  const explicitRoot = process.env.OPENCLAW_ROOT;
  if (explicitRoot) {
    return path.join(explicitRoot, 'workspace', 'weight-profiles.json');
  }
  // VPS default
  if (fs.existsSync('/data/.openclaw')) {
    return '/data/.openclaw/workspace/weight-profiles.json';
  }
  // Mac default
  return path.join(os.homedir(), '.openclaw', 'workspace', 'weight-profiles.json');
}

export async function GET() {
  const fp = getProfilesPath();
  if (!fs.existsSync(fp)) {
    return NextResponse.json({ profiles: {} });
  }
  try {
    const profiles = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return NextResponse.json({ profiles });
  } catch (e) {
    return NextResponse.json({ profiles: {}, error: 'failed to parse weight-profiles.json' });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const fp = getProfilesPath();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(body, null, 2));
  return NextResponse.json({ success: true, path: fp });
}

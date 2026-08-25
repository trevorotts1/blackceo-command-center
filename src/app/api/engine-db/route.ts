/**
 * GET /api/engine-db — server-only read of which producer-engine databases are
 * present on this box. Returns a JSON object mapping engine slug → boolean
 * (true = DB file exists and is openable, false = absent or unreadable).
 *
 * U018: the dashboard page is a `'use client'` component and cannot import
 * `getPodcastReadDb()` directly (it pulls in `fs` / `better-sqlite3`). This
 * tiny same-origin endpoint bridges that gap so the dashboard can gate
 * producer cards on engine-DB presence without server-side imports leaking
 * into the client bundle.
 *
 * Same-origin passthrough only (middleware.ts session gate); never a public
 * endpoint. Fail-soft: a read error for one engine returns false for that
 * engine, never 500s the whole response.
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getPodcastReadDb } from '@/lib/podcast/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const engines: Record<string, boolean> = {};

  // podcast engine DB
  try {
    engines.podcast = getPodcastReadDb() !== null;
  } catch {
    engines.podcast = false;
  }

  // anthology: probe the engine state DB path. Resolution mirrors
  // anthology_state.py default_state_dir(): trim each env value (whitespace-
  // only counts as absent), expand a leading ~, then ANTHOLOGY_STATE_DIR →
  // OPENCLAW_DATA_DIR/anthology-engine/state → $HOME/.anthology-engine/state.
  try {
    const home = process.env.HOME || os.homedir();
    const untilde = (p: string): string =>
      p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
    const envState = (process.env.ANTHOLOGY_STATE_DIR || '').trim();
    const envData = (process.env.OPENCLAW_DATA_DIR || '').trim();
    let stateDir: string;
    if (envState) {
      stateDir = untilde(envState);
    } else if (envData) {
      stateDir = path.join(untilde(envData), 'anthology-engine', 'state');
    } else {
      stateDir = path.join(home, '.anthology-engine', 'state');
    }
    const dbPath = path.join(stateDir, 'anthology_state.db');
    engines.anthology = fs.existsSync(dbPath);
  } catch {
    engines.anthology = false;
  }

  return NextResponse.json(engines);
}

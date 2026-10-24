#!/usr/bin/env node --import tsx
/**
 * scripts/merge-receipt-verify.ts — READ-ONLY verifier for Command Center
 * remote merge receipts (PBB-126 / T-45).
 *
 * The caller supplies what it read FROM THE REMOTE. This script never talks to
 * the network, never merges, never writes: it decides whether the receipt's
 * claims are proven by those facts and prints one line per refusal.
 *
 * Input (either shape):
 *   { "receipt": <receipt>, "evidence": <remote evidence> }
 *   { "entries": [ { "receipt": ..., "evidence": ... }, ... ] }   # batch
 *
 * Usage:
 *   npx tsx scripts/merge-receipt-verify.ts <input.json>
 *
 * Exit codes: 0 all receipts proven; 1 at least one finding; 2 usage/parse.
 */

import fs from 'node:fs';
import process from 'node:process';

import {
  verifyCohortBatch,
  verifyMergeReceipt,
  type MergeReceipt,
  type RemoteEvidence,
} from '../src/lib/integration/remote-merge-receipt';

interface Entry {
  receipt: MergeReceipt;
  evidence: RemoteEvidence;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const file = argv[0];
  if (!file || argv.includes('-h') || argv.includes('--help')) {
    return fail('usage: npx tsx scripts/merge-receipt-verify.ts <input.json>');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fail(`cannot read input JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('input JSON must be an object with "receipt" or "entries"');
  }

  const shape = raw as { receipt?: Entry['receipt']; evidence?: Entry['evidence']; entries?: Entry[] };
  const entries: Entry[] = shape.entries
    ? shape.entries
    : shape.receipt
      ? [{ receipt: shape.receipt, evidence: shape.evidence as Entry['evidence'] }]
      : [];
  if (entries.length === 0) return fail('input has neither "entries" nor "receipt"');

  const batch = entries.length > 1;
  const verdict = batch
    ? verifyCohortBatch(entries)
    : verifyMergeReceipt(entries[0].receipt, entries[0].evidence);

  if (verdict.ok) {
    console.log(`PASS ${batch ? `${entries.length} receipts` : entries[0].receipt.id} — remote proof complete`);
    return 0;
  }
  for (const finding of verdict.findings) {
    console.log(`FAIL ${finding.code}: ${finding.detail}`);
  }
  return 1;
}

if (process.argv[1] && /merge-receipt-verify/.test(process.argv[1])) {
  process.exitCode = main();
}

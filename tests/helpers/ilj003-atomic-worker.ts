#!/usr/bin/env tsx
/**
 * ILJ-003 atomic-append worker (spawned N× in parallel by the concurrency test).
 * One argv: the unique marker block to append. Writes are serialized by the
 * transcript lock inside appendTranscriptTextAtomic — every marker must survive.
 */
import { appendTranscriptTextAtomic } from '../../src/lib/interview/seam';

const marker = process.argv[2];
if (!marker) {
  console.error('usage: ilj003-atomic-worker.ts <marker>');
  process.exit(2);
}
const result = appendTranscriptTextAtomic(`**Q:** worker\n**A:** ${marker}\n\n---\n\n`);
if (!result.exists || result.decrypt !== 'ok') {
  console.error(`append failed: decrypt=${result.decrypt} exists=${result.exists}`);
  process.exit(1);
}
process.exit(0);

#!/usr/bin/env tsx
/**
 * lint-ceo-chat-colors.ts (U60 / JM-U63b — CI lint/grep gate)
 *
 * BINARY acceptance item 1: "CI lint gate: zero `indigo|purple|fuchsia`
 * utility classes under `src/app/my-ai-ceo/` + `src/components/ceo-chat/`
 * (gate fails on introduction — proven once by mutation)".
 *
 * Thin CLI wrapper over the pure scanner in `scripts/lib/ceo-chat-color-scan.ts`
 * (which `tests/unit/ceo-chat-color-lint.test.ts` mutation-tests directly).
 * Run: `npm run lint:ceo-chat-colors`.
 */
import path from 'path';
import { findViolations } from './lib/ceo-chat-color-scan';

const repoRoot = path.resolve(__dirname, '..');
const violations = findViolations(repoRoot);

if (violations.length > 0) {
  console.error(`[lint-ceo-chat-colors] ${violations.length} off-brand color violation(s) found:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  console.error(
    '\nindigo/purple/fuchsia are banned under src/app/my-ai-ceo/ and src/components/ceo-chat/ — use brand-*/bcc-*/semantic-* tokens.',
  );
  process.exit(1);
}

console.log('[lint-ceo-chat-colors] clean — zero indigo/purple/fuchsia utility classes under the My AI CEO surface.');

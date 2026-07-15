import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Dedicated config for REAL component render tests (jsdom + React). Kept
// separate from vitest.config.ts (environment: 'node', DB-backed suites) so
// this jsdom + @vitejs/plugin-react setup can never interfere with those.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'tests/unit/u55-company-health-render.test.tsx',
      // A-U5 acceptance (b) — PersonaScopeChips real render proof.
      'tests/unit/a-u5-persona-scope-chips-render.test.tsx',
      // U42 (C-11) — task-detail modal FULLY populated (multi-persona plan +
      // honest engine-card persona surface) real render proof.
      'tests/unit/u42-task-detail-modal-populated.test.tsx',
      // U47 acceptance (a)/(b)/(c)/(e) — HealthIndicator real render proof.
      'tests/unit/u47-health-indicator.test.tsx',
      // U104 acceptance (a)/(b)/(c) — engine-mirrored card honesty real render proof.
      'tests/unit/u104-engine-card-honesty.test.tsx',
      // U49/U61 (H+L.7) — Prove action outcome (pass/fail/fail-closed) real
      // render proof, never a silent swallow.
      'tests/unit/u49-prove-action-render.test.tsx',
      // U105 (E4-8) — task-modal in-app field help: <FieldHelp/> popover
      // open/close, a11y roles, and typed copy-map coverage real render
      // proof.
      'tests/unit/field-help.test.tsx',
    ],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

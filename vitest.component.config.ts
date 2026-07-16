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
      // U37 (C-06) — class-b "routed but not runnable" hold chip (card face)
      // + DispatchHoldPanel (task-detail modal) real render proof.
      'tests/unit/u37-c-06-dispatch-hold-render.test.tsx',
      // U38 (C-07) — S3 closure human-promote control: "Promote to Done
      // (operator)" (QcPromotePanel, task-detail modal) real render proof.
      'tests/unit/u38-c-07-qc-promote-render.test.tsx',
      // U50 (HL/U62) — model-catalog honesty: sticky ModelFilterBar + D14
      // "Show deprecated/stale" toggle + a visible ModelCard badge, real
      // render proof.
      'tests/unit/u50-model-catalog-honesty-render.test.tsx',
      // U116 (E6-2) CC leg, BINARY acceptance (e) — CommsAudienceChip
      // standard-vs-specific board-card render proof.
      'tests/unit/u116-comms-audience-chip-render.test.tsx',
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

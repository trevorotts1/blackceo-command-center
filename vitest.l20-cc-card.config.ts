import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// L20 (finding 3) — RepositoryStatusCard real render proof: "Not measured"
// with no data, a measured zero stays zero. Kept out of the shared
// vitest.component.config.ts include list, mirroring the b28 / pres021 pattern.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/jsdom-storage.ts'],
    include: ['tests/unit/l20-repository-status-card-not-measured.test.tsx'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});

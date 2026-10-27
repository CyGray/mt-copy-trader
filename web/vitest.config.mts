import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Route and view-model tests for the dashboard. No network: firebase-admin is
// replaced by an in-memory Firestore (worker/src/lib/testing/fakeFirestore.ts)
// and a token table (test/harness.ts).
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(here, '../worker/src/lib'),
      '@': path.resolve(here, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

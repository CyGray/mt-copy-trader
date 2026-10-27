import { configDefaults, defineConfig } from 'vitest/config';

// Only the TypeScript sources hold tests. Build outputs (dist, and the deploy
// script's .dist-next / .dist-prev / .dist-failed / .dist-dryrun copies)
// contain compiled *.test.js files that must not run.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'dist/**', '.dist-*/**'],
  },
});

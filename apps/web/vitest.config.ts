import { defineConfig } from 'vitest/config';

// Pure-logic unit tests (no DOM). Everything that needs a browser is covered by e2e/specs/p3-*.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});

import { defineConfig } from 'vitest/config';

// Logic unit tests. They run in plain node; a file that needs a DOM (the preview sanitiser)
// says so with `// @vitest-environment jsdom`. Everything that needs a real browser is covered
// by e2e/specs/p3-*.
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
});

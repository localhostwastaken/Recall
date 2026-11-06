import { defineConfig } from 'vitest/config';

// Tests of the repo's scripts. They run the scripts as real child processes against the local
// devnet (Arkiv :8545, Gnosis fork :9545); nothing here touches a live network.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 60_000 },
});

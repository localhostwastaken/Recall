import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Port 5173 is fixed: the extension's externally_connectable allows http://localhost:5173/*.
// No COEP/COOP headers are set (cross-origin isolation would block the RPC and Swarm gateway
// responses, which carry no CORP header).
export default defineConfig(({ command, mode }) => {
  // R30: a production build for the live network bakes the Arkiv access key in as the default,
  // so visitors need no key of their own (Settings can override it). It is read from the build
  // environment only: ARKIV_ACCESS_KEY in the process env (a CI secret) or in the git-ignored
  // repo-root .env.local. It is injected into the bundle here and written to no file of the repo.
  const env = loadEnv(mode, REPO_ROOT, '');
  const live = (env.VITE_RECALL_NET ?? '') !== 'local';
  const arkivKey = command === 'build' && live ? (env.ARKIV_ACCESS_KEY ?? '').trim() : '';
  return {
    // Relative asset URLs so the build also works under /app/ on GitHub Pages.
    base: './',
    plugins: [react()],
    define: { 'import.meta.env.VITE_ARKIV_ACCESS_KEY': JSON.stringify(arkivKey) },
    server: { port: 5173, strictPort: true },
    preview: { port: 5173, strictPort: true },
    build: { target: 'es2022' },
  };
});

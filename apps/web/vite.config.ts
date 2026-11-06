import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Port 5173 is fixed: the extension's externally_connectable allows http://localhost:5173/*.
// No COEP/COOP headers are set (cross-origin isolation would block the RPC and Swarm gateway
// responses, which carry no CORP header).
export default defineConfig({
  // Relative asset URLs so the build also works under /app/ on GitHub Pages.
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
});

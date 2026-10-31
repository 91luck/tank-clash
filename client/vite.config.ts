import { defineConfig } from 'vite';

// The client is a static bundle. The multiplayer backend URL is injected at build time via VITE_WS_URL
// (see docs/DEPLOYMENT.md); with no value it falls back to same-origin /ws (single-host deployment).
export default defineConfig({
  root: '.',
  server: { port: 5173, host: true, fs: { allow: ['..'] } },
  preview: { port: 4173, host: true },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 300 },
});

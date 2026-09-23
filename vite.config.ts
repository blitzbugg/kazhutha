import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Phase 3 client build (D43). Dev serves the SPA on :5173 and proxies
 * `/socket.io` (including websockets) to the game server on :3000, so the
 * client always talks to its same origin. `npm run build` emits `dist/`,
 * which `npm start` serves from Express — one origin in production too.
 * Split deployments set VITE_SERVER_URL to the server's absolute URL.
 */
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

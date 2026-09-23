/**
 * Production entrypoint — `npm start`.
 *
 * Serves the Socket.IO game server plus, when a `dist/` build exists (D46),
 * the Phase 3 SPA from the same origin. /healthz answers JSON either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameServer, type SocketServerOptions } from './index.js';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const opts: SocketServerOptions = fs.existsSync(path.join(distDir, 'index.html'))
  ? { staticDir: distDir }
  : {};

const port = Number(process.env.PORT ?? 3000);
const server = new GameServer(opts);

server
  .listen(port)
  .then((p) => {
    console.log(`[kazhuta] listening on http://localhost:${p}${opts.staticDir !== undefined ? ' (serving SPA from dist/)' : ' (API only — no dist/ build)'}`);
  })
  .catch((err) => {
    console.error('[kazhuta] failed to start:', err);
    process.exit(1);
  });

const shutdown = (signal: string): void => {
  console.log(`[kazhuta] ${signal} received — shutting down`);
  server
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

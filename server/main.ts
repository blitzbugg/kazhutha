/**
 * Production entrypoint — `npm start`. Phase 3's UI will be served separately;
 * for now the socket server runs standalone and answers /healthz.
 */
import { GameServer } from './index.js';

const port = Number(process.env.PORT ?? 3000);
const server = new GameServer();

server
  .listen(port)
  .then((p) => {
    console.log(`[kazhuta] socket server listening on http://localhost:${p}`);
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

/**
 * UI-verification bot clients (Phase 3 manual-test support).
 *
 * Fills remaining seats in a room and plays a legal card whenever it is the
 * bot's turn, so a human can drive seat 1 purely through the browser UI:
 *
 *   npx tsx scripts/ui-bots.ts <ROOM_CODE> <BOT_COUNT>
 *
 * Legal-card logic mirrors client/rules.ts (the server stays the authority):
 *   - round 1 opener: S14
 *   - holds active suit: lowest suit card
 *   - otherwise: lowest card (forced true strike)
 * Bot views are PlayerViews of their own seat only — no other hand is ever
 * visible, same as the browser.
 */
import { io, type Socket } from 'socket.io-client';

const roomCode = (process.argv[2] ?? '').toUpperCase();
const botCount = Number(process.argv[3] ?? 2);
const url = process.env.KAZHUTA_URL ?? 'http://localhost:3000';

if (!/^[A-Z0-9]{5}$/.test(roomCode) || !Number.isInteger(botCount) || botCount < 1) {
  console.error('usage: tsx scripts/ui-bots.ts <ROOM_CODE> <BOT_COUNT>');
  process.exit(1);
}

interface BotView {
  phase: 'not-started' | 'in-round' | 'game-over';
  roundNumber: number;
  players: Array<{ id: string; name: string }>;
  yourHand: Array<{ id: string; suit: string; rank: number }>;
  currentTurnId: string | null;
  activeSuit: string | null;
  playedThisRound: Array<{ playerId: string; card: { id: string } }>;
}

let finished = 0;

function runBot(index: number): void {
  const name = `Bot ${String.fromCharCode(65 + index)}`;
  const socket: Socket = io(url, { reconnection: true });
  let selfId: string | null = null;
  /** Round+play-count marker of the state the current pending play was based on. */
  let pendingKey = '';
  let joined = false;
  let retries = 0;

  const pickCard = (view: BotView): string => {
    const hand = [...view.yourHand].sort((a, b) => a.rank - b.rank);
    if (view.roundNumber === 1 && view.playedThisRound.length === 0) {
      return 'S14'; // forced opener (engine validates possession)
    }
    const suitCard = view.activeSuit === null ? undefined : hand.find((c) => c.suit === view.activeSuit);
    return (suitCard ?? hand[0]!).id;
  };

  const tryJoin = (): void => {
    socket.emit('room:join', { roomCode, name });
  };

  socket.on('connect', () => {
    if (!joined) tryJoin();
  });

  socket.on('room:joined', (p: { roomCode: string; playerId: string | null; isSpectator: boolean; resumed: boolean }) => {
    joined = true;
    selfId = p.playerId;
    console.log(`[bot ${name}] joined ${p.roomCode}${p.isSpectator ? ' as SPECTATOR' : ''}${p.resumed ? ' (resumed)' : ''}`);
  });

  socket.on('state', (p: { roomCode: string; view: unknown }) => {
    if (!joined || selfId === null) return;
    const view = p.view as BotView;
    if (!('yourHand' in view)) return; // spectator view — cannot act
    if (view.phase !== 'in-round') return;
    const key = `${view.roundNumber}:${view.playedThisRound.length}`;
    if (view.currentTurnId !== selfId) {
      pendingKey = ''; // world moved past our play — latch cleared
      return;
    }
    if (pendingKey === key || view.yourHand.length === 0) return; // already acted on this state
    const cardId = pickCard(view);
    pendingKey = key;
    setTimeout(() => {
      console.log(`[bot ${name}] plays ${cardId} (round ${view.roundNumber}, ${view.yourHand.length - 1} left)`);
      socket.emit('game:play-card', { roomCode, cardId });
    }, 250);
  });

  socket.on('game:over', (p: { loserId: string | null }) => {
    finished += 1;
    console.log(`[bot ${name}] game over — Kazhuta: ${p.loserId ?? 'nobody'}`);
    if (finished >= botCount) {
      setTimeout(() => process.exit(0), 500);
    }
  });

  socket.on('error', (p: { code: string; message: string }) => {
    if (p.code === 'ROOM_NOT_FOUND' && !joined && retries < 20) {
      retries += 1;
      setTimeout(tryJoin, 1000);
      return;
    }
    console.log(`[bot ${name}] error: ${p.code} — ${p.message}`);
    if (p.code === 'ROOM_NOT_FOUND' || p.code === 'NOT_YOUR_TURN' || p.code === 'CARD_NOT_IN_HAND') {
      pendingKey = '';
    }
  });

  socket.on('disconnect', () => {
    pendingKey = '';
  });
}

for (let i = 0; i < botCount; i += 1) runBot(i);

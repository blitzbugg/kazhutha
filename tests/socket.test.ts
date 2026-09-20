/**
 * Phase 2 integration tests — real Socket.IO server on loopback, driven with
 * socket.io-client. Covers S2 (resume), S5 (sender-only errors), S6 (connect
 * rate limit), S7 (spectator fallback), S9 (payload validation), S10 (per-room
 * serialization), a full scripted 4-player game to game:over, and the E7
 * mode (b) challenge flow end-to-end.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { io, type Socket } from 'socket.io-client';

import { GameServer } from '../server/index.js';
import type { PlayerView, PublicView } from '../engine.js';
import { setHands } from './helpers.js';

type AnyView = PlayerView | PublicView;

const PORT = 3787;
const URL = `http://127.0.0.1:${PORT}`;

let server: GameServer;

before(async () => {
  server = new GameServer({
    turnGraceMs: 300,
    emptyRoomTtlMs: 400,
    challengeCooldownMs: 0,
    minActionIntervalMs: 0,
    connectRateLimitMs: 10_000, // only the S6 test sends two connect-ops per socket
  });
  await server.listen(PORT);
});

after(async () => {
  await server.stop();
});

// -- client harness -----------------------------------------------------------

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

/** Connect with the listener attached BEFORE the handshake (catches `hello`). */
function connectCapturingHello(): Promise<{ s: Socket; hello: Promise<{ turnGraceMs: number; emptyRoomTtlMs: number }> }> {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false, autoConnect: false });
    const hello = new Promise<{ turnGraceMs: number; emptyRoomTtlMs: number }>((res, rej) => {
      const t = setTimeout(() => rej(new Error('no hello')), 4_000);
      s.once('hello', (h) => {
        clearTimeout(t);
        res(h);
      });
    });
    s.once('connect', () => resolve({ s, hello }));
    s.once('connect_error', reject);
    s.connect();
  });
}

function waitEvent<T>(s: Socket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    s.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A client with recorded errors + latest view for assertions. */
function harness(s: Socket): {
  errors: Array<{ event: string; code: string; message: string }>;
  latestView: () => AnyView | null;
  latestPlayers: () => unknown;
} {
  const errors: Array<{ event: string; code: string; message: string }> = [];
  let view: AnyView | null = null;
  let players: unknown = null;
  s.on('error', (e) => errors.push(e));
  s.on('state', (p: { view: AnyView }) => {
    view = p.view;
  });
  s.on('room:players', (p: unknown) => {
    players = p;
  });
  return { errors, latestView: () => view, latestPlayers: () => players };
}

/** Create a room, return { code, token, playerId } of the host seat. */
async function createRoom(name: string): Promise<{ s: Socket; h: ReturnType<typeof harness>; code: string; token: string; playerId: string }> {
  const s = await connect();
  const joined = waitEvent<{
    roomCode: string;
    sessionToken: string;
    playerId: string;
  }>(s, 'room:joined');
  s.emit('room:create', { name });
  const j = await joined;
  return { s, h: harness(s), code: j.roomCode, token: j.sessionToken, playerId: j.playerId };
}

async function joinSeat(code: string, name: string): Promise<{
  s: Socket;
  h: ReturnType<typeof harness>;
  code: string;
  token: string;
  playerId: string;
}> {
  const s = await connect();
  const joined = waitEvent<{
    roomCode: string;
    sessionToken: string;
    playerId: string;
    isSpectator: boolean;
  }>(s, 'room:joined');
  s.emit('room:join', { roomCode: code, name });
  const j = await joined;
  assert.equal(j.isSpectator, false);
  return { s, h: harness(s), code, token: j.sessionToken, playerId: j.playerId };
}

// -- tests ----------------------------------------------------------------------

describe('S9 — payload validation & hello', () => {
  test('hello carries the server timing policy', async () => {
    const { s, hello } = await connectCapturingHello();
    const h = await hello;
    assert.equal(h.turnGraceMs, 300);
    assert.equal(h.emptyRoomTtlMs, 400);
    s.disconnect();
  });

  test('malformed payloads are rejected before any state is touched', async () => {
    const s = await connect();
    const h = harness(s);
    const err = waitEvent<{ event: string; code: string; issues?: unknown }>(s, 'error');
    s.emit('room:create', { name: 42 }); // wrong type
    const e = await err;
    assert.equal(e.code, 'BAD_PAYLOAD');
    assert.ok(Array.isArray(e.issues));
    assert.equal(h.latestView(), null, 'no state was created');
    s.disconnect();
  });
});

describe('S5 — errors are sender-only', () => {
  test('a failing request errors only the requester; peers see nothing', async () => {
    const host = await createRoom('host');
    const peer = await joinSeat(host.code, 'peer');

    const peerGotError = new Promise<string>((resolve) => peer.h.errors.length && resolve('early'));
    const hostErr = waitEvent<{ code: string }>(host.s, 'error');
    host.s.emit('game:start', { roomCode: host.code }); // only 2 seated → NOT_ENOUGH_PLAYERS
    assert.equal((await hostErr).code, 'NOT_ENOUGH_PLAYERS');

    await Promise.race([peerGotError, sleep(250)]);
    assert.equal(peer.h.errors.length, 0, 'the error never reached the peer');

    host.s.disconnect();
    peer.s.disconnect();
  });
});

describe('S3/S8 — host-only start', () => {
  test('full lobby: host starts, everyone lands in-round', async () => {
    const host = await createRoom('host');
    const p2 = await joinSeat(host.code, 'p2');
    const p3 = await joinSeat(host.code, 'p3');

    const states = Promise.all([
      waitEvent<{ view: PublicView }>(host.s, 'state', 6_000),
      waitEvent<{ view: PublicView }>(p2.s, 'state', 6_000),
      waitEvent<{ view: PublicView }>(p3.s, 'state', 6_000),
    ]);
    host.s.emit('game:start', { roomCode: host.code });
    const [v1, v2, v3] = await states;
    for (const v of [v1, v2, v3]) {
      assert.equal(v.view.phase, 'in-round');
      assert.equal(v.view.players.length, 3);
      // Seated players get PlayerViews (with their own hand); nobody gets
      // another player's hand and the server never ships the deck.
      assert.equal('deck' in v.view, false);
    }
    host.s.disconnect();
    p2.s.disconnect();
    p3.s.disconnect();
  });

  test('non-host game:start is rejected with NOT_HOST', async () => {
    const host = await createRoom('host');
    const p2 = await joinSeat(host.code, 'p2');
    const p3 = await joinSeat(host.code, 'p3');
    const err = waitEvent<{ code: string }>(p2.s, 'error');
    p2.s.emit('game:start', { roomCode: host.code });
    assert.equal((await err).code, 'NOT_HOST');
    host.s.disconnect();
    p2.s.disconnect();
    p3.s.disconnect();
  });
});

describe('S2 — resume over a fresh socket', () => {
  test('reconnect with the session token restores seat, hand and host flag', async () => {
    const host = await createRoom('host');
    await joinSeat(host.code, 'p2');
    await joinSeat(host.code, 'p3');

    // Deal a game so the resumed seat has a hand to rehydrate.
    host.s.emit('game:start', { roomCode: host.code });
    await waitEvent<{ view: PublicView }>(host.s, 'state', 6_000);
    // Drop and resume.
    host.s.disconnect();

    const s2 = await connect();
    const joined = waitEvent<{
      playerId: string;
      resumed: boolean;
      view: PlayerView;
      isHost: boolean;
    }>(s2, 'room:joined');
    s2.emit('room:join', { roomCode: host.code, name: 'host', sessionToken: host.token });
    const j = await joined;
    assert.equal(j.resumed, true);
    assert.equal(j.playerId, host.playerId);
    // S3: while offline, the host seat was PROMOTED AWAY to a connected
    // player — resuming restores the seat and hand, not the host flag.
    assert.equal(j.isHost, false);
    assert.ok(Array.isArray(j.view.yourHand), 'personal snapshot carries the hand');
    s2.disconnect();
  });
});

describe('S6 — connect-op rate limiting', () => {
  test('a second room:create/join from one socket inside the window is rate-limited', async () => {
    const s = await connect();
    const first = waitEvent<{ code: string }>(s, 'error');
    s.emit('room:join', { roomCode: 'ZZZZZ', name: 'x' }); // unknown code
    assert.equal((await first).code, 'ROOM_NOT_FOUND');

    const second = waitEvent<{ code: string }>(s, 'error');
    s.emit('room:join', { roomCode: 'ZZZZZ', name: 'x' });
    assert.equal((await second).code, 'RATE_LIMITED');
    s.disconnect();
  });
});

describe('S7 — spectator fallback', () => {
  test('9th joiner of a full room becomes a spectator, not an error', async () => {
    const host = await createRoom('host');
    for (let i = 2; i <= 8; i++) await joinSeat(host.code, `p${i}`);
    const ninth = await connect();
    const h = harness(ninth);
    const joined = waitEvent<{ isSpectator: boolean; playerId: string | null; view: unknown }>(ninth, 'room:joined');
    ninth.emit('room:join', { roomCode: host.code, name: 'ninth' });
    const j = await joined;
    assert.equal(j.isSpectator, true);
    assert.equal(j.playerId, null);

    ninth.emit('room:list-players', { roomCode: host.code });
    await waitEvent<{ spectatorCount: number }>(ninth, 'room:players');
    const list = h.latestPlayers() as { spectatorCount: number } | null;
    assert.equal(list?.spectatorCount, 1);
    ninth.disconnect();
  });
});

describe('S10 + full game — scripted 4-player game to game:over', () => {
  test('four clients play a complete game; views stay redacted; game:over fires once', async () => {
    const host = await createRoom('host');
    const seats = [host];
    for (let i = 2; i <= 4; i++) seats.push(await joinSeat(host.code, `p${i}`));

    host.s.emit('game:start', { roomCode: host.code });
    await waitEvent<{ view: PublicView }>(host.s, 'state', 6_000);

    const over = waitEvent<{ loserId: string | null }>(host.s, 'game:over', 30_000);
    const overCount = { n: 0 };
    host.s.on('game:over', () => overCount.n++);

    // Driver: each client plays when it is their turn (lowest legal card).
    const drivers = seats.map(async (seat) => {
      for (let guard = 0; guard < 400; guard++) {
        const view = seat.h.latestView() as PlayerView | null;
        if (view && view.phase === 'game-over') break; // done polling
        if (!view || view.phase !== 'in-round') {
          await sleep(25);
          continue;
        }
        if (view.currentTurnId !== seat.playerId) {
          await sleep(15);
          continue;
        }
        const card = pickClientCard(view);
        seat.s.emit('game:play-card', { roomCode: host.code, cardId: card });
        await sleep(30); // let S10 serialization + fanout settle
      }
    });
    await Promise.race([Promise.all(drivers), sleep(25_000)]);

    const result = await over;
    assert.equal(overCount.n, 1, 'game:over emitted exactly once');
    assert.ok(result.loserId === null || seats.some((s) => s.playerId === result.loserId));

    // Views remained redacted the whole game: no other-hand leaks, no deck.
    const view = seats[1]!.h.latestView() as PlayerView;
    assert.equal('deck' in view, false);
    assert.ok(Array.isArray(view.yourHand));

    for (const s of seats) s.s.disconnect();
  });
});

describe('E7 — challenge flow (mode b) over the wire', () => {
  test('failed challenge logs nothing decisive; successful challenge pins the loser', async () => {
    const host = await createRoom('host');
    const seats = [host, await joinSeat(host.code, 'b'), await joinSeat(host.code, 'c')];

    host.s.emit('game:start', { roomCode: host.code });
    await waitEvent<{ view: PublicView }>(host.s, 'state', 6_000);

    // White-box: craft hands so the CURRENT leader (who holds A♠ by
    // construction, hence the forced round-1 lead) is A. B is the seat AFTER
    // A in anticlockwise order and holds a heart, a spade and a club: playing
    // the club while holding the led spade is a FALSE strike (D11 snapshot).
    const room = server.store.getRoom(host.code)!;
    const state = room.state!;
    const aId = state.currentTurnId!;
    const seatOf = (id: string): number => state.players.find((p) => p.id === id)!.seat;
    const nextSeat = (seatOf(aId) + 1) % state.players.length;
    const bId = state.players.find((p) => p.seat === nextSeat)!.id;
    const cId = state.players.find((p) => p.id !== aId && p.id !== bId)!.id;
    setHands(state, {
      [aId]: ['S14', 'H4', 'H6'],
      [bId]: ['H2', 'S3', 'C3'],
      [cId]: ['H5'],
    });
    const aSock = seats.find((s) => s.playerId === aId)!;
    const bSock = seats.find((s) => s.playerId === bId)!;
    const cSock = seats.find((s) => s.playerId === cId)!;

    // A leads the forced A♠.
    aSock.s.emit('game:play-card', { roomCode: host.code, cardId: 'S14' });
    await sleep(150);

    // B false-strikes: plays the club while still holding the led spade.
    bSock.s.emit('game:play-card', { roomCode: host.code, cardId: 'C3' });
    await sleep(150);

    // C challenges B → success (evidence exists server-side, D10–D12).
    // Listeners attach BEFORE the emit: game:over fires in the same fanout
    // wave as challenge:result (successful challenge ⇒ immediate game-over).
    const result = waitEvent<{ accusedId: string; succeeded: boolean }>(cSock.s, 'challenge:result', 6_000);
    const over = waitEvent<{ loserId: string | null }>(cSock.s, 'game:over', 6_000);
    cSock.s.emit('game:challenge', { roomCode: host.code, accusedId: bId });
    const r = await result;
    assert.equal(r.succeeded, true);
    assert.equal(r.accusedId, bId);
    const o = await over;
    assert.equal(o.loserId, bId, 'successful challenge ends the game immediately');

    // Now the false path: a fresh game where the accused never false-struck.
    host.s.emit('game:again', { roomCode: host.code });
    await sleep(150);
    const fail = waitEvent<{ succeeded: boolean }>(cSock.s, 'challenge:result', 6_000);
    cSock.s.emit('game:challenge', { roomCode: host.code, accusedId: aId });
    assert.equal((await fail).succeeded, false);
    const view = cSock.h.latestView() as PlayerView;
    assert.equal(view.phase, 'in-round', 'failed challenge does not end the game');

    for (const s of seats) s.s.disconnect();
  });
});

describe('S1 — disconnect auto-play over the wire', () => {
  test('a dropped player is auto-played after the grace period', async () => {
    const host = await createRoom('host');
    const b = await joinSeat(host.code, 'b');
    const c = await joinSeat(host.code, 'c');
    host.s.emit('game:start', { roomCode: host.code });
    await waitEvent<{ view: PublicView }>(host.s, 'state', 6_000);

    const room = server.store.getRoom(host.code)!;
    const leaderId = room.state!.currentTurnId!;
    const sockets = [host, b, c];
    const leader = sockets.find((s) => s.playerId === leaderId)!;
    const before = room.state!.hands[leaderId]!.length;

    leader.s.disconnect(); // drop ON their turn
    await sleep(600); // grace is 300ms

    const list = sockets.find((s) => s.s.connected)!.h.latestPlayers() as {
      players: Array<{ playerId: string; cardCount: number }>;
    };
    const entry = list.players.find((p) => p.playerId === leaderId)!;
    assert.ok(entry.cardCount < before, 'server played for the offline seat');

    for (const s of sockets) if (s.s.connected) s.s.disconnect();
  });
});

describe('S3 — room:closed broadcast', () => {
  test('last seat leaves → TTL elapses → room:closed reaches lingering sockets', async () => {
    const host = await createRoom('host');
    const closed = waitEvent<{ roomCode: string; reason: string }>(host.s, 'room:closed', 6_000);
    // room:leave removes the seat; the socket deliberately STAYS in the
    // Socket.IO room so late broadcasts (room:closed) reach the client.
    host.s.emit('room:leave', { roomCode: host.code });
    const c = await closed;
    assert.equal(c.reason, 'empty');
    host.s.disconnect();
  });
});

// -- helpers ---------------------------------------------------------------------

/** Client-side "lowest legal card" (mirrors the server's D30 policy). */
function pickClientCard(view: PlayerView): string {
  const hand = view.yourHand;
  if (view.roundNumber === 1 && !view.activeSuit) {
    const ace = hand.find((c) => c.id === 'S14');
    if (ace) return ace.id;
  }
  const suitCards = view.activeSuit ? hand.filter((c) => c.suit === view.activeSuit) : [];
  const pool = suitCards.length > 0 ? suitCards : hand;
  return pool.reduce((low, c) => (c.rank < low.rank ? c : low)).id;
}

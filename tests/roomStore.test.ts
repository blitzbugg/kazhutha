/**
 * Phase 2 unit tests — RoomStore edge cases S1–S4, S7, S8, S11 with a virtual
 * clock (D29). Socket-level behavior is covered in socket.test.ts.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RoomStore, type Room, type Seat } from '../server/roomStore.js';
import { fakeClock } from './helpers.js';

function makeStore(overrides: {
  turnGraceMs?: number;
  emptyRoomTtlMs?: number;
  challengeCooldownMs?: number;
  minActionIntervalMs?: number;
} = {}) {
  const fc = fakeClock();
  const store = new RoomStore({
    clock: fc.clock,
    turnGraceMs: 30_000,
    emptyRoomTtlMs: 60_000,
    challengeCooldownMs: 10_000,
    minActionIntervalMs: 250,
    ...overrides,
  });
  return { fc, store };
}

/** Host + N-1 joiners, all "connected" via bound fake socket ids. */
function seatedRoom(store: RoomStore, n = 4): { room: Room; seats: Seat[] } {
  const { room, seat } = store.createRoom('host');
  store.bindSocket('sock-0', { room, seat, spectator: null });
  const seats = [seat];
  for (let i = 1; i < n; i++) {
    const joined = store.joinRoom(room.code, `p${i}`);
    store.bindSocket(`sock-${i}`, {
      room: joined.room,
      seat: joined.seat,
      spectator: null,
    });
    seats.push(joined.seat!);
  }
  return { room, seats };
}

describe('S2 — session tokens & resume', () => {
  test('join with a session token rehydrates the same seat and hand', () => {
    const { store } = makeStore();
    const { room, seats } = seatedRoom(store, 3);
    store.startGame(room, seats[0]!);
    const handBefore = [...room.state!.hands[seats[0]!.id]!];

    // Detach all sockets (host drops), then resume with the token.
    for (let i = 0; i < 3; i++) store.socketLeft(`sock-${i}`);
    const res = store.joinRoom(room.code, 'ignored-name', seats[0]!.sessionToken);
    assert.equal(res.resumed, true);
    assert.equal(res.seat!.id, seats[0]!.id);
    assert.deepEqual(
      res.room.state!.hands[seats[0]!.id]!.map((c) => c.id),
      handBefore.map((c) => c.id),
    );
  });

  test('a token issued in room A grants nothing in room B (D27 scoping)', () => {
    const { store } = makeStore();
    const a = store.createRoom('alice');
    const b = store.createRoom('bob');
    const res = store.joinRoom(b.room.code, 'alice', a.seat.sessionToken);
    assert.equal(res.resumed, false, 'treated as a fresh join, not a resume');
    assert.notEqual(res.seat!.id, a.seat.id);
  });
});

describe('S1 — disconnect grace + auto-play', () => {
  test('offline seat keeps its turn and is auto-played after the grace period', () => {
    const { fc, store } = makeStore();
    const { room, seats } = seatedRoom(store, 4);
    store.startGame(room, seats[0]!);

    // The A♠ holder leads round 1 — find them, then disconnect everyone.
    const leader = room.state!.currentTurnId!;
    const leaderIdx = seats.findIndex((s) => s.id === leader);
    store.socketLeft(`sock-${leaderIdx}`);
    const seat = seats[leaderIdx]!;
    const cardCount = room.state!.hands[seat.id]!.length;

    fc.advance(30_000); // grace elapses → server plays for them
    assert.equal(
      room.state!.hands[seat.id]!.length,
      cardCount - 1,
      'server played exactly one card for the offline leader',
    );
    assert.equal(
      room.autoPlays.at(-1)!.playerId,
      seat.id,
      'auto-play audit trail records the seat',
    );
  });

  test('reconnecting before the grace period cancels the auto-play', () => {
    const { fc, store } = makeStore();
    const { room, seats } = seatedRoom(store, 4);
    store.startGame(room, seats[0]!);
    const leader = seats.find((s) => s.id === room.state!.currentTurnId)!;
    const leaderIdx = seats.indexOf(leader);
    store.socketLeft(`sock-${leaderIdx}`);
    const before = room.state!.hands[leader.id]!.length;

    fc.advance(10_000); // half the grace period
    const res = store.joinRoom(room.code, 'x', leader.sessionToken);
    store.bindSocket('sock-resumed', { room: res.room, seat: res.seat!, spectator: null });
    fc.advance(60_000); // well past the original deadline
    assert.equal(
      room.state!.hands[leader.id]!.length,
      before,
      'no card auto-played after reconnect',
    );
    assert.equal(
      room.autoPlays.some((a) => a.playerId === leader.id),
      false,
    );
  });
});

describe('S3 — host promotion & empty-room GC', () => {
  test('host disconnect promotes the next connected seat', () => {
    const { store } = makeStore();
    const { room, seats } = seatedRoom(store, 3);
    assert.equal(room.hostId, seats[0]!.id);
    store.socketLeft('sock-0');
    assert.equal(room.hostId, seats[1]!.id, 'promotion follows seat order');
    assert.equal(seats[0]!.host, false);
    assert.equal(seats[1]!.host, true);
  });

  test('fully empty room is closed after the TTL; a reappearance cancels it', () => {
    const { fc, store } = makeStore();
    const { room } = seatedRoom(store, 2);
    const code = room.code;

    store.socketLeft('sock-0');
    store.socketLeft('sock-1');
    fc.advance(59_000);
    assert.notEqual(store.getRoom(code), undefined, 'not yet GC-able');
    // Someone pops back in before the TTL:
    const re = store.joinRoom(code, 'returner');
    store.bindSocket('sock-returner', { room: re.room, seat: re.seat, spectator: null });
    fc.advance(120_000);
    assert.notEqual(store.getRoom(code), undefined, 'timer was cancelled');

    store.socketLeft('sock-returner');
    fc.advance(60_000);
    assert.equal(store.getRoom(code), undefined, 'closed after the full TTL');
  });
});

describe('S7 — spectator fallback for a full room', () => {
  test('9th distinct joiner over capacity surfaces ROOM_FULL (socket layer spectates)', () => {
    const { store } = makeStore();
    const { room } = seatedRoom(store, 8);
    assert.throws(() => store.joinRoom(room.code, 'ninth'), /8 players/);
  });
});

describe('S8 — host-only start guards', () => {
  test('non-host cannot start; host cannot start with fewer than 3 seated', () => {
    const { store } = makeStore();
    const { room, seats } = seatedRoom(store, 3);
    assert.throws(
      () => store.startGame(room, seats[1]!),
      (err: unknown) => (err as { code?: string }).code === 'NOT_HOST',
    );
    // Drop to 2 seats, then a valid host start must fail on headcount.
    store.leaveRoom(room.code, seats[2]!.id);
    assert.throws(
      () => store.startGame(room, seats[0]!),
      (err: unknown) => (err as { code?: string }).code === 'NOT_ENOUGH_PLAYERS',
    );
  });
});

describe('E6 — rematch rotates the dealer', () => {
  test('game:again keeps seats and advances dealerIndex by one', () => {
    const { store } = makeStore({ minActionIntervalMs: 0 });
    const { room, seats } = seatedRoom(store, 4);
    store.startGame(room, seats[0]!);
    let guard = 0;
    while (room.state!.phase !== 'game-over' && guard++ < 500) {
      const turn = room.state!.currentTurnId;
      if (!turn) break;
      const seat = seats.find((s) => s.id === turn)!;
      const played = room.state!.hands[turn]!.some((c) => {
        try {
          store.playCard(room, seat, c.id);
          return true;
        } catch {
          return false; // e.g. round 1 forces the A♠ lead (D16)
        }
      });
      if (!played) break; // unexpected — nothing legal
    }
    assert.equal(room.state!.phase, 'game-over', 'game completed');

    const dealerBefore = room.state!.dealerIndex;
    store.playAgain(room, seats[0]!);
    assert.equal(room.state!.phase, 'in-round');
    assert.equal(
      room.state!.dealerIndex,
      (dealerBefore + 1) % room.seats.length,
      'dealer rotated anticlockwise',
    );
    // 52 cards, 4 players → everyone holds 13 again.
    for (const s of room.seats) assert.equal(room.state!.hands[s.id]!.length, 13);
  });
});

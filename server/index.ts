/**
 * Phase 2 socket server — the transport around RoomStore (AGENTS.md Phase 2).
 *
 * Edge cases owned here (details in docs/DECISIONS.md D26–D31):
 *  S2  session resume via secret sessionToken (room:join with token)
 *  S3  host promotion (store) + empty-room TTL close (store); events emitted here
 *  S5  errors go ONLY to the offending socket; every socket gets its own
 *      redacted view — other hands never cross the wire
 *  S6  per-socket rate limiting: connect-op spacing here, action spacing in store
 *  S7  join may fall back to spectator when seats are full
 *  S9  every inbound payload validated with zod BEFORE any state is touched
 *  S10 per-room mutation serialization via promise chains
 *  E7  game:challenge implements false-strike mode (b) (engine D10–D12):
 *      resolveChallenge() is silent unless it succeeds; failed challenges log.
 *
 * No game rules live here — RoomStore + engine own them. This file only
 * validates, rate-limits, serializes, and fans out.
 */
import http from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import express from 'express';

import {
  RoomStore,
  realClock,
  type AuthContext,
  type Room,
  type Seat,
  type StoreClock,
  type StoreError,
} from './roomStore.js';
import {
  RoomCreateSchema,
  RoomJoinSchema,
  RoomLeaveSchema,
  RoomListPlayersSchema,
  GameStartSchema,
  GameAgainSchema,
  GamePlayCardSchema,
  GameChallengeSchema,
  type ErrorPayload,
  type ErrorCode,
  type GameOverPayload,
  type HelloPayload,
  type PlayerConnectionPayload,
  type PlayerListPayload,
  type RoomClosedPayload,
  type RoundResolvedPayload,
} from './types.js';

/** Events clients may send — the Phase 3 client implements exactly these. */
export const ClientEvents = [
  'room:create',
  'room:join',
  'room:leave',
  'room:list-players',
  'game:start',
  'game:again',
  'game:play-card',
  'game:challenge',
] as const;
export type ClientEvent = (typeof ClientEvents)[number];

/** Events the server emits. */
export const ServerEvents = [
  'hello',
  'error', // S5: unicast to the offender only, never broadcast
  'room:joined',
  'your:seat', // personal snapshot (join + S2 resume)
  'room:players',
  'state', // per-socket redacted view, sent on every room mutation
  'game:round-resolved',
  'game:over',
  'challenge:result', // E7: unicast to the challenger (succeeded or not)
  'player:connected',
  'player:disconnected',
  'room:closed',
] as const;
export type ServerEvent = (typeof ServerEvents)[number];

export interface SocketServerOptions {
  turnGraceMs?: number;
  emptyRoomTtlMs?: number;
  challengeCooldownMs?: number;
  minActionIntervalMs?: number;
  /** S6: minimum ms between room:create/join from one socket. */
  connectRateLimitMs?: number;
  clock?: StoreClock;
}

const DEFAULTS: Required<Omit<SocketServerOptions, 'clock'>> = {
  turnGraceMs: 90_000,
  emptyRoomTtlMs: 120_000,
  challengeCooldownMs: 10_000,
  minActionIntervalMs: 250,
  connectRateLimitMs: 1_000,
};

/** Per-socket server-side state (never trusted from the client). */
interface SocketSession {
  ctx: AuthContext | null;
  lastConnectOpAt: number;
}

export class GameServer {
  readonly io: SocketIOServer;
  readonly store: RoomStore;
  private readonly http: http.Server;
  private readonly clock: StoreClock;
  private readonly opts: Required<Omit<SocketServerOptions, 'clock'>>;
  private readonly sessions = new Map<string, SocketSession>(); // socketId → session
  private readonly roomChains = new Map<string, Promise<void>>(); // S10
  /** Rooms whose game:over already fired (reset on rematch). */
  private readonly gameOverEmitted = new Set<string>();
  /** Last known connected-seat set per room, for connection-event deltas. */
  private readonly lastConnected = new Map<string, Set<string>>();
  private stopped = false;

  constructor(opts: SocketServerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.clock = opts.clock ?? realClock;

    const app = express();
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, rooms: this.store.roomCount() });
    });

    this.http = http.createServer(app);
    this.io = new SocketIOServer(this.http, { cors: { origin: true } });
    this.store = new RoomStore({
      clock: this.clock,
      turnGraceMs: this.opts.turnGraceMs,
      emptyRoomTtlMs: this.opts.emptyRoomTtlMs,
      challengeCooldownMs: this.opts.challengeCooldownMs,
      minActionIntervalMs: this.opts.minActionIntervalMs,
    });

    // Store fanout → socket broadcasts. The store calls this synchronously
    // after every mutation; ordering within a room is therefore stable.
    this.store.onChange((room) => this.fanout(room));

    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  /** Start listening. Resolves with the bound port. */
  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, () => resolve());
    });
    const addr = this.http.address();
    return typeof addr === 'object' && addr !== null ? addr.port : port;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.store.dispose();
    this.sessions.clear();
    this.roomChains.clear();
    this.gameOverEmitted.clear();
    this.lastConnected.clear();
    await this.io.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // -- connection lifecycle ---------------------------------------------------

  private onConnection(socket: Socket): void {
    const session: SocketSession = { ctx: null, lastConnectOpAt: 0 };
    this.sessions.set(socket.id, session);

    const hello: HelloPayload = {
      turnGraceMs: this.opts.turnGraceMs,
      emptyRoomTtlMs: this.opts.emptyRoomTtlMs,
      challengeCooldownMs: this.opts.challengeCooldownMs,
      minActionIntervalMs: this.opts.minActionIntervalMs,
    };
    socket.emit('hello', hello);

    /**
     * S9 gate + S5 error routing, shared by every inbound event: validate the
     * payload shape first, then run the handler, relaying store/engine errors
     * to this socket ONLY.
     */
    const on = <P>(
      event: ClientEvent,
      schema: { safeParse(v: unknown): { success: boolean; data?: P; error?: { issues: Array<{ path: ReadonlyArray<string | number | symbol>; message: string }> } } },
      fn: (payload: P) => void,
    ): void => {
      socket.on(event, (raw: unknown) => {
        if (this.stopped) return;
        const parsed = schema.safeParse(raw);
        if (!parsed.success || parsed.data === undefined) {
          this.fail(socket, event, 'BAD_PAYLOAD', 'Malformed payload.', zIssues(parsed));
          return;
        }
        try {
          fn(parsed.data);
        } catch (err) {
          this.relayError(socket, event, err);
        }
      });
    };

    on('room:create', RoomCreateSchema, ({ name }) => {
      this.assertConnectRate(socket, session);
      const { room, seat } = this.store.createRoom(name);
      const ctx = this.store.contextFor(room, seat, null);
      this.attach(socket, session, ctx);
      socket.emit('room:joined', {
        roomCode: room.code,
        sessionToken: seat.sessionToken, // SECRET — unicast only (D27)
        playerId: seat.id,
        isSpectator: false,
        isHost: seat.id === room.hostId,
        resumed: false,
        view: this.store.viewFor(ctx),
      });
    });

    on('room:join', RoomJoinSchema, ({ roomCode, name, sessionToken }) => {
      this.assertConnectRate(socket, session);
      let ctx: AuthContext;
      let resumed = false;
      try {
        const res = this.store.joinRoom(roomCode, name, sessionToken);
        ctx = this.store.contextFor(res.room, res.seat, res.spectator);
        resumed = res.resumed;
      } catch (err) {
        // S7: a full room offers the spectator fallback instead of a dead end.
        if (isStoreError(err, 'ROOM_FULL')) {
          const room = this.store.getRoom(roomCode);
          if (!room) throw err;
          const spectator = this.store.addSpectator(room, name);
          ctx = this.store.contextFor(room, null, spectator);
        } else {
          throw err;
        }
      }
      this.attach(socket, session, ctx);
      const seat = ctx.seat;
      socket.emit('room:joined', {
        roomCode: ctx.room.code,
        sessionToken: seat ? seat.sessionToken : (ctx.spectator?.sessionToken ?? ''),
        playerId: seat ? seat.id : null,
        isSpectator: !seat,
        isHost: seat ? seat.id === ctx.room.hostId : false,
        resumed,
        view: this.store.viewFor(ctx),
      });
      if (resumed && seat) {
        // S2 rehydration: personal snapshot with the resumed hand.
        socket.emit('your:seat', {
          roomCode: ctx.room.code,
          playerId: seat.id,
          isHost: seat.id === ctx.room.hostId,
          view: this.store.viewFor(ctx),
        });
      }
    });

    on('room:leave', RoomLeaveSchema, ({ roomCode }) => {
      const ctx = this.requireCtx(socket, session, 'room:leave');
      if (ctx.room.code !== roomCode) {
        this.fail(socket, 'room:leave', 'NOT_IN_ROOM', 'You are not in that room.');
        return;
      }
      if (ctx.seat) this.store.leaveRoom(roomCode, ctx.seat.id);
      // Spectators just detach below.
      this.detach(socket, session);
    });

    on('room:list-players', RoomListPlayersSchema, ({ roomCode }) => {
      const room = this.store.getRoom(roomCode);
      if (!room) {
        this.fail(socket, 'room:list-players', 'ROOM_NOT_FOUND', `No room with code ${roomCode}.`);
        return;
      }
      socket.emit('room:players', this.playerList(room));
    });

    on('game:start', GameStartSchema, ({ roomCode }) => {
      const { room, seat } = this.requireSeat(socket, session, 'game:start', roomCode);
      this.store.startGame(room, seat); // lobby-only; no lock contention (S10 note)
    });

    on('game:again', GameAgainSchema, ({ roomCode }) => {
      const { room, seat } = this.requireSeat(socket, session, 'game:again', roomCode);
      this.runExclusive(room, () => this.store.playAgain(room, seat)).catch((e) => this.relayError(socket, 'game:again', e));
    });

    on('game:play-card', GamePlayCardSchema, ({ roomCode, cardId }) => {
      const { room, seat } = this.requireSeat(socket, session, 'game:play-card', roomCode);
      // S10: card plays serialize per room. Errors relay to this socket only (S5).
      this.runExclusive(room, () => this.store.playCard(room, seat, cardId)).catch((e) =>
        this.relayError(socket, 'game:play-card', e),
      );
    });

    on('game:challenge', GameChallengeSchema, ({ roomCode, accusedId }) => {
      const { room, seat } = this.requireSeat(socket, session, 'game:challenge', roomCode);
      // E7 mode (b): the engine stays silent unless the challenge SUCCEEDS
      // (loser pinned). The boolean result is unicast so the challenger's UI
      // can react; the resulting state broadcast is the public evidence.
      this.runExclusive(room, () => this.store.challenge(room, seat, accusedId))
        .then((succeeded) => {
          socket.emit('challenge:result', { roomCode, accusedId, succeeded });
        })
        .catch((e) => this.relayError(socket, 'game:challenge', e));
    });

    socket.on('disconnect', () => {
      this.detach(socket, session);
    });
  }

  // -- attach / detach ----------------------------------------------------------

  /** Bind a socket to its (fresh or resumed) room context. */
  private attach(socket: Socket, session: SocketSession, ctx: AuthContext): void {
    session.ctx = ctx;
    this.store.bindSocket(socket.id, ctx);
    socket.join(ctx.room.code);
  }

  /** Drop the socket's context (leave or disconnect); store cleanup runs too. */
  private detach(socket: Socket, session: SocketSession): void {
    this.store.socketLeft(socket.id); // idempotent; fires grace/close timers
    session.ctx = null;
    this.sessions.delete(socket.id);
  }

  // -- auth guards (throw Handled after already responding) ----------------------

  private requireCtx(socket: Socket, session: SocketSession, event: ClientEvent): AuthContext {
    const ctx = session.ctx;
    if (!ctx) {
      this.fail(socket, event, 'NOT_IN_ROOM', 'Join a room first.');
      throw new Handled();
    }
    return ctx;
  }

  private requireSeat(socket: Socket, session: SocketSession, event: ClientEvent, roomCode: string): { room: Room; seat: Seat } {
    const ctx = this.requireCtx(socket, session, event);
    if (ctx.room.code !== roomCode || !ctx.seat) {
      this.fail(socket, event, 'NOT_SEATED', 'You are not seated in that room.');
      throw new Handled();
    }
    return { room: ctx.room, seat: ctx.seat };
  }

  /** S6: space out room:create/join floods per socket. */
  private assertConnectRate(socket: Socket, session: SocketSession): void {
    const now = this.clock.now();
    if (now - session.lastConnectOpAt < this.opts.connectRateLimitMs) {
      this.fail(socket, 'room:create/join', 'RATE_LIMITED', 'Too many room operations — slow down.');
      throw new Handled();
    }
    session.lastConnectOpAt = now;
  }

  // -- S10: per-room mutation serialization ---------------------------------------

  /**
   * Run `fn` only after every previously queued mutation for this room has
   * settled. Socket.IO dispatches events sequentially per socket, but two
   * sockets in one room interleave — this restores total order per room.
   */
  private runExclusive<T>(room: Room, fn: () => T): Promise<T> {
    const prev = this.roomChains.get(room.code) ?? Promise.resolve();
    const next = prev.then(fn); // rejections must NOT stall the chain
    this.roomChains.set(
      room.code,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -- errors -------------------------------------------------------------------

  /** S5: errors NEVER broadcast — unicast to the offending socket only. */
  private fail(socket: Socket, event: string, code: ErrorCode, message: string, issues?: ErrorPayload['issues']): void {
    const payload: ErrorPayload = { event, code, message, ...(issues ? { issues } : {}) };
    socket.emit('error', payload);
  }

  private relayError(socket: Socket, event: string, err: unknown): void {
    if (err instanceof Handled) return; // fail() already responded
    if (isCodedError(err)) {
      this.fail(socket, event, err.code as ErrorCode, err.message);
      return;
    }
    // Unknown errors: log server-side, send a non-leaking generic message (S5).
    console.error(`[kazhuta] unhandled error on ${event}:`, err);
    this.fail(socket, event, 'INTERNAL', 'Internal error — try again.');
  }

  // -- fanout ---------------------------------------------------------------------

  /** Push fresh per-socket views + derived events after a room mutation. */
  private fanout(room: Room): void {
    // A listener emission for a room no longer in the store = GC'd (S3 close).
    if (!this.store.getRoom(room.code)) {
      this.announceRoomClosed(room);
      return;
    }

    // Per-socket redacted views (S5): each socket gets a view computed FOR it.
    for (const s of this.io.sockets.sockets.values()) {
      const session = this.sessions.get(s.id);
      const ctx = session?.ctx;
      if (!ctx || ctx.room.code !== room.code) continue;
      s.emit('state', {
        roomCode: room.code,
        view: this.store.viewFor(ctx),
        isHost: ctx.seat ? ctx.seat.id === room.hostId : false,
      });
    }

    this.io.to(room.code).emit('room:players', this.playerList(room));
    this.emitConnectionDeltas(room);

    // Round-resolution event (captured by the store during the mutation, D22).
    const lr = room.lastResolution;
    if (lr) {
      room.lastResolution = null; // emit-once
      const payload: RoundResolvedPayload = {
        roomCode: room.code,
        resolvedRoundNumber: lr.resolvedRoundNumber,
        hadStrike: lr.hadStrike,
        cardsInPile: lr.cardsInPile,
        nextLeaderId: lr.nextLeaderId,
      };
      this.io.to(room.code).emit('game:round-resolved', payload);
    }

    const phase = room.state?.phase;
    if (phase === 'game-over' && !this.gameOverEmitted.has(room.code)) {
      this.gameOverEmitted.add(room.code);
      const payload: GameOverPayload = { roomCode: room.code, loserId: room.state?.loserId ?? null };
      this.io.to(room.code).emit('game:over', payload);
    } else if (phase === 'in-round') {
      this.gameOverEmitted.delete(room.code); // rematch resets the latch
    }
  }

  /** player:connected / player:disconnected only on actual state changes. */
  private emitConnectionDeltas(room: Room): void {
    const now = new Set(room.seats.filter((s) => s.connected && s.socketIds.size > 0).map((s) => s.id));
    const prev = this.lastConnected.get(room.code);
    this.lastConnected.set(room.code, now);
    if (!prev) return; // first fanout for this room: players list suffices
    const conn = (seatId: string, connected: boolean): void => {
      const seat = room.seats.find((s) => s.id === seatId);
      if (!seat) return;
      const payload: PlayerConnectionPayload = { roomCode: room.code, playerId: seat.id, name: seat.name };
      this.io.to(room.code).emit(connected ? 'player:connected' : 'player:disconnected', payload);
    };
    for (const id of now) if (!prev.has(id)) conn(id, true);
    for (const id of prev) if (!now.has(id)) conn(id, false);
  }

  private playerList(room: Room): PlayerListPayload {
    return {
      roomCode: room.code,
      phase: room.state?.phase ?? 'not-started',
      players: room.seats.map((s, i) => ({
        playerId: s.id,
        name: s.name,
        seat: i,
        connected: s.connected && s.socketIds.size > 0,
        isHost: s.id === room.hostId,
        cardCount: room.state ? (room.state.hands[s.id]?.length ?? 0) : 0,
      })),
      spectatorCount: room.spectators.length,
    };
  }

  /** room:closed originates from the store's GC timer (not a mutation emit). */
  private announceRoomClosed(room: Room): void {
    const payload: RoomClosedPayload = { roomCode: room.code, reason: 'empty' };
    this.io.to(room.code).emit('room:closed', payload);
    // Any socket still pointing at the dead room loses its context.
    for (const [socketId, session] of this.sessions) {
      if (session.ctx?.room.code === room.code) {
        session.ctx = null;
        const s = this.io.sockets.sockets.get(socketId);
        if (s) s.leave(room.code);
      }
    }
    this.lastConnected.delete(room.code);
    this.gameOverEmitted.delete(room.code);
    this.roomChains.delete(room.code);
  }
}

/** Internal control-flow marker: the error was already delivered to the socket. */
class Handled extends Error {}

/**
 * True for StoreError and engine PlayError — both carry a `code` that is a
 * member of ErrorCode, so either can be relayed verbatim (E8).
 */
function isCodedError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string';
}

function isStoreError(err: unknown, code: ErrorCode): boolean {
  return (
    err instanceof Error &&
    err.name === 'StoreError' &&
    'code' in err &&
    (err as StoreError).code === code
  );
}

function zIssues(parsed: {
  error?: { issues: Array<{ path: ReadonlyArray<string | number | symbol>; message: string }> };
}): ErrorPayload['issues'] {
  if (!parsed.error) return undefined;
  return parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

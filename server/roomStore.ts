/**
 * Phase 2 room & session store — the server-side authority around the engine.
 *
 * Responsibilities (AGENTS.md Phase 2):
 *  - Rooms keyed by human-shareable code; one GameState per room; no cross-room
 *    leakage (AGENTS.md "Room & session model").
 *  - Session tokens are the ONLY control key: a socket may act on a seat only
 *    if it presents that seat's token (S2, D27). Player ids are public labels.
 *  - Disconnect grace timers that auto-play the player's lowest legal card
 *    when they expire (S1); host promotion (S3); room GC when empty (S3).
 *  - Every mutation funnels through here so the socket layer stays thin and
 *    the whole layer is unit-testable with a fake clock (D29).
 *
 * All wall-clock behavior is injected via `StoreClock` (now(), setTimeout,
 * clearTimeout) — production passes real timers, tests pass virtual ones.
 */
import {
  applyPlay,
  cardLabel,
  createGame,
  dealCards,
  findAceOfSpadesHolder,
  PlayError,
  resolveChallenge,
  toPlayerView,
  toPublicView,
  validatePlay,
  type Card,
  type CardId,
  type GameState,
  type PlayerId,
  type PlayerView,
  type PublicView,
  type Suit,
} from '../engine.js';
import type { ErrorCode } from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StoreError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Clock abstraction (D29)
// ---------------------------------------------------------------------------

export interface StoreClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers for production. */
export const realClock: StoreClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------
// Store options
// ---------------------------------------------------------------------------

export interface RoomStoreOptions {
  clock?: StoreClock;
  /** S1 grace before a disconnected player is auto-played (ms). */
  turnGraceMs?: number;
  /** S3: a room with no seated connections is closed after this long (ms). */
  emptyRoomTtlMs?: number;
  /** S6 companion: minimum ms between accepted actions from one seat. */
  minActionIntervalMs?: number;
  /** Cooldown between challenges from one seat (ms) — D31 challenge-spam guard. */
  challengeCooldownMs?: number;
}

export const DEFAULT_STORE_OPTIONS: Required<
  Omit<RoomStoreOptions, 'clock'>
> = {
  turnGraceMs: 90_000,
  emptyRoomTtlMs: 120_000,
  minActionIntervalMs: 250,
  challengeCooldownMs: 10_000,
};

/** Deliberately unambiguous alphabet: no 0/O, 1/I/L (D28). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/** Secret control key for a seat (D27). Stored client-side, never broadcast. */
export function newSessionToken(): string {
  // 24 bytes of CSPRNG → base64url ≈ 32 chars, unguessable.
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Room model
// ---------------------------------------------------------------------------

export interface Seat {
  id: PlayerId;
  name: string;
  /** Number of times this seat id has joined (public monotonic label, D32). */
  generation: number;
  /** The ONLY credential allowed to act for this seat (D27). */
  sessionToken: string;
  host: boolean;
  connected: boolean;
  /** Sockets currently authenticated for this seat (reconnects may stack). */
  socketIds: Set<string>;
  /** S1 grace timer handle while disconnected during a game. */
  graceTimer?: unknown;
  lastActionAt: number;
  lastChallengeAt: number;
}

export interface Spectator {
  socketId: string;
  name: string | null;
  sessionToken: string;
}

export interface Room {
  code: string;
  state: GameState | null;
  hostId: PlayerId | null;
  seats: Seat[];
  spectators: Spectator[];
  createdAt: number;
  emptySince: number | null;
  emptyTimer?: unknown;
  /** S1 auto-play audit trail (which card the server played and why). */
  autoPlays: Array<{ playerId: PlayerId; cardId: CardId; at: number }>;
  /**
   * Set by the last mutation if it resolved a round — consumed by the socket
   * layer's `game:round-resolved` broadcast, since by fanout time the room's
   * `round` is already the NEXT round (D22 auto-resolution).
   */
  lastResolution: null | {
    resolvedRoundNumber: number;
    hadStrike: boolean;
    cardsInPile: number;
    nextLeaderId: PlayerId | null;
  };
}

export type Listener = (room: Room) => void;

export interface AuthContext {
  room: Room;
  /** Seat if the socket controls one (via session token), else null. */
  seat: Seat | null;
  /** True when the socket is attached as a spectator. */
  spectator: Spectator | null;
}

// ---------------------------------------------------------------------------
// Engine bridge — the one place seat connectivity reaches client output
// ---------------------------------------------------------------------------

/**
 * Override view `players[].connected` from live Seat state.
 *
 * Deliberately NOT synced into state.players[] (D32): engine advanceTurn
 * reads p.connected and would skip offline holders, but roundComplete counts
 * all holders — skipping one mid-round would freeze the round forever. S1
 * semantics live in the store instead: an offline seat KEEPS receiving the
 * turn and is auto-played after the grace timer (D26/D30).
 */
function patchViewPresence(room: Room, view: PlayerView | PublicView): PlayerView | PublicView {
  for (const p of view.players) {
    const seat = room.seats.find((s) => s.id === p.id);
    if (seat) p.connected = seat.connected && seat.socketIds.size > 0;
  }
  return view;
}

/**
 * The card the server auto-plays for a timed-out player (S1): the lowest-rank
 * legal card, preferring following the active suit, never choosing a card that
 * would complete a losing collection when a legal follow exists (D30).
 */
function chooseAutoPlayCard(state: GameState, seat: Seat): CardId | null {
  const hand = state.hands[seat.id] ?? [];
  if (hand.length === 0) return null;
  const legal: Card[] = [];
  for (const c of hand) {
    try {
      validatePlay(state, seat.id, c.id);
      legal.push(c);
    } catch {
      /* illegal for this seat right now */
    }
  }
  if (legal.length === 0) return null;

  const activeSuit: Suit | null = state.round?.activeSuit ?? null;
  const followers = legal.filter((c) => activeSuit !== null && c.suit === activeSuit);
  const pool = followers.length > 0 ? followers : legal;
  return pool.reduce((low, c) => (c.rank < low.rank ? c : low)).id;
}

/** True if `cardId` is a strike for `playerId` right now (post-validate). */
function isStrike(state: GameState, playerId: PlayerId, cardId: CardId): boolean {
  const activeSuit = state.round?.activeSuit ?? null;
  if (!activeSuit) return false;
  const hand = state.hands[playerId] ?? [];
  const card = hand.find((c) => c.id === cardId);
  return !!card && card.suit !== activeSuit;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class RoomStore {
  private rooms = new Map<string, Room>();
  /** socketId → auth context cache, refreshed on every join/create. */
  private bySocket = new Map<string, AuthContext>();
  private listeners = new Set<Listener>();
  private readonly clock: StoreClock;
  private readonly opts: Required<Omit<RoomStoreOptions, 'clock'>>;

  constructor(options: RoomStoreOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.opts = { ...DEFAULT_STORE_OPTIONS, ...options } as Required<
      Omit<RoomStoreOptions, 'clock'>
    >;
  }

  get options(): Required<Omit<RoomStoreOptions, 'clock'>> & { clock: StoreClock } {
    return { ...this.opts, clock: this.clock };
  }

  /** Subscribe to post-mutation fanout events (views, round-resolved, over). */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Current room count (for /healthz). */
  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Graceful shutdown: cancel every pending timer so the process can exit.
   * Rooms are dropped without emitting (listeners are typically closing too).
   */
  dispose(): void {
    for (const room of this.rooms.values()) {
      if (room.emptyTimer) this.clock.clearTimeout(room.emptyTimer);
      for (const seat of room.seats) {
        if (seat.graceTimer) this.clock.clearTimeout(seat.graceTimer);
      }
    }
    this.rooms.clear();
    this.listeners.clear();
  }

  authForSocket(socketId: string): AuthContext | null {
    return this.bySocket.get(socketId) ?? null;
  }

  // -- room lifecycle -------------------------------------------------------

  createRoom(hostName: string): { room: Room; seat: Seat } {
    const code = this.allocateCode();
    const room: Room = {
      code,
      state: null,
      hostId: null,
      seats: [],
      spectators: [],
      createdAt: this.clock.now(),
      emptySince: null,
      autoPlays: [],
      lastResolution: null,
    };
    const seat = this.newSeat(room, hostName, true);
    room.hostId = seat.id;
    room.seats.push(seat);
    this.rooms.set(code, room);
    return { room, seat };
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new StoreError('INTERNAL', 'could not allocate a unique room code');
  }

  // -- join / resume / leave ------------------------------------------------

  /**
   * Join by code. With `sessionToken`, resumes the seat that owns the token
   * (S2) — hand, seat, host flag all preserved; a never-seen token re-joins as
   * a NEW seat instead (tokens are unguessable, guessing is not a threat).
   */
  joinRoom(code: string, name: string, sessionToken?: string): { room: Room; seat: Seat | null; spectator: Spectator | null; resumed: boolean } {
    const room = this.rooms.get(code);
    if (!room) throw new StoreError('ROOM_NOT_FOUND', `No room with code ${code}.`);

    if (sessionToken) {
      const existing = room.seats.find((s) => s.sessionToken === sessionToken);
      if (existing) {
        this.resume(room, existing);
        return { room, seat: existing, spectator: null, resumed: true };
      }
      // Token unknown in this room → treat as a fresh join below (D27: the
      // token's authority is scoped to the room that issued it).
    }

    if (room.seats.length >= 8) {
      // S7 — full room. Spectator fallback is offered by the socket layer.
      throw new StoreError('ROOM_FULL', 'This room already has 8 players.');
    }
    if (room.state && room.state.phase === 'in-round') {
      // Joining mid-game would need re-dealing; the UI offers spectate instead.
      throw new StoreError('GAME_IN_PROGRESS', 'Game already in progress — join as a spectator.');
    }

    const seat = this.newSeat(room, name, room.seats.length === 0); // S3: first joiner of a host-less room hosts
    room.seats.push(seat);
    room.emptySince = null;
    if (room.emptyTimer) {
      this.clock.clearTimeout(room.emptyTimer);
      room.emptyTimer = undefined;
    }
    return { room, seat, spectator: null, resumed: false };
  }

  /** S2: bring a disconnected seat back with hand and role intact. */
  private resume(room: Room, seat: Seat): void {
    seat.connected = true;
    if (seat.graceTimer) {
      this.clock.clearTimeout(seat.graceTimer);
      seat.graceTimer = undefined;
    }
    room.emptySince = null;
    if (room.emptyTimer) {
      this.clock.clearTimeout(room.emptyTimer);
      room.emptyTimer = undefined;
    }
  }

  /**
   * Detach a socket. If its seat loses its last socket mid-game, start the S1
   * grace timer (auto-play). If the room becomes fully empty, start the S3
   * close timer. Host-less lobbies promote immediately (S3).
   */
  socketLeft(socketId: string): void {
    const ctx = this.bySocket.get(socketId);
    this.bySocket.delete(socketId);
    if (!ctx) return;
    const { room, seat, spectator } = ctx;

    if (spectator) {
      room.spectators = room.spectators.filter((s) => s.socketId !== socketId);
    }
    if (seat) {
      seat.socketIds.delete(socketId);
      if (seat.socketIds.size === 0) {
        seat.connected = false;
        this.maybeStartGraceTimer(room, seat);
      }
    }
    this.refreshHost(room);
    this.maybeScheduleClose(room);
    this.emit(room);
  }

  /** Explicit room:leave — seat leaves permanently (not just disconnects). */
  leaveRoom(code: string, seatId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room) throw new StoreError('ROOM_NOT_FOUND', `No room with code ${code}.`);
    const seat = room.seats.find((s) => s.id === seatId);
    if (!seat) throw new StoreError('NOT_IN_ROOM', 'You are not seated in this room.');

    if (room.state && room.state.phase === 'in-round') {
      // Abandoning mid-game: treat as a disconnect so the hand stays for a
      // potential rejoin but the game can finish via auto-play (S1 semantics).
      seat.connected = false;
      seat.socketIds.clear();
      this.maybeStartGraceTimer(room, seat);
    } else {
      room.seats = room.seats.filter((s) => s.id !== seatId);
    }
    this.refreshHost(room);
    this.maybeScheduleClose(room);
    this.emit(room);
  }

  // -- host management (S3) ---------------------------------------------------

  private refreshHost(room: Room): void {
    const hostStillPresent =
      room.hostId !== null && room.seats.some((s) => s.id === room.hostId && s.socketIds.size > 0);
    if (hostStillPresent) return;

    const connected = room.seats.filter((s) => s.socketIds.size > 0);
    if (connected.length > 0) {
      const next = connected[0]!;
      const changed = room.hostId !== next.id;
      room.hostId = next.id;
      for (const s of room.seats) s.host = s.id === room.hostId;
      if (changed) room.state?.log.push({ seq: ++room.state.seq, message: `${next.name} is now the host.` });
    } else {
      room.hostId = null;
      for (const s of room.seats) s.host = false;
    }
  }

  /** Fresh seat with a unique public id (ids must be unique — engine D21). */
  private newSeat(room: Room, name: string, host: boolean): Seat {
    let id = newSessionToken().slice(0, 12);
    while (room.seats.some((s) => s.id === id)) id = newSessionToken().slice(0, 12);
    return {
      id,
      name,
      generation: 1,
      sessionToken: newSessionToken(),
      host,
      connected: true,
      socketIds: new Set(),
      lastActionAt: 0,
      lastChallengeAt: 0,
    };
  }

  // -- S1 grace timers --------------------------------------------------------

  /**
   * Systemic S1 safety net: whenever the turn rests on a disconnected seat
   * that holds cards and has no timer running, start one. Covers the hole
   * where the turn ARRIVES while the player is already offline (their original
   * grace timer, if any, already fired and auto-play found nothing legal).
   * Called after every mutation and on every fanout.
   */
  private ensureTurnTimers(room: Room): void {
    const state = room.state;
    if (!state || state.phase !== 'in-round') return;
    const turnSeat = state.currentTurnId
      ? room.seats.find((s) => s.id === state.currentTurnId)
      : undefined;
    if (!turnSeat) return;
    if (turnSeat.connected || turnSeat.socketIds.size > 0) return;
    if ((state.hands[turnSeat.id]?.length ?? 0) === 0) return;
    if (turnSeat.graceTimer) return;
    this.maybeStartGraceTimer(room, turnSeat);
  }

  private maybeStartGraceTimer(room: Room, seat: Seat): void {
    if (room.state === null || room.state.phase !== 'in-round') return;
    if ((room.state.hands[seat.id]?.length ?? 0) === 0) return; // nothing to auto-play
    if (seat.graceTimer) return; // already counting down
    seat.graceTimer = this.clock.setTimeout(() => {
      seat.graceTimer = undefined;
      this.autoPlayFor(room, seat);
    }, this.opts.turnGraceMs);
  }

  /** S1/D30: after the grace period, play the seat's chosen lowest legal card. */
  private autoPlayFor(room: Room, seat: Seat): void {
    const state = room.state;
    if (!state || state.phase !== 'in-round') return;
    if (seat.connected && seat.socketIds.size > 0) return; // reconnected meanwhile
    const cardId = chooseAutoPlayCard(state, seat);
    if (!cardId) return;
    try {
      this.mutatePlay(room, seat, cardId, /*auto*/ true);
    } catch {
      // Not their turn (or state moved on) — the next time the turn reaches
      // them while offline they'll get a fresh grace timer via turn advance.
    }
  }

  // -- S3 empty-room GC -------------------------------------------------------

  private maybeScheduleClose(room: Room): void {
    const anyoneConnected = room.seats.some((s) => s.socketIds.size > 0);
    if (anyoneConnected) {
      room.emptySince = null;
      if (room.emptyTimer) {
        this.clock.clearTimeout(room.emptyTimer);
        room.emptyTimer = undefined;
      }
      return;
    }
    if (room.emptySince === null) {
      room.emptySince = this.clock.now();
      room.emptyTimer = this.clock.setTimeout(() => {
        room.emptyTimer = undefined;
        // Only close if STILL empty.
        if (!room.seats.some((s) => s.socketIds.size > 0)) {
          this.rooms.delete(room.code);
          this.emitClosed(room);
        }
      }, this.opts.emptyRoomTtlMs);
    }
  }

  private emitClosed(room: Room): void {
    for (const l of this.listeners) l(room);
  }

  // -- mutations (all validated, all serialized by the caller — S10) ---------

  /** S8 + engine D21 backstop: host-only, 3–8 seated, lobby-only. */
  startGame(room: Room, seat: Seat): void {
    if (room.hostId !== seat.id) throw new StoreError('NOT_HOST', 'Only the host can start the game.');
    if (room.state && room.state.phase === 'in-round') {
      throw new StoreError('GAME_IN_PROGRESS', 'A game is already in progress.');
    }
    if (room.seats.length < 3) {
      throw new StoreError('NOT_ENOUGH_PLAYERS', 'Kazhutakali needs at least 3 players.');
    }
    if (room.seats.length > 8) {
      throw new StoreError('ROOM_FULL', 'Rooms hold at most 8 players.');
    }

    const dealerIndex = room.state ? (room.state.dealerIndex + 1) % room.seats.length : 0; // E6 rotation
    // Connectivity is synced by syncConnectivity() before every fanout.
    const state = createGame({
      players: room.seats.map((s) => ({ id: s.id, name: s.name })),
      dealerIndex,
    });
    dealCards(state);
    room.state = state;
    this.emit(room);
  }

  /** E6: fresh game, same seats, dealer rotates anticlockwise. */
  playAgain(room: Room, seat: Seat): void {
    if (room.hostId !== seat.id) throw new StoreError('NOT_HOST', 'Only the host can start a rematch.');
    if (!room.state || room.state.phase !== 'game-over') {
      throw new StoreError('NO_ACTIVE_GAME', 'Rematch requires a finished game.');
    }
    this.startGame(room, seat);
  }

  /**
   * Play a card for a seat. Validates possession/turn via the engine (S5, E8);
   * `applyPlay` auto-resolves completing rounds (D22). NEVER throws on engine
   * rejection without leaving state untouched (validate-then-mutate in engine).
   */
  playCard(room: Room, seat: Seat, cardId: CardId): void {
    this.assertNotRateLimited(seat);
    this.mutatePlay(room, seat, cardId, false);
  }

  private mutatePlay(room: Room, seat: Seat, cardId: CardId, auto: boolean): void {
    const state = room.state;
    if (!state) throw new StoreError('NO_ACTIVE_GAME', 'No game has started in this room.');
    if (state.phase === 'game-over') throw new StoreError('GAME_OVER', 'The game is over.');
    if (state.phase !== 'in-round') throw new StoreError('NO_ACTIVE_GAME', 'No round in progress.');
    if (!seat.socketIds.size && !auto) {
      throw new StoreError('NOT_SEATED', 'Socket is not authenticated for this seat.');
    }

    // Catch frozen rounds caused by an offline holder that never reconnects:
    // if the turn is on an offline seat, auto-play for THEM first (D26).
    const turnSeat = state.currentTurnId ? room.seats.find((s) => s.id === state.currentTurnId) : undefined;
    if (turnSeat && !turnSeat.connected && turnSeat.id !== seat.id) {
      const fallback = chooseAutoPlayCard(state, turnSeat);
      if (fallback) {
        try {
          this.applyAndCapture(room, turnSeat.id, fallback);
          room.autoPlays.push({ playerId: turnSeat.id, cardId: fallback, at: this.clock.now() });
          this.emit(room);
          // fall through: the requesting seat may now legitimately act.
        } catch {
          // Offline seat's fallback no longer legal — ignore; engine state is
          // untouched (validate-then-mutate).
        }
      }
    }

    this.applyAndCapture(room, seat.id, cardId);
    seat.lastActionAt = this.clock.now();
    if (auto) room.autoPlays.push({ playerId: seat.id, cardId, at: this.clock.now() });
    this.emit(room);
  }

  /**
    * One validated engine mutation + round-resolution capture.
    * PlayError propagates to the caller (relayed verbatim by the socket layer, E8).
    */
  private applyAndCapture(room: Room, playerId: PlayerId, cardId: CardId): void {
    const state = room.state;
    if (!state) throw new StoreError('NO_ACTIVE_GAME', 'No game has started in this room.');
    const before = {
      roundNumber: state.roundNumber,
      hadStrike: state.round?.plays.some((pl) => pl.strikeDeclared) ?? false,
      pileSize: state.round?.plays.length ?? 0,
    };
    applyPlay(state, playerId, cardId); // validates + mutates + auto-resolves (D22)
    if (state.roundNumber > before.roundNumber) {
      room.lastResolution = {
        resolvedRoundNumber: before.roundNumber,
        hadStrike: before.hadStrike,
        cardsInPile: before.pileSize,
        nextLeaderId: state.currentTurnId,
      };
    }
  }

  /** E7 mode (b) / D10–D12: challenge another seated player. */
  challenge(room: Room, seat: Seat, accusedId: PlayerId): boolean {
    this.assertNotRateLimited(seat);
    const state = room.state;
    if (!state) throw new StoreError('NO_ACTIVE_GAME', 'No game has started in this room.');
    const now = this.clock.now();
    if (now - seat.lastChallengeAt < this.opts.challengeCooldownMs) {
      throw new StoreError('CHALLENGE_COOLDOWN', 'Challenge attempts are rate-limited.');
    }
    seat.lastChallengeAt = now;
    const succeeded = resolveChallenge(state, seat.id, accusedId); // PlayError relayed
    this.emit(room);
    return succeeded;
  }

  private assertNotRateLimited(seat: Seat): void {
    const now = this.clock.now();
    if (now - seat.lastActionAt < this.opts.minActionIntervalMs) {
      throw new StoreError('RATE_LIMITED', 'Slow down — actions are rate-limited.');
    }
  }

  // -- views ------------------------------------------------------------------

  /** Per-socket redacted view (S5/AGENTS.md security principle). */
  viewFor(ctx: AuthContext): PlayerView | PublicView {
    const { room, seat } = ctx;
    if (!room.state) return this.lobbyView(room);
    if (seat) return patchViewPresence(room, toPlayerView(room.state, seat.id));
    return patchViewPresence(room, toPublicView(room.state));
  }

  private lobbyView(room: Room): PublicView {
    return {
      phase: 'not-started',
      roundNumber: 0,
      players: room.seats.map((s) => ({
        id: s.id,
        seat: room.seats.indexOf(s),
        name: s.name,
        connected: s.socketIds.size > 0,
        cardCount: 0,
      })),
      currentTurnId: null,
      activeSuit: null,
      playedThisRoundCount: 0,
      discardCount: 0,
      forfeitedCount: 0,
      loserId: null,
      log: [],
    };
  }

  /** Player list including connection + host flags (for the lobby UI). */
  playerList(room: Room): {
    roomCode: string;
    phase: 'not-started' | 'in-round' | 'game-over';
    players: Array<{ playerId: PlayerId; name: string; seat: number; connected: boolean; isHost: boolean; cardCount: number }>;
    spectatorCount: number;
  } {
    return {
      roomCode: room.code,
      phase: room.state?.phase ?? 'not-started',
      players: room.seats.map((s, i) => ({
        playerId: s.id,
        name: s.name,
        seat: i,
        connected: s.socketIds.size > 0,
        isHost: s.id === room.hostId,
        cardCount: room.state?.hands[s.id]?.length ?? 0,
      })),
      spectatorCount: room.spectators.length,
    };
  }

  /** Who holds the Ace of Spades right now (pre-deal n/a). */
  aceHolder(room: Room): PlayerId | null {
    if (!room.state || room.state.phase === 'not-started') return null;
    try {
      return findAceOfSpadesHolder(room.state);
    } catch {
      return null;
    }
  }

  /** How many cards are in the current pile (for round-resolved payloads). */
  pileSize(room: Room): number {
    return room.state?.round?.plays.length ?? 0;
  }

  /** Did the round that just resolved contain a strike? (socket layer reads before resolution) */
  roundHadStrike(state: GameState): boolean {
    return state.round?.plays.some((pl) => pl.strikeDeclared) ?? false;
  }

  // -- socket auth ------------------------------------------------------------

  /** Bind a socket to a room context after create/join. Rebinds are allowed. */
  bindSocket(socketId: string, ctx: AuthContext): void {
    this.bySocket.set(socketId, ctx);
    if (ctx.seat) {
      ctx.seat.socketIds.add(socketId);
      ctx.seat.connected = true;
      if (ctx.seat.graceTimer) {
        this.clock.clearTimeout(ctx.seat.graceTimer);
        ctx.seat.graceTimer = undefined;
      }
      this.refreshHost(ctx.room);
      this.maybeScheduleClose(ctx.room);
    }
    if (ctx.spectator) {
      ctx.spectator.socketId = socketId; // needed for socketLeft cleanup
      if (!ctx.room.spectators.some((s) => s.socketId === socketId)) {
        ctx.room.spectators.push(ctx.spectator);
      }
    }
    this.emit(ctx.room);
  }

  /** Locate the seat owning `token` in `code` — used for game:play-card etc. */
  seatByToken(code: string, token: string): Seat {
    const room = this.rooms.get(code);
    if (!room) throw new StoreError('ROOM_NOT_FOUND', `No room with code ${code}.`);
    const seat = room.seats.find((s) => s.sessionToken === token);
    if (!seat) throw new StoreError('NOT_SEATED', 'This session token does not control a seat in this room.');
    return seat;
  }

  /** First-auth context for a socket that just created/joined/resumed. */
  contextFor(room: Room, seat: Seat | null, spectator: Spectator | null): AuthContext {
    return { room, seat, spectator };
  }

  addSpectator(room: Room, name: string | null): Spectator {
    const spectator: Spectator = { socketId: '', name, sessionToken: newSessionToken() };
    room.spectators.push(spectator);
    return spectator;
  }

  // -- fanout -----------------------------------------------------------------

  private emit(room: Room): void {
    this.ensureTurnTimers(room);
    for (const l of this.listeners) l(room);
  }
}

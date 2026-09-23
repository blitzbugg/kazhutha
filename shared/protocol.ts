/**
 * Wire protocol shared by the Socket.IO server and the browser client (D40).
 *
 * Deliberately dependency-free: the client bundle must not pull in zod or the
 * socket.io server, and the server must not pull in React. Only event-name
 * unions and plain payload interfaces live here.
 *
 * Inbound payload *schemas* (zod) stay in `server/types.ts` — validation is
 * server-side only (AGENTS.md S9); the client mirrors the engine's play rules
 * in `client/rules.ts` purely for UX, never as an authority.
 */

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Errors (server → client `error` event, S5: never broadcast)
// ---------------------------------------------------------------------------

export type ErrorCode =
  // transport-layer rejections (server/index.ts)
  | 'BAD_PAYLOAD'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  // room-store rejections (server/roomStore.ts)
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'NOT_HOST'
  | 'GAME_IN_PROGRESS'
  | 'NO_ACTIVE_GAME'
  | 'NOT_SEATED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'CHALLENGE_COOLDOWN'
  // engine rejections relayed verbatim (E8) — mirrors engine PlayErrorCode
  | 'GAME_OVER'
  | 'NOT_YOUR_TURN'
  | 'CARD_NOT_IN_HAND'
  | 'MUST_LEAD_ACE_OF_SPADES'
  | 'INVALID_PAYLOAD';

export interface ErrorPayload {
  event: string;
  code: ErrorCode;
  message: string;
  issues?: Array<{ path: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Outbound payloads (server → client)
// ---------------------------------------------------------------------------

/** Sent once on connection so clients can mirror server timing policy. */
export interface HelloPayload {
  turnGraceMs: number;
  emptyRoomTtlMs: number;
  challengeCooldownMs: number;
  minActionIntervalMs: number;
}

/** Unicast on successful room:create / room:join / session resume. */
export interface RoomJoinedPayload {
  roomCode: string;
  /** SECRET — persist client-side for reconnects (S2). */
  sessionToken: string;
  /** PUBLIC id of your seat (null for spectators). */
  playerId: string | null;
  isSpectator: boolean;
  isHost: boolean;
  resumed: boolean;
  view: unknown; // PublicView (lobby / spectator) or PlayerView (seated)
}

export interface PlayerListEntry {
  playerId: string;
  name: string;
  seat: number;
  connected: boolean;
  isHost: boolean;
  cardCount: number;
}

export interface PlayerListPayload {
  roomCode: string;
  phase: 'not-started' | 'in-round' | 'game-over';
  players: PlayerListEntry[];
  spectatorCount: number;
}

export interface RoundResolvedPayload {
  roomCode: string;
  /** Round number that just finished. */
  resolvedRoundNumber: number;
  hadStrike: boolean;
  /** Cards that were on the table when the round resolved. */
  cardsInPile: number;
  nextLeaderId: string | null;
}

export interface GameOverPayload {
  roomCode: string;
  /** null ⇒ every hand emptied simultaneously; no Kazhuta (D19). */
  loserId: string | null;
}

export interface PlayerConnectionPayload {
  roomCode: string;
  playerId: string;
  name: string;
}

export interface RoomClosedPayload {
  roomCode: string;
  reason: 'empty';
}

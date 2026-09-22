/**
 * Phase 2 socket contracts — inbound payload schemas (S9) and shared types.
 *
 * Every inbound event is validated with zod BEFORE any game state is touched:
 * client JSON shape is never trusted (AGENTS.md S9). Outbound payload shapes
 * are documented here so the Phase 3 client and the server stay in sync.
 *
 * Identity model (DECISIONS.md D27):
 *  - `sessionToken` — SECRET, server-generated, stored client-side; grants
 *    control of a seat. Never appears in views, logs or broadcasts.
 *  - `playerId` — PUBLIC opaque id (a seat's stable identity across
 *    reconnects); safe to include in views and challenge payloads.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** Display name only — duplicates allowed, never an identity key (S4). */
export const PlayerNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/\S/, 'name must contain a non-whitespace character');

/** 5 chars from an unambiguous alphabet (no I/O/0/1) — DECISIONS.md D28. */
export const RoomCodeSchema = z
  .string()
  .regex(/^[A-HJ-NP-Z2-9]{5}$/, 'room codes are 5 characters from A-HJ-NP-Z2-9');

/** Secret, long, URL-safe token issued by the server (D27). */
export const SessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

/** Public opaque player id (D27). */
export const PlayerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);

/** Mirrors the engine's card-id grammar (engine validatePlay enforces the same). */
export const CardIdSchema = z
  .string()
  .regex(/^[CDHS](?:[2-9]|1[0-4])$/, 'card ids look like "H7" or "S14"');

// ---------------------------------------------------------------------------
// Inbound event payloads (client → server)
// ---------------------------------------------------------------------------

export const RoomCreateSchema = z.object({ name: PlayerNameSchema });
export const RoomJoinSchema = z.object({
  roomCode: RoomCodeSchema,
  name: PlayerNameSchema,
  /** Present ⇒ attempt to rehydrate an existing seat (S2) instead of new join. */
  sessionToken: SessionTokenSchema.optional(),
});
export const RoomLeaveSchema = z.object({ roomCode: RoomCodeSchema });
export const RoomListPlayersSchema = z.object({ roomCode: RoomCodeSchema });
export const GameStartSchema = z.object({ roomCode: RoomCodeSchema });
/** Host-only rematch: fresh game, same seats, dealer rotates (E6). */
export const GameAgainSchema = z.object({ roomCode: RoomCodeSchema });
export const GamePlayCardSchema = z.object({ roomCode: RoomCodeSchema, cardId: CardIdSchema });
/** E7 mode (b): challenger accuses `accusedId` of a false strike (D10–D12). */
export const GameChallengeSchema = z.object({ roomCode: RoomCodeSchema, accusedId: PlayerIdSchema });

// ---------------------------------------------------------------------------
// Error codes (server → client `error` event, S5: never broadcast)
// ---------------------------------------------------------------------------

export type ErrorCode =
  // transport-layer rejections (socket/index.ts)
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
  | 'GAME_OVER'
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
// Outbound event payloads (server → client)
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

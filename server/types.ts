/**
 * Phase 2 socket contracts — inbound payload schemas (S9).
 *
 * Every inbound event is validated with zod BEFORE any game state is touched:
 * client JSON shape is never trusted (AGENTS.md S9). Outbound payload shapes
 * live in ../shared/protocol.ts (D40) — the single source of truth shared with
 * the Phase 3 browser client.
 *
 * Identity model (DECISIONS.md D27):
 *  - `sessionToken` — SECRET, server-generated, stored client-side; grants
 *    control of a seat. Never appears in views, logs or broadcasts.
 *  - `playerId` — PUBLIC opaque id (a seat's stable identity across
 *    reconnects); safe to include in views and challenge payloads.
 */
import { z } from 'zod';

// Outbound payload/error types re-exported from the shared protocol module so
// existing server imports (roomStore, index) keep working unchanged (D40).
export type {
  ErrorCode,
  ErrorPayload,
  HelloPayload,
  RoomJoinedPayload,
  PlayerListEntry,
  PlayerListPayload,
  RoundResolvedPayload,
  GameOverPayload,
  PlayerConnectionPayload,
  RoomClosedPayload,
} from '../shared/protocol.js';

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
// Outbound payload shapes + error codes live in ../shared/protocol.ts (D40)
// and are re-exported at the top of this file for server-internal use.
// ---------------------------------------------------------------------------
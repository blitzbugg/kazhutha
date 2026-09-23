/**
 * Phase 3 client state — a single reducer fed exclusively by server events
 * (D42). The client never mutates game state; it renders the server's
 * redacted view and mirrors play rules purely for UX (client/rules.ts).
 */
import type { PlayerView, PublicView } from '../engine.js';
import type { ErrorCode, HelloPayload, PlayerListPayload } from '../shared/protocol.js';

export type AnyView = PlayerView | PublicView;

export function isPlayerView(view: AnyView | null | undefined): view is PlayerView {
  return view != null && 'yourHand' in view;
}

export interface SelfInfo {
  playerId: string | null;
  isSpectator: boolean;
  isHost: boolean;
}

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  text: string;
}

export type ConnectionState = 'connecting' | 'online' | 'reconnecting';

/** Normalized seat shape merged from the players payload or an engine view. */
export interface SeatLike {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
  cardCount: number;
  isHost: boolean;
}

export interface AppState {
  connection: ConnectionState;
  hello: HelloPayload | null;
  name: string;
  joinCode: string;
  /** True between emitting room:create/join and receiving room:joined. */
  joining: boolean;
  roomCode: string | null;
  self: SelfInfo | null;
  view: AnyView | null;
  players: PlayerListPayload | null;
  toasts: Toast[];
  challengeInFlight: boolean;
  /** Epoch ms until which the challenge button stays disabled (D31). */
  challengeCooldownUntil: number;
  lastChallenge: { accusedId: string; succeeded: boolean } | null;
}

export const initialState: AppState = {
  connection: 'connecting',
  hello: null,
  name: '',
  joinCode: '',
  joining: false,
  roomCode: null,
  self: null,
  view: null,
  players: null,
  toasts: [],
  challengeInFlight: false,
  challengeCooldownUntil: 0,
  lastChallenge: null,
};

export type Action =
  | { type: 'hello'; hello: HelloPayload }
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'setName'; name: string }
  | { type: 'setJoinCode'; code: string }
  | { type: 'joining' }
  | { type: 'joined'; roomCode: string; playerId: string | null; isSpectator: boolean; isHost: boolean; view: AnyView }
  | { type: 'view'; view: AnyView; isHost: boolean }
  | { type: 'players'; players: PlayerListPayload }
  | { type: 'toast'; kind: Toast['kind']; text: string }
  | { type: 'dismissToast'; id: number }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'roomClosed'; reason: string }
  | { type: 'challengeSent' }
  | { type: 'challengeResult'; accusedId: string; succeeded: boolean }
  | { type: 'leftRoom' };

let toastSeq = 0;
const nextToastId = (): number => ++toastSeq;

const MAX_TOASTS = 4;

function pushToast(toasts: Toast[], kind: Toast['kind'], text: string): Toast[] {
  const next = [...toasts, { id: nextToastId(), kind, text }];
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
}

function resetRoom(state: AppState): AppState {
  return {
    ...state,
    joining: false,
    roomCode: null,
    self: null,
    view: null,
    players: null,
    challengeInFlight: false,
    challengeCooldownUntil: 0,
    lastChallenge: null,
  };
}

/** S5: server error codes map to friendly, non-leaking client text. */
const ERROR_TEXT: Record<string, string> = {
  BAD_PAYLOAD: 'That action was malformed — please retry.',
  RATE_LIMITED: 'Slow down a little — too many actions, too fast.',
  INTERNAL: 'Something went wrong on the server — please retry.',
  ROOM_NOT_FOUND: 'No room with that code (it may have closed).',
  ROOM_FULL: 'That room is full — you joined as a spectator.',
  ALREADY_IN_ROOM: 'You are already in a room.',
  NOT_IN_ROOM: 'You are not in a room.',
  NOT_HOST: 'Only the host can do that.',
  GAME_IN_PROGRESS: 'A game is already running in that room — join as a spectator.',
  NO_ACTIVE_GAME: 'No game has been started in that room yet.',
  GAME_OVER: 'The game is already over.',
  NOT_SEATED: 'You are not seated in that room.',
  NOT_ENOUGH_PLAYERS: 'Kazhutakali needs at least 3 players.',
  CHALLENGE_COOLDOWN: 'Wait a few seconds before challenging again.',
  NOT_YOUR_TURN: "It's not your turn.",
  CARD_NOT_IN_HAND: "You don't hold that card.",
  MUST_LEAD_ACE_OF_SPADES: 'Round 1 must open with the Ace of Spades.',
  INVALID_PAYLOAD: 'That action was rejected.',
};

export function errorText(code: string, message: string): string {
  return ERROR_TEXT[code] ?? message;
}

/** Seats merged from the freshest source available (players payload, else view). */
export function seatList(state: AppState): SeatLike[] {
  const fromPayload = state.players?.players;
  if (fromPayload !== undefined) {
    return fromPayload.map((p) => ({
      id: p.playerId,
      name: p.name,
      seat: p.seat,
      connected: p.connected,
      cardCount: p.cardCount,
      isHost: p.isHost,
    }));
  }
  return (state.view?.players ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    connected: p.connected,
    cardCount: p.cardCount,
    isHost: false,
  }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'hello':
      return { ...state, hello: action.hello };
    case 'connection':
      return { ...state, connection: action.connection };
    case 'setName':
      return { ...state, name: action.name };
    case 'setJoinCode':
      return { ...state, joinCode: action.code };
    case 'joining':
      return { ...state, joining: true };
    case 'joined':
      return {
        ...state,
        joining: false,
        roomCode: action.roomCode,
        self: { playerId: action.playerId, isSpectator: action.isSpectator, isHost: action.isHost },
        view: action.view,
        players: null,
        challengeInFlight: false,
        challengeCooldownUntil: 0,
        lastChallenge: null,
      };
    case 'view': {
      const self = state.self !== null ? { ...state.self, isHost: action.isHost } : state.self;
      return { ...state, self, view: action.view };
    }
    case 'players':
      return { ...state, players: action.players };
    case 'toast':
      return { ...state, toasts: pushToast(state.toasts, action.kind, action.text) };
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'error': {
      const text = errorText(action.code, action.message);
      if (action.code === 'ROOM_NOT_FOUND' && state.roomCode !== null) {
        // The room vanished under us (e.g. server restart, S12): go home.
        return { ...resetRoom(state), toasts: pushToast(state.toasts, 'error', text) };
      }
      return { ...state, joining: false, toasts: pushToast(state.toasts, 'error', text) };
    }
    case 'roomClosed':
      return {
        ...resetRoom(state),
        toasts: pushToast(state.toasts, 'info', 'Room closed — everyone left.'),
      };
    case 'challengeSent':
      return {
        ...state,
        challengeInFlight: true,
        challengeCooldownUntil: Date.now() + (state.hello?.challengeCooldownMs ?? 10_000),
      };
    case 'challengeResult': {
      const name = state.view?.players.find((p) => p.id === action.accusedId)?.name ?? action.accusedId;
      const text = action.succeeded
        ? `Challenge succeeded — ${name} is the Kazhuta!`
        : 'Challenge failed — no evidence of a false strike.';
      return {
        ...state,
        challengeInFlight: false,
        challengeCooldownUntil: Date.now() + (state.hello?.challengeCooldownMs ?? 10_000),
        lastChallenge: { accusedId: action.accusedId, succeeded: action.succeeded },
        toasts: pushToast(state.toasts, action.succeeded ? 'success' : 'info', text),
      };
    }
    case 'leftRoom':
      return resetRoom(state);
  }
}

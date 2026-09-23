/**
 * Socket lifecycle — the ONLY place the client talks to the server (D43).
 *
 * Reconnect/resume (S2, U5): on any transport reconnect with an active room,
 * the client re-emits room:join with the stored session token so the server
 * rehydrates the seat with its hand intact. A full page reload does NOT
 * auto-rejoin — the Home screen offers an explicit "Rejoin room <CODE>"
 * button instead (predictable against S12 server-restart data loss, D45).
 */
import { io, type Socket } from 'socket.io-client';
import type { ErrorPayload, HelloPayload, PlayerListPayload, RoomJoinedPayload, RoundResolvedPayload } from '../shared/protocol.js';
import { session } from './session';
import type { Action, AnyView } from './state';

type Dispatch = (action: Action) => void;

let socket: Socket | null = null;
let dispatchRef: Dispatch | null = null;

/** Room the page is seated in — drives transport-level resume (S2, U5). */
let active: { roomCode: string; name: string } | null = null;

export function getSocket(): Socket {
  if (socket === null) {
    const url = import.meta.env.VITE_SERVER_URL;
    socket = io(url !== undefined && url !== '' ? url : undefined, {
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
    });
  }
  return socket;
}

export function initSocket(dispatch: Dispatch): () => void {
  if (dispatchRef !== null) return () => undefined; // StrictMode double-effect guard
  dispatchRef = dispatch;
  const s = getSocket();

  s.on('connect', () => {
    dispatch({ type: 'connection', connection: 'online' });
    if (active !== null) {
      // Same-page resume: reattach the seat with its token (S2).
      const token = session.getToken(active.roomCode);
      s.emit(
        'room:join',
        token !== null
          ? { roomCode: active.roomCode, name: active.name, sessionToken: token }
          : { roomCode: active.roomCode, name: active.name },
      );
    }
  });
  s.on('disconnect', () => dispatch({ type: 'connection', connection: 'reconnecting' }));
  s.on('connect_error', () => {
    if (!s.connected) dispatch({ type: 'connection', connection: 'reconnecting' });
  });

  s.on('hello', (hello: HelloPayload) => dispatch({ type: 'hello', hello }));

  s.on('room:joined', (p: RoomJoinedPayload) => {
    const view = p.view as AnyView;
    active = { roomCode: p.roomCode, name: session.getName() };
    if (p.sessionToken !== '') session.setToken(p.roomCode, p.sessionToken);
    session.setLastRoom(p.roomCode);
    dispatch({
      type: 'joined',
      roomCode: p.roomCode,
      playerId: p.playerId,
      isSpectator: p.isSpectator,
      isHost: p.isHost,
      view,
    });
    if (p.resumed) {
      dispatch({ type: 'toast', kind: 'success', text: 'Reconnected — your seat and hand were restored.' });
    }
  });

  s.on('your:seat', (p: { roomCode: string; isHost: boolean; view: unknown }) => {
    if (active?.roomCode !== p.roomCode) return;
    dispatch({ type: 'view', view: p.view as AnyView, isHost: p.isHost });
  });

  s.on('state', (p: { roomCode: string; isHost: boolean; view: unknown }) => {
    if (active?.roomCode !== p.roomCode) return; // stale room context
    dispatch({ type: 'view', view: p.view as AnyView, isHost: p.isHost });
  });

  s.on('room:players', (p: PlayerListPayload) => {
    if (active?.roomCode !== p.roomCode) return;
    dispatch({ type: 'players', players: p });
  });

  s.on('game:round-resolved', (p: RoundResolvedPayload) => {
    void p; // No dedicated UI in Phase 3 — the table + log carry the info.
  });

  s.on('challenge:result', (p: { roomCode: string; accusedId: string; succeeded: boolean }) => {
    if (active?.roomCode !== p.roomCode) return;
    dispatch({ type: 'challengeResult', accusedId: p.accusedId, succeeded: p.succeeded });
  });

  s.on('error', (p: ErrorPayload) => {
    dispatch({ type: 'error', code: p.code, message: p.message });
  });

  s.on('room:closed', (p: { roomCode: string; reason: string }) => {
    if (active?.roomCode !== p.roomCode) return;
    active = null;
    session.clearToken(p.roomCode);
    dispatch({ type: 'roomClosed', reason: p.reason });
  });

  // The socket is an app-lifetime singleton; nothing to tear down on unmount.
  return () => undefined;
}

// ---------------------------------------------------------------------------
// Outbound actions (called from components)
// ---------------------------------------------------------------------------

export function createRoom(name: string): void {
  session.setName(name);
  dispatchRef?.({ type: 'joining' });
  getSocket().emit('room:create', { name });
}

export function joinRoom(rawCode: string, name: string): void {
  const roomCode = rawCode.trim().toUpperCase();
  session.setName(name);
  dispatchRef?.({ type: 'joining' });
  const token = session.getToken(roomCode);
  getSocket().emit(
    'room:join',
    token !== null ? { roomCode, name, sessionToken: token } : { roomCode, name },
  );
}

export function leaveRoom(roomCode: string): void {
  getSocket().emit('room:leave', { roomCode });
  active = null;
  session.clearToken(roomCode);
  dispatchRef?.({ type: 'leftRoom' });
}

export function startGame(roomCode: string): void {
  getSocket().emit('game:start', { roomCode });
}

export function playAgain(roomCode: string): void {
  getSocket().emit('game:again', { roomCode });
}

export function playCard(roomCode: string, cardId: string): void {
  getSocket().emit('game:play-card', { roomCode, cardId });
}

export function challenge(roomCode: string, accusedId: string): void {
  dispatchRef?.({ type: 'challengeSent' });
  getSocket().emit('game:challenge', { roomCode, accusedId });
}

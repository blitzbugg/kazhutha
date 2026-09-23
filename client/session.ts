/**
 * Client-side session persistence (S2, D45).
 *
 * The session token is the seat's ONLY credential — it is stored per room code
 * so a page refresh or transport reconnect reattaches to the same seat without
 * re-dealing. localStorage is per-origin (not per-tab): two tabs in one
 * browser share a seat, which matches how people actually play at home.
 * All access is guarded — private-browsing storage can throw.
 */

const NAME_KEY = 'kazhuta:name';
const LAST_ROOM_KEY = 'kazhuta:lastRoom';
const tokenKey = (roomCode: string): string => `kazhuta:room:${roomCode.toUpperCase()}:token`;

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — session simply won't survive reloads */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const session = {
  getName(): string {
    return safeGet(NAME_KEY) ?? '';
  },
  setName(name: string): void {
    safeSet(NAME_KEY, name);
  },
  getLastRoom(): string | null {
    return safeGet(LAST_ROOM_KEY);
  },
  setLastRoom(roomCode: string): void {
    safeSet(LAST_ROOM_KEY, roomCode.toUpperCase());
  },
  getToken(roomCode: string): string | null {
    const token = safeGet(tokenKey(roomCode));
    return token !== null && token !== '' ? token : null;
  },
  setToken(roomCode: string, token: string): void {
    safeSet(tokenKey(roomCode), token);
  },
  clearToken(roomCode: string): void {
    safeRemove(tokenKey(roomCode));
  },
};

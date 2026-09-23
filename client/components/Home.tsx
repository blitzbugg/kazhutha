import { session } from '../session';
import { createRoom, joinRoom } from '../socket';
import type { Action, AppState } from '../state';

/** Home screen: name entry, create room, join by code, rejoin last room (D45). */
export function Home({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
  const lastRoom = state.roomCode === null ? session.getLastRoom() : null;
  const canRejoin = lastRoom !== null && session.getToken(lastRoom) !== null;
  const nameOk = state.name.trim().length > 0;
  const codeOk = /^[A-HJ-NP-Z2-9]{5}$/.test(state.joinCode);
  const rejoinName = state.name.trim() !== '' ? state.name.trim() : session.getName().trim() || 'Player';

  return (
    <main className="home">
      <h1 className="logo">Kazhuta</h1>
      <p className="tagline">Kazhutakali online — shed every card, dodge the elephant.</p>
      <div className="panel">
        <label className="field">
          <span>Your name</span>
          <input
            value={state.name}
            maxLength={32}
            placeholder="e.g. Kunju"
            autoComplete="name"
            onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
          />
        </label>
        <div className="row">
          <button
            className="btn primary"
            disabled={!nameOk || state.joining}
            onClick={() => createRoom(state.name.trim())}
          >
            Create room
          </button>
        </div>
        <div className="divider">or join a room</div>
        <div className="row">
          <input
            className="code-input"
            value={state.joinCode}
            placeholder="CODE"
            maxLength={5}
            autoCapitalize="characters"
            spellCheck={false}
            aria-label="Room code"
            onChange={(e) =>
              dispatch({
                type: 'setJoinCode',
                code: e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ''),
              })
            }
          />
          <button
            className="btn"
            disabled={!nameOk || !codeOk || state.joining}
            onClick={() => joinRoom(state.joinCode, state.name.trim())}
          >
            Join
          </button>
        </div>
        {canRejoin && lastRoom !== null && (
          <div className="row">
            <button
              className="btn ghost"
              disabled={state.joining}
              onClick={() => joinRoom(lastRoom, rejoinName)}
            >
              Rejoin room {lastRoom}
            </button>
          </div>
        )}
        {state.joining && (
          <p className="hint" role="status">
            Connecting…
          </p>
        )}
      </div>
    </main>
  );
}

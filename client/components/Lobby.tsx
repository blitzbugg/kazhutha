import { displayName } from '../rules';
import { leaveRoom, startGame } from '../socket';
import { seatList, type Action, type AppState } from '../state';

/** Waiting room: shareable code, player list, host-only Start (S3/S4/S8). */
export function Lobby({ state, dispatch }: { state: AppState; dispatch: (a: Action) => void }) {
  const roomCode = state.roomCode;
  if (roomCode === null) return null;
  const seats = seatList(state);
  const isHost = state.self?.isHost ?? false;
  const enoughPlayers = seats.length >= 3;

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(roomCode);
      dispatch({ type: 'toast', kind: 'success', text: 'Room code copied.' });
    } catch {
      dispatch({ type: 'toast', kind: 'info', text: `Room code: ${roomCode}` });
    }
  };

  return (
    <main className="screen lobby">
      <header className="bar">
        <button className="code" onClick={() => void copyCode()} title="Copy room code">
          {roomCode}
        </button>
        <button className="btn ghost" onClick={() => leaveRoom(roomCode)}>
          Leave
        </button>
      </header>

      <div className="panel">
        <h2>Waiting room</h2>
        <ul className="seatlist" aria-label="Players">
          {seats.map((s) => (
            <li key={s.id} className={s.connected ? '' : 'offline'}>
              <span className="who" title={s.name}>
                {s.isHost ? '★ ' : ''}
                {displayName(s, seats)}
                {s.id === state.self?.playerId ? ' (you)' : ''}
              </span>
              {!s.connected && <span className="away">away</span>}
            </li>
          ))}
        </ul>
        {state.players !== null && state.players.spectatorCount > 0 && (
          <p className="hint">{state.players.spectatorCount} spectating</p>
        )}
        <div className="row">
          {isHost ? (
            <button
              className="btn primary"
              disabled={!enoughPlayers}
              onClick={() => startGame(roomCode)}
            >
              {enoughPlayers ? 'Start game' : `Need ${3 - seats.length} more player${3 - seats.length === 1 ? '' : 's'}`}
            </button>
          ) : (
            <p className="hint">Waiting for the host to start…</p>
          )}
        </div>
      </div>
    </main>
  );
}

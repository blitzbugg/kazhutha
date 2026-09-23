import { EventLog } from './EventLog';
import { displayName } from '../rules';
import { leaveRoom, playAgain } from '../socket';
import { seatList, type AppState } from '../state';

/** Game over: announce the Kazhuta, offer host-only rematch in the same room. */
export function GameOver({ state }: { state: AppState }) {
  const view = state.view;
  if (view === null || view.phase !== 'game-over') return null;
  const roomCode = state.roomCode;
  if (roomCode === null) return null;

  const seats = seatList(state);
  const loser = view.loserId === null ? null : (seats.find((s) => s.id === view.loserId) ?? null);
  const isHost = state.self?.isHost ?? false;
  const standings = [...seats].sort((a, b) => a.cardCount - b.cardCount);

  return (
    <main className="screen gameover">
      <header className="bar">
        <span className="code" title="Room code">
          {roomCode}
        </span>
        <button className="btn ghost" onClick={() => leaveRoom(roomCode)}>
          Leave
        </button>
      </header>

      <div className="panel">
        <h1 className="verdict">{loser === null ? 'Everyone shed — no Kazhuta!' : `${loser.name} is the Kazhuta! 🐘`}</h1>
        <ol className="standings" aria-label="Standings">
          {standings.map((s) => (
            <li key={s.id}>
              <span className="who">
                {displayName(s, seats)}
                {s.id === state.self?.playerId ? ' (you)' : ''}
              </span>
              <span className="count">{s.cardCount === 0 ? 'out 🎉' : `${s.cardCount} left`}</span>
            </li>
          ))}
        </ol>
        <div className="row">
          {isHost ? (
            <button className="btn primary" onClick={() => playAgain(roomCode)}>
              Play again (same room)
            </button>
          ) : (
            <p className="hint">Waiting for the host to start the next game…</p>
          )}
        </div>
      </div>

      <EventLog log={view.log} players={view.players} />
    </main>
  );
}

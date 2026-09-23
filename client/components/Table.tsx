import { useState } from 'react';
import { CardFace } from './CardFace';
import { ChallengeBar } from './ChallengeBar';
import { EventLog } from './EventLog';
import { Hand } from './Hand';
import { PlayersRail } from './PlayersRail';
import { displayName } from '../rules';
import { leaveRoom, playCard } from '../socket';
import { isPlayerView, seatList, type AppState } from '../state';

/** Game table: status strip, players, pile, challenge bar, hand, log. */
export function Table({ state }: { state: AppState }) {
  const [strikeCardId, setStrikeCardId] = useState<string | null>(null);
  const view = state.view;
  if (view === null || view.phase !== 'in-round') return null;
  const roomCode = state.roomCode;
  if (roomCode === null) return null;

  const seats = seatList(state);
  const isPlayer = isPlayerView(view);
  const myId = state.self?.playerId ?? null;
  const myTurn = isPlayer && view.currentTurnId !== null && view.currentTurnId === myId;

  // Who visibly struck this round (public info — off-suit cards in the pile).
  const activeSuit = view.activeSuit;
  const strikers = new Set<string>(
    isPlayer && activeSuit !== null
      ? view.playedThisRound.filter((pl) => pl.card.suit !== activeSuit).map((pl) => pl.playerId)
      : [],
  );
  const turnSeat = seats.find((s) => s.id === view.currentTurnId) ?? null;

  const onPlay = (cardId: string): void => {
    setStrikeCardId(null);
    playCard(roomCode, cardId);
  };

  return (
    <main className="screen table">
      <header className="bar">
        <span className="code" title="Room code">
          {roomCode}
        </span>
        <span className="stat">Round {view.roundNumber}</span>
        <span className={`stat suit-chip ${activeSuit === null ? '' : activeSuit === 'H' || activeSuit === 'D' ? 'red' : 'black'}`}>
          {activeSuit === null ? 'Suit —' : `Suit ${activeSuit === 'C' ? '♣' : activeSuit === 'D' ? '♦' : activeSuit === 'H' ? '♥' : '♠'}`}
        </span>
        <button className="btn ghost" onClick={() => leaveRoom(roomCode)}>
          Leave
        </button>
      </header>

      <div className={`turnbanner ${myTurn ? 'mine' : ''}`}>
        {myTurn ? (
          <strong>Your turn</strong>
        ) : (
          <span>
            Waiting for <b>{turnSeat === null ? '…' : displayName(turnSeat, seats)}</b>
            {state.self?.isSpectator === true ? ' (spectating)' : ''}
          </span>
        )}
      </div>

      <PlayersRail seats={seats} selfId={myId} currentTurnId={view.currentTurnId} strikers={strikers} />

      <section className="center" aria-label="Cards on the table">
        {isPlayer ? (
          view.playedThisRound.length === 0 ? (
            <p className="hint">No cards on the table yet — the leader opens the round.</p>
          ) : (
            <ul className="pile">
              {view.playedThisRound.map((pl) => {
                const seat = seats.find((s) => s.id === pl.playerId);
                return (
                  <li key={`${pl.playerId}:${pl.card.id}`}>
                    <CardFace card={pl.card} small />
                    <span className="pileowner">{seat === undefined ? pl.playerId : displayName(seat, seats)}</span>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <p className="hint">{view.playedThisRoundCount} cards on the table</p>
        )}
        <p className="counts">
          On table: {isPlayer ? view.playedThisRound.length : view.playedThisRoundCount} · Discarded:{' '}
          {view.discardCount}
          {isPlayer && view.forfeited.length > 0
            ? ` · Forfeited: ${view.forfeited
                .map((id) => {
                  const seat = seats.find((s) => s.id === id);
                  return seat === undefined ? id : displayName(seat, seats);
                })
                .join(', ')}`
            : ''}
        </p>
      </section>

      {isPlayer && (
        <>
          <ChallengeBar state={state} view={view} />
          {view.yourHand.length === 0 ? (
            <p className="safe" role="status">
              You're safe — waiting for others 🎉
            </p>
          ) : (
            <Hand
              view={view}
              selfId={myId}
              strikeCardId={strikeCardId}
              onPlayCard={onPlay}
              onStrikeSelect={setStrikeCardId}
            />
          )}
        </>
      )}
      {!isPlayer && <p className="safe">Spectating — hands are hidden. You'll see card counts only.</p>}

      <EventLog log={view.log} players={view.players} />
    </main>
  );
}

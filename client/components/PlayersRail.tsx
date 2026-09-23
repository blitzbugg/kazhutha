import { displayName } from '../rules';
import type { SeatLike } from '../state';

export interface PlayersRailProps {
  seats: SeatLike[];
  selfId: string | null;
  currentTurnId: string | null;
  /** Player ids visibly off-suit this round (public info from the pile). */
  strikers: ReadonlySet<string>;
}

/** Other players as card-back counts (AGENTS.md Phase 3, game table). */
export function PlayersRail({ seats, selfId, currentTurnId, strikers }: PlayersRailProps) {
  return (
    <ul className="rail" aria-label="Players">
      {seats.map((s) => (
        <li
          key={s.id}
          className={[
            'chip',
            s.id === currentTurnId ? 'turn' : '',
            s.connected ? '' : 'offline',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="who" title={s.name}>
            {s.isHost ? '★ ' : ''}
            {displayName(s, seats)}
            {s.id === selfId ? ' (you)' : ''}
          </span>
          {strikers.has(s.id) && (
            <span className="bolt" title="Struck this round">
              ⚡
            </span>
          )}
          {!s.connected && <span className="away">away</span>}
          <span className="count" title="Cards in hand">
            {s.cardCount > 0 ? `🂠 ${s.cardCount}` : 'out'}
          </span>
        </li>
      ))}
    </ul>
  );
}

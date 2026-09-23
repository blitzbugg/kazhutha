import type { LogEntry, PlayerView } from '../../engine.js';
import { displayName } from '../rules';

/**
 * Tail of the engine's shared log (AGENTS.md Phase 3: event log reuses state.log).
 *
 * Engine log entries embed raw player ids (they are the only stable identity
 * inside the engine); the UI substitutes display names so humans never see
 * session ids (S4: names are display-only, ids are logic keys). Ids are
 * matched by longest-match so a name that happens to contain another id is
 * still substituted correctly.
 */
export function EventLog({ log, players }: { log: LogEntry[]; players: PlayerView['players'] }) {
  const tail = log.slice(-10);
  const idMap = new Map(players.map((p) => [p.id, displayName(p, players)]));
  // Longest ids first: prevents a shorter id that is a prefix of a longer one
  // from clobbering the longer substitution inside the same message.
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);

  const humanize = (message: string): string => {
    let out = message;
    for (const id of ids) {
      if (!out.includes(id)) continue;
      out = out.split(id).join(idMap.get(id)!);
    }
    return out;
  };

  return (
    <section className="log" aria-label="Game log">
      <h2>Log</h2>
      <ol>
        {tail.map((entry) => (
          <li key={entry.seq}>{humanize(entry.message)}</li>
        ))}
      </ol>
    </section>
  );
}

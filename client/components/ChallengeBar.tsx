import { useEffect, useState } from 'react';
import type { PlayerView } from '../../engine.js';
import { displayName } from '../rules';
import { challenge } from '../socket';
import type { AppState } from '../state';

/**
 * E7 mode (b) UI (D34): accuse another seated player of a false strike.
 *
 * Engine semantics (D49): the server accepts a challenge at ANY point in the
 * game — `resolveChallenge` consults the whole-game `falseStrikes` record and
 * evidence never expires. Two client-side consequences:
 *
 *  1. The striker list is derived from the whole-game PUBLIC log, not from the
 *     transient table: when a strike auto-resolves in the same engine call,
 *     clients never see the intermediate "strike on table" state, so the log's
 *     "`<id> plays <card> (strike).`" lines (engine.ts applyPlay) are the only
 *     durable public record. Raw ids in the log are mapped to display names.
 *  2. The bar stays available all game, not just while a strike sits on the
 *     table. The accused defaults to the most recent observed striker.
 *
 * Cooldown mirrors the server's D31 window; results arrive via unicast
 * challenge:result and surface as toasts.
 */

/** Log lines like `p1 plays 9♥ (strike).` — excludes `forfeits` lines. */
const STRIKE_LOG_LINE = /^(\S+) plays .*\(strike\)\.$/;

export function observedStrikers(view: PlayerView): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let i = view.log.length - 1; i >= 0; i--) {
    const m = STRIKE_LOG_LINE.exec(view.log[i]?.message ?? '');
    if (m?.[1] && !seen.has(m[1])) {
      seen.add(m[1]);
      ordered.push(m[1]);
    }
  }
  return ordered; // most recent striker first
}

export function ChallengeBar({ state, view }: { state: AppState; view: PlayerView }) {
  const [, setTick] = useState(0);
  const [accused, setAccused] = useState('');

  const myId = state.self?.playerId ?? null;
  const seats = view.players;
  const targets = observedStrikers(view)
    .filter((id) => id !== myId && seats.some((s) => s.id === id));
  const cooling = state.challengeCooldownUntil > Date.now();

  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setTick((x) => x + 1), 400);
    return () => clearInterval(timer);
  }, [cooling]);

  if (targets.length === 0) return null;
  const current = targets.includes(accused) ? accused : targets[0]!;
  const secondsLeft = Math.max(0, Math.ceil((state.challengeCooldownUntil - Date.now()) / 1000));

  return (
    <div className="challenge">
      <label className="field-inline">
        <span>Challenge a false strike by</span>
        <select
          value={current}
          onChange={(e) => setAccused(e.target.value)}
          disabled={cooling || state.challengeInFlight}
        >
          {targets.map((id) => {
            const seat = seats.find((s) => s.id === id)!;
            return (
              <option key={id} value={id}>
                {displayName(seat, seats)}
              </option>
            );
          })}
        </select>
      </label>
      <button
        className="btn danger"
        disabled={cooling || state.challengeInFlight}
        onClick={() => {
          if (state.roomCode !== null) challenge(state.roomCode, current);
        }}
      >
        {cooling ? `Wait ${secondsLeft}s` : state.challengeInFlight ? 'Challenging…' : 'Challenge!'}
      </button>
    </div>
  );
}

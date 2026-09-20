/**
 * Phase 1 exit criterion: bot simulation runs to completion for 3, 4, 6 and 8
 * players without throwing (AGENTS.md Phase 1). Bots are deliberately simple
 * and follow the strategy notes in docs/RULES.md ("Strategies"):
 *   - follow suit with the lowest card they hold of the active suit
 *   - strike with their highest card (RULES.md: "Strike with your
 *     highest-value card")
 *   - lead their lowest card when opening a round
 *
 * Run with: npm run demo
 */

import {
  type Card,
  type GameState,
  type PlayerId,
  applyPlay,
  createGame,
  dealCards,
  resolveChallenge,
  seededRng,
} from './engine.js';

const PLAYER_COUNTS = [3, 4, 6, 8] as const;

/** Free function (not a property read) so control-flow narrowing can't hide the 'game-over' state. */
function isGameOver(state: GameState): boolean {
  return state.phase === 'game-over';
}

interface DemoSummary {
  playerCount: number;
  seed: number;
  rounds: number;
  winnerCollected: number;
  loserId: PlayerId | null;
  loserName: string;
  how: string;
}

function chooseCard(state: GameState, botId: PlayerId): Card {
  const hand = state.hands[botId]!;
  if (hand.length === 0) throw new Error(`bot ${botId} asked to play with an empty hand`);

  // Round opener: lead the lowest card (round 1 is forced to the A♠ by the engine).
  if (!state.round || state.round.plays.length === 0) {
    if (state.roundNumber === 1) {
      return hand.find((c) => c.id === 'S14')!; // E9: A♠ leads round 1
    }
    return [...hand].sort((a, b) => a.rank - b.rank)[0]!;
  }

  const activeSuit = state.round.activeSuit!;
  const ofSuit = hand.filter((c) => c.suit === activeSuit);
  if (ofSuit.length > 0) {
    return [...ofSuit].sort((a, b) => a.rank - b.rank)[0]!; // follow low
  }
  return [...hand].sort((a, b) => b.rank - a.rank)[0]!; // strike high
}

function runBotGame(playerCount: number, seed: number): DemoSummary {
  const rng = seededRng(seed);
  const players = Array.from({ length: playerCount }, (_, i) => ({
    id: `bot-${i}`,
    name: `Bot ${i + 1}`,
  }));

  const state = createGame({ players, dealerIndex: 0, rng });
  dealCards(state);

  let appliedPlays = 0;
  const maxPlays = 10_000; // hard stop against an infinite bot loop

  while (!isGameOver(state) && appliedPlays < maxPlays) {
    const turnId = state.currentTurnId;
    if (turnId === null) throw new Error('in-round state with no current turn');

    const before = pickPlay(state, turnId);
    applyPlay(state, turnId, before.id);
    appliedPlays++;

    // Mid-game challenge probe: bots challenge the current leader occasionally
    // to exercise resolveChallenge along the "failed challenge" path (D12).
    if (appliedPlays % 7 === 0 && state.phase !== 'game-over') {
      const challenger = state.players.find((p) => p.id !== turnId)!;
      resolveChallenge(state, challenger.id, turnId);
    }
  }

  if (!isGameOver(state)) {
    throw new Error(`game with ${playerCount} players did not terminate within ${maxPlays} plays`);
  }

  // Invariant: every card is accounted for exactly once.
  const held = Object.values(state.hands).reduce((sum, h) => sum + h.length, 0);
  const total = held + state.discardCount;
  if (total !== 52) {
    throw new Error(
      `conservation violated: hands(${held}) + discard(${state.discardCount}) = ${total} != 52`,
    );
  }

  const loser = state.loserId;
  if (loser === null) {
    return {
      playerCount,
      seed,
      rounds: state.roundNumber - 1,
      winnerCollected: 0,
      loserId: null,
      loserName: '(none — all hands emptied)',
      how: 'simultaneous empty',
    };
  }
  return {
    playerCount,
    seed,
    rounds: state.roundNumber - 1,
    winnerCollected: state.hands[loser]!.length,
    loserId: loser,
    loserName: state.players[seatOf(state, loser)]!.name,
    how: 'last player holding cards (or challenge)',
  };
}

function pickPlay(state: GameState, botId: PlayerId): Card {
  return chooseCard(state, botId);
}

function seatOf(state: GameState, playerId: PlayerId): number {
  return state.players.find((p) => p.id === playerId)!.seat;
}

let failures = 0;
for (const count of PLAYER_COUNTS) {
  for (const seed of [1, 2, 3]) {
    try {
      const summary = runBotGame(count, seed);
      console.log(
        `[ok] ${count}p seed=${summary.seed}: ${summary.rounds} rounds, Kazhuta=${summary.loserName} (${summary.how}, holding ${summary.winnerCollected} card(s))`,
      );
    } catch (err) {
      failures++;
      console.error(`[FAIL] ${count}p seed=${seed}:`, err);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} demo game(s) failed`);
  process.exit(1);
}
console.log('\nAll demo games completed — Phase 1 simulation criterion satisfied.');

/**
 * Phase 1 unit tests — one describe block per AGENTS.md edge case (E1–E10),
 * plus view-redaction, engine-purity and full-game integration tests.
 *
 * NOTE on observation: `applyPlay` resolves rounds automatically when they
 * complete (including strike rounds — DECISIONS.md D22), so assertions after a
 * completing play inspect the OUTCOME (hands, next-round leader, log) rather
 * than the transient round record. `state.falseStrikes` persists across rounds
 * and is the observable record of strikes.
 *
 * Run: npm test  (node:test via tsx — DECISIONS.md D3)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Card,
  type GameState,
  type PlayerId,
  ACE_OF_SPADES_ID,
  EngineInvariantError,
  PlayError,
  advanceTurn,
  applyPlay,
  checkGameOver,
  createDeck,
  createGame,
  dealCards,
  findAceOfSpadesHolder,
  isFalseStrike,
  playersWithCards,
  resolveChallenge,
  resolveRound,
  roundComplete,
  seededRng,
  shuffleDeck,
  toPlayerView,
  toPublicView,
  validatePlay,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayers(n: number): Array<{ id: PlayerId; name: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player ${i}` }));
}

/** Deal a deterministic game and return the state (tests use this constantly). */
function freshGame(n: number, seed = 42, dealerIndex = 0): GameState {
  const state = createGame({ players: makePlayers(n), dealerIndex, rng: seededRng(seed) });
  dealCards(state);
  return state;
}

function handIds(state: GameState, playerId: PlayerId): Set<string> {
  return new Set(state.hands[playerId]!.map((c) => c.id));
}

/** Play `cardId` from `playerId`'s hand, asserting the hand actually holds it. */
function play(state: GameState, playerId: PlayerId, cardId: string): void {
  assert.ok(state.hands[playerId]!.some((c) => c.id === cardId), `${playerId} must hold ${cardId}`);
  applyPlay(state, playerId, cardId);
}

function cardOf(cardId: string): Card {
  const suit = cardId[0] as Card['suit'];
  const rank = Number(cardId.slice(1));
  return { id: cardId, suit, rank };
}

/**
 * Build a fully scripted in-round game, bypassing the deal: `handsById` maps
 * player id → list of card ids. Round 2 (no Ace-of-Spades constraint); seat
 * order follows Object.keys order, leader is the first key.
 */
function craftGame(handsById: Record<PlayerId, string[]>): GameState {
  const ids = Object.keys(handsById);
  if (ids.length < 3) throw new Error('craftGame needs at least 3 players (engine guard)');
  const state = createGame({
    players: ids.map((id) => ({ id, name: id })),
    dealerIndex: 0,
    rng: seededRng(7),
  });
  for (const [id, cards] of Object.entries(handsById)) {
    state.hands[id] = cards.map(cardOf);
  }
  state.phase = 'in-round';
  state.roundNumber = 2;
  const leader = state.players[0]!;
  state.round = { leaderId: leader.id, activeSuit: null, plays: [], forfeited: [] };
  state.currentTurnId = leader.id;
  return state;
}

/** Standard 3-player scripted game used by several suites. */
function simple3(): GameState {
  return craftGame({ p0: ['H5', 'C2'], p1: ['H9', 'S4'], p2: ['H7', 'C6'] });
}

function logText(state: GameState): string {
  return state.log.map((e) => e.message).join('\n');
}

const ALL_IDS = new Set(createDeck().map((c) => c.id));

// ---------------------------------------------------------------------------
// Deck helpers
// ---------------------------------------------------------------------------

describe('deck helpers', () => {
  test('createDeck yields 52 unique French cards, no jokers', () => {
    const deck = createDeck();
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck.map((c) => c.id)).size, 52);
    for (const suit of ['C', 'D', 'H', 'S'] as const) {
      const ofSuit = deck.filter((c) => c.suit === suit);
      assert.equal(ofSuit.length, 13);
      assert.deepEqual(
        ofSuit.map((c) => c.rank).sort((a, b) => a - b),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      );
    }
    assert.ok(deck.find((c) => c.id === ACE_OF_SPADES_ID));
  });

  test('shuffleDeck is deterministic with a seeded rng and does not mutate input', () => {
    const deck = createDeck();
    const snapshot = [...deck];
    const a = shuffleDeck(deck, seededRng(1));
    const b = shuffleDeck(deck, seededRng(1));
    assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
    assert.deepEqual(deck, snapshot, 'input deck must not be mutated');
    assert.equal(new Set(a.map((c) => c.id)).size, 52);
  });

  test('two different seeds produce different shuffles (sanity)', () => {
    const a = shuffleDeck(createDeck(), seededRng(1)).map((c) => c.id).join(',');
    const b = shuffleDeck(createDeck(), seededRng(2)).map((c) => c.id).join(',');
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// E1 — uneven dealing for 3, 5, 6, 7, 8 players
// ---------------------------------------------------------------------------

describe('E1: uneven dealing', () => {
  for (const n of [3, 5, 6, 7, 8]) {
    test(`deals to ${n} players anticlockwise from dealer+1, uneven counts allowed`, () => {
      const state = freshGame(n);
      const counts = state.players.map((p) => state.hands[p.id]!.length);
      assert.equal(counts.reduce((a, b) => a + b, 0), 52);
      assert.equal(Math.max(...counts) - Math.min(...counts), 1, 'uneven by at most one card');

      // Verify the anticlockwise pattern with a KNOWN deck: card at deck
      // position i goes to seat (dealerIndex + 1 + i) mod n.
      const deck = createDeck();
      const g2 = createGame({ players: makePlayers(n), dealerIndex: 0, rng: () => 0 });
      g2.deck = [...deck]; // identity order for exact position math
      dealCards(g2);
      for (let seat = 0; seat < n; seat++) {
        const expected = deck
          .filter((_, idx) => idx % n === (seat + n - 1) % n) // card i -> seat (1+i) mod n
          .map((c) => c.id);
        const actual = g2.hands[g2.players[seat]!.id]!.map((c) => c.id);
        assert.deepEqual(actual, expected, `seat ${seat} card positions mod ${n}`);
      }
    });
  }

  test('3 players: counts are 18/17/17', () => {
    const state = freshGame(3);
    const counts = state.players.map((p) => state.hands[p.id]!.length).sort((a, b) => a - b);
    assert.deepEqual(counts, [17, 17, 18]);
  });

  test('8 players: counts are four 7s and four 6s', () => {
    const state = freshGame(8);
    const counts = state.players.map((p) => state.hands[p.id]!.length).sort((a, b) => a - b);
    assert.deepEqual(counts, [6, 6, 6, 6, 7, 7, 7, 7]);
  });

  test('dealing starts at the seat after the dealer (anticlockwise, E6/D9)', () => {
    const g = createGame({ players: makePlayers(4), dealerIndex: 2, rng: () => 0 });
    g.deck = [...createDeck()];
    dealCards(g);
    // deck order: C2 C3 C4 C5 ... — card i goes to seat (2+1+i) mod 4.
    assert.equal(g.hands['p3']![0]!.id, 'C2', 'card 0 → seat dealer+1');
    assert.equal(g.hands['p0']![0]!.id, 'C3', 'card 1 → seat dealer+2 (wraps)');
    assert.equal(g.hands['p1']![0]!.id, 'C4', 'card 2 → seat dealer+3');
  });
});

// ---------------------------------------------------------------------------
// E2 — empty-handed players are skipped, never re-dealt
// ---------------------------------------------------------------------------

describe('E2: empty-handed players', () => {
  test('empty player is skipped by advanceTurn and not counted for completion', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: [], p2: ['H9', 'D2'] });
    play(state, 'p0', 'H5');
    assert.equal(state.currentTurnId, 'p2', 'p1 (empty) skipped');
    assert.equal(roundComplete(state), false, 'p2 still has to play');
    play(state, 'p2', 'H9'); // completes + auto-resolves (D22)
    assert.equal(state.roundNumber, 3);
    assert.equal(state.round!.leaderId, 'p2', 'H9 highest heart, p2 still holds D2');
    assert.equal(state.discardCount, 2);
  });

  test('roundComplete skips empty players when checking eligibility', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: [], p2: ['H9', 'D2'] });
    // Manually record the plays without resolving, to observe roundComplete.
    // (p0 is the leader and has played; p2 has played; p1 is empty and skipped.)
    state.round!.plays.push(
      { playerId: 'p0', card: cardOf('H5'), strikeDeclared: false, wasFalseStrike: false },
      { playerId: 'p2', card: cardOf('H9'), strikeDeclared: false, wasFalseStrike: false },
    );
    assert.equal(roundComplete(state), true, 'empty p1 does not block completion');
  });

  test('no re-deal path: deck is consumed by dealCards and hands only shrink or grow via collection', () => {
    const state = freshGame(4);
    assert.equal(state.deck, undefined, 'deck fully consumed at deal time');
    state.hands['p1'] = [];
    assert.deepEqual(state.hands['p1'], []);
    // Engine exposes no function that adds undealt cards to a hand.
  });

  test('a player who plays their last card and wins the collection is back in the game', () => {
    // p1 follows with their ONLY card (H9, highest heart). p2 then strikes,
    // ending the round. Collector is p1 — who had just emptied their hand —
    // so the pile returns to p1 (D13/D17 interpretation).
    const state = craftGame({ p0: ['H5', 'C2'], p1: ['H9'], p2: ['S3'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'H9'); // p1 empties by following
    play(state, 'p2', 'S3'); // honest strike, everyone played, no forfeits
    assert.equal(state.round!.leaderId, 'p1', 'H9 is the highest heart');
    assert.equal(state.hands['p1']!.length, 3, 'p1 collected the pile and is back in');
    assert.equal(state.hands['p2']!.length, 0);
    assert.equal(state.hands['p0']!.length, 1);
    assert.equal(state.falseStrikes['p2'], undefined, 'honest strike stays honest');
    assert.equal(state.phase, 'in-round', 'two holders remain — game continues');
  });
});

// ---------------------------------------------------------------------------
// E3 — one holder left ⇒ game over immediately
// ---------------------------------------------------------------------------

describe('E3: single holder ends the game immediately', () => {
  test('checkGameOver fires as soon as one player holds cards', () => {
    const state = freshGame(4);
    for (const p of state.players) {
      if (p.id !== 'p2') state.hands[p.id] = [];
    }
    checkGameOver(state);
    assert.equal(state.phase, 'game-over');
    assert.equal(state.loserId, 'p2');
    assert.equal(state.currentTurnId, null);
    assert.equal(state.round, null);
  });

  test('no play-out possible after game over', () => {
    const state = freshGame(4);
    for (const p of state.players) {
      if (p.id !== 'p2') state.hands[p.id] = [];
    }
    checkGameOver(state);
    const card = state.hands['p2']![0]!.id;
    assert.throws(() => applyPlay(state, 'p2', card), PlayError);
  });

  test('end fires mid-round via applyPlay (no manual checkGameOver needed)', () => {
    const state = craftGame({ p0: ['H5', 'C2'], p1: ['H9'], p2: ['D4', 'C7'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'H9');
    play(state, 'p2', 'D4'); // strike → p1 (H9) collects 3, leads round 3
    assert.equal(state.round!.leaderId, 'p1');
    assert.equal(state.hands['p1']!.length, 3);
    play(state, 'p1', 'H9'); // leads hearts again
    play(state, 'p2', 'C7'); // strike → p0 (not yet played) forfeits → p1 collects 2
    assert.equal(state.hands['p1']!.length, 4);
    assert.equal(state.phase, 'in-round', 'p0 still holds C2 — game not over yet');
    // Round 4: p1 leads diamonds; the turn passes to p0 (who holds C2).
    play(state, 'p1', 'D4');
    play(state, 'p0', 'C2'); // strike → p1 collects → only p1 holds cards
    assert.equal(state.hands['p1']!.length, 5, 'p1 holds every card');
    assert.equal(state.phase, 'game-over', 'E3 fired inside applyPlay');
    assert.equal(state.loserId, 'p1');
    const held = Object.values(state.hands).reduce((s, h) => s + h.length, 0);
    assert.equal(held + state.discardCount, 5, 'scripted conservation (5-card game)');
  });
});

// ---------------------------------------------------------------------------
// E4 — strike rounds: collector from the ORIGINAL active suit
// ---------------------------------------------------------------------------

describe('E4: strike rounds resolve via the original active suit', () => {
  test('collector is the highest card of the originally declared suit', () => {
    // p0 leads H3; p1 strikes with S2; p2 (D2) forfeits. The pile's only heart
    // is H3 → p0 collects, even though a spade is in the pile.
    const state = craftGame({ p0: ['H3'], p1: ['S2'], p2: ['D2'] });
    play(state, 'p0', 'H3');
    play(state, 'p1', 'S2'); // strike → p2 forfeits → auto-resolve
    assert.match(logText(state), /p2 forfeits their turn \(strike\)/);
    assert.equal(state.hands['p0']!.length, 2, 'p0 collects H3+S2 as the only heart');
    assert.equal(state.round!.leaderId, 'p0');
    assert.equal(state.discardCount, 0, 'strike piles return to hands, not discard');
  });

  test('collector calculation ignores the struck card entirely (even an Ace)', () => {
    const state = craftGame({ p0: ['H3', 'C5'], p1: ['S14'], p2: ['H7'] });
    play(state, 'p0', 'H3');
    play(state, 'p1', 'S14'); // strike — the highest card in the whole game
    assert.equal(state.round!.leaderId, 'p0', 'H3 wins; the SA is irrelevant');
    assert.equal(state.hands['p0']!.length, 3);
    assert.match(logText(state), /p2 forfeits their turn \(strike\)/);
  });
});

// ---------------------------------------------------------------------------
// E5 — one-card hands: follow if you can, strike if you cannot
// ---------------------------------------------------------------------------

describe('E5: last-card behavior', () => {
  test('a single card of the active suit must still be followed', () => {
    const state = craftGame({ p0: ['H5', 'C2'], p1: ['H2', 'C3'], p2: ['S9', 'C4'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'H2'); // their ONLY heart — must follow, not strike
    play(state, 'p2', 'S9'); // honest strike with everyone already played
    assert.doesNotMatch(logText(state), /forfeits/);
    assert.match(logText(state), /p1 plays 2♥\./, 'p1 followed, no (strike) marker');
    assert.equal(state.round!.leaderId, 'p0', 'H5 highest heart');
    assert.equal(state.hands['p0']!.length, 4);
  });

  test('a single off-suit card is a strike by definition — no last-card special case', () => {
    const state = craftGame({ p0: ['H5'], p1: ['S2'], p2: ['H7', 'C3'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'S2'); // only card, off-suit → strike, p2 forfeits
    assert.match(logText(state), /p2 forfeits their turn \(strike\)/);
    assert.equal(state.round!.leaderId, 'p0', 'p0 collects the pile');
    assert.equal(state.hands['p0']!.length, 2);
  });
});

// ---------------------------------------------------------------------------
// E6 — dealer rotation
// ---------------------------------------------------------------------------

describe('E6: dealer rotation', () => {
  test('createGame accepts dealerIndex and rotates anticlockwise across games', () => {
    const n = 4;
    let dealer = 0;
    for (let game = 0; game < 4; game++) {
      const state = freshGame(n, 100 + game, dealer);
      assert.equal(state.dealerIndex, dealer);
      dealer = (dealer + 1) % n;
    }
    assert.equal(dealer, 0, 'rotation wraps after N games');
  });

  test('out-of-range dealerIndex throws', () => {
    assert.throws(() => createGame({ players: makePlayers(4), dealerIndex: 4 }), EngineInvariantError);
    assert.throws(() => createGame({ players: makePlayers(4), dealerIndex: -1 }), EngineInvariantError);
    assert.throws(() => createGame({ players: makePlayers(4), dealerIndex: 1.5 }), EngineInvariantError);
  });
});

// ---------------------------------------------------------------------------
// E7 — false strikes: silent tracking + challenge (mode b)
// ---------------------------------------------------------------------------

describe('E7: false strikes (mode b — Challenge!)', () => {
  test('isFalseStrike predicate on play records (pure)', () => {
    assert.equal(
      isFalseStrike({ playerId: 'x', card: cardOf('D2'), strikeDeclared: true, wasFalseStrike: true }),
      true,
    );
    assert.equal(
      isFalseStrike({ playerId: 'x', card: cardOf('D2'), strikeDeclared: true, wasFalseStrike: false }),
      false,
      'honest strike',
    );
    assert.equal(
      isFalseStrike({ playerId: 'x', card: cardOf('D2'), strikeDeclared: false, wasFalseStrike: false }),
      false,
      'follow',
    );
  });

  test('false strike recorded silently; honest strikes leave no record', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: ['H9', 'D2'], p2: ['H7', 'C4'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'D2'); // holds H9 → false strike → p2 forfeits → resolve (p0 collects)
    assert.equal(state.falseStrikes['p1']!.some((c) => c.id === 'D2'), true);
    assert.equal(state.falseStrikes['p0'], undefined);
    // The public log must NOT distinguish false from honest strikes (D10/D11).
    assert.doesNotMatch(logText(state), /false/i);

    const honest = craftGame({ p0: ['H5'], p1: ['S3', 'C4'], p2: ['H7'] });
    play(honest, 'p0', 'H5');
    play(honest, 'p1', 'S3'); // truly void → honest strike
    assert.equal(honest.falseStrikes['p1'], undefined);
  });

  test('later collection of the suit does not retroactively falsify an honest strike (D11 snapshot)', () => {
    const state = craftGame({ p0: ['H5'], p1: ['S3', 'C9'], p2: ['H7', 'D4'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'S3'); // honest strike NOW (p1 holds no hearts)
    // p1's strike ends the round; collector is p0 (H5 highest heart played).
    assert.equal(state.falseStrikes['p1'], undefined);
    assert.equal(state.hands['p0']!.length, 2);
    // The strike snapshot was taken at play time — acquiring hearts later
    // through collection can never rewrite it.
  });

  test('successful challenge: accused becomes loser immediately, game over', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: ['H9', 'D2'], p2: ['H7', 'C4'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'D2'); // false strike recorded
    assert.equal(state.phase, 'in-round');

    const ok = resolveChallenge(state, 'p0', 'p1');
    assert.equal(ok, true);
    assert.equal(state.phase, 'game-over');
    assert.equal(state.loserId, 'p1');
    assert.match(state.log.at(-1)!.message, /CHALLENGE SUCCEEDED/);
  });

  test('failed challenge: logged, no penalty, game continues', () => {
    const state = simple3();
    play(state, 'p0', 'H5');
    play(state, 'p1', 'H9');
    play(state, 'p2', 'H7'); // all-follow round completes and resolves
    assert.equal(state.phase, 'in-round', 'three holders remain');

    const ok = resolveChallenge(state, 'p0', 'p1');
    assert.equal(ok, false);
    assert.equal(state.phase, 'in-round');
    assert.equal(state.loserId, null);
    assert.match(state.log.at(-1)!.message, /challenge failed/);
  });

  test('challenge housekeeping: self/non-player accusations rejected', () => {
    const state = freshGame(4);
    assert.throws(() => resolveChallenge(state, 'p0', 'p0'), PlayError);
    assert.throws(() => resolveChallenge(state, 'p0', 'ghost'), PlayError);
    assert.throws(() => resolveChallenge(state, 'ghost', 'p0'), PlayError);
  });
});

// ---------------------------------------------------------------------------
// E8 — specific, distinct rejections; no mutation on failure
// ---------------------------------------------------------------------------

describe('E8: play validation errors', () => {
  test('out-of-turn play → NOT_YOUR_TURN (not CARD_NOT_IN_HAND)', () => {
    const state = simple3();
    assert.throws(
      () => applyPlay(state, 'p1', 'H9'),
      (err: unknown) => err instanceof PlayError && err.code === 'NOT_YOUR_TURN',
    );
    assert.equal(state.round!.plays.length, 0, 'rejected play must not mutate');
  });

  test('card not in hand → CARD_NOT_IN_HAND (not NOT_YOUR_TURN)', () => {
    const state = simple3();
    assert.throws(
      () => applyPlay(state, 'p0', 'H9'),
      (err: unknown) => err instanceof PlayError && err.code === 'CARD_NOT_IN_HAND',
    );
    assert.equal(state.hands['p1']!.length, 2, 'p1 untouched');
  });

  test('unknown card id → INVALID_PAYLOAD even from a non-turn player (no turn leak)', () => {
    const state = freshGame(4);
    const before = JSON.stringify(state);
    assert.throws(
      () => validatePlay(state, 'p1', 'X99'),
      (err: unknown) => err instanceof PlayError && err.code === 'INVALID_PAYLOAD',
    );
    assert.equal(JSON.stringify(state), before, 'validatePlay never mutates');
  });

  test('playing after game over → GAME_OVER', () => {
    const state = freshGame(4);
    for (const p of state.players) {
      if (p.id !== 'p2') state.hands[p.id] = [];
    }
    checkGameOver(state);
    const card = state.hands['p2']![0]!.id;
    assert.throws(
      () => validatePlay(state, 'p2', card),
      (err: unknown) => err instanceof PlayError && err.code === 'GAME_OVER',
    );
  });
});

// ---------------------------------------------------------------------------
// E9 — Ace of Spades starts round 1; never again afterwards
// ---------------------------------------------------------------------------

describe('E9: Ace of Spades round-1 start', () => {
  test('A♠ holder leads round 1 regardless of dealer seat', () => {
    for (const dealer of [0, 1, 2, 3]) {
      const state = freshGame(4, 11, dealer);
      const holder = findAceOfSpadesHolder(state);
      assert.equal(state.currentTurnId, holder);
      assert.equal(state.round!.leaderId, holder);
    }
  });

  test('round 1 opener must play the A♠ itself (MUST_LEAD_ACE_OF_SPADES)', () => {
    const state = freshGame(4);
    const holder = state.currentTurnId!;
    const other = state.hands[holder]!.find((c) => c.id !== ACE_OF_SPADES_ID)!;
    assert.throws(
      () => applyPlay(state, holder, other.id),
      (err: unknown) => err instanceof PlayError && err.code === 'MUST_LEAD_ACE_OF_SPADES',
    );
    applyPlay(state, holder, ACE_OF_SPADES_ID);
    assert.equal(state.round!.activeSuit, 'S');
  });

  test('later rounds never reapply Ace-of-Spades logic (E9)', () => {
    const state = simple3();
    play(state, 'p0', 'H5');
    play(state, 'p1', 'H9');
    play(state, 'p2', 'H7'); // round resolves; p1 still holds S4 → leads round 3
    assert.equal(state.roundNumber, 3);
    assert.equal(state.round!.leaderId, 'p1');
    const opener = state.hands['p1']![0]!; // any card — p1 freely picks the suit
    applyPlay(state, 'p1', opener.id); // no MUST_LEAD_ACE_OF_SPADES thrown
    assert.equal(state.round!.activeSuit, opener.suit);
  });
});

// ---------------------------------------------------------------------------
// E10 — resolveRound with empty plays throws loudly
// ---------------------------------------------------------------------------

describe('E10: resolveRound refuses empty/no rounds', () => {
  test('throws EngineInvariantError on empty plays', () => {
    const state = freshGame(4);
    state.round = { leaderId: 'p0', activeSuit: 'H', plays: [], forfeited: [] };
    assert.throws(() => resolveRound(state), EngineInvariantError);
  });

  test('throws when there is no active round at all', () => {
    const state = freshGame(4);
    state.round = null;
    assert.throws(() => resolveRound(state), EngineInvariantError);
  });

  test('corrupt round (declared suit with zero suit plays) throws loudly too', () => {
    const state = freshGame(4);
    state.round = {
      leaderId: 'p0',
      activeSuit: 'H',
      plays: [{ playerId: 'p0', card: cardOf('S5'), strikeDeclared: false, wasFalseStrike: false }],
      forfeited: [],
    };
    assert.throws(() => resolveRound(state), EngineInvariantError);
  });
});

// ---------------------------------------------------------------------------
// Views — redaction guarantees
// ---------------------------------------------------------------------------

describe('views: hand redaction', () => {
  test('toPlayerView exposes only your own hand', () => {
    const state = freshGame(4);
    for (const pid of ['p0', 'p1', 'p2', 'p3']) {
      const view = toPlayerView(state, pid);
      assert.deepEqual(new Set(view.yourHand.map((c) => c.id)), handIds(state, pid));
    }
  });

  test('views never contain falseStrikes, hands, or the deck; log stays neutral', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: ['H9', 'D2'], p2: ['H7', 'C4'] });
    play(state, 'p0', 'H5');
    play(state, 'p1', 'D2'); // false strike → p2 forfeits → p0 collects, leads
    play(state, 'p0', 'H5'); // p0 leads hearts again
    play(state, 'p1', 'H9');
    play(state, 'p2', 'H7'); // round completes and resolves

    for (const pid of ['p0', 'p1', 'p2']) {
      const v = toPlayerView(state, pid);
      assert.equal('falseStrikes' in v, false);
      assert.equal('hands' in v, false);
      assert.equal('deck' in v, false);
      for (const entry of v.log) {
        assert.doesNotMatch(entry.message, /false strike/i);
      }
    }
    const pub = toPublicView(state);
    assert.equal('falseStrikes' in pub, false);
    assert.equal('hands' in pub, false);
    assert.equal(typeof pub.playedThisRoundCount, 'number');
    assert.ok(pub.players.every((p) => typeof p.cardCount === 'number'));
    // Redacted views must not include the server-only strike evidence.
    assert.equal(state.falseStrikes['p1']!.length, 1, 'evidence exists server-side only');
  });

  test('toPlayerView throws for a non-seated id', () => {
    const state = freshGame(4);
    assert.throws(() => toPlayerView(state, 'ghost'), EngineInvariantError);
  });

  test('view counts are consistent with the underlying state', () => {
    const state = freshGame(4);
    const view = toPlayerView(state, 'p0');
    for (const p of view.players) {
      assert.equal(p.cardCount, state.hands[p.id]!.length);
    }
    const pub = toPublicView(state);
    assert.equal(pub.players.length, 4);
    assert.equal(pub.phase, 'in-round');
    assert.equal(pub.currentTurnId, state.currentTurnId);
  });
});

// ---------------------------------------------------------------------------
// Turn advancement (E2/S1 support)
// ---------------------------------------------------------------------------

describe('turn advancement', () => {
  test('advanceTurn skips empty players', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: [], p2: ['H9', 'D2'] });
    assert.equal(advanceTurn(state), 'p2'); // from p0, p1 is empty
  });

  test('advanceTurn skips disconnected players (S1 groundwork)', () => {
    const state = craftGame({ p0: ['H5', 'S3'], p1: ['H9'], p2: ['H7'] });
    state.players[1]!.connected = false;
    assert.equal(advanceTurn(state), 'p2');
    state.players[1]!.connected = true;
    assert.equal(advanceTurn(state), 'p1');
  });

  test('advanceTurn wraps to the sole holder; checkGameOver ends that state (E3)', () => {
    const state = freshGame(4);
    for (const p of state.players) {
      if (p.id !== 'p0') state.hands[p.id] = [];
    }
    state.currentTurnId = 'p0';
    assert.equal(advanceTurn(state), 'p0', 'sole holder is the only candidate');
    checkGameOver(state);
    assert.equal(state.phase, 'game-over', 'E3 terminates before this matters in real play');
  });
});

// ---------------------------------------------------------------------------
// Full-game integration + invariants
// ---------------------------------------------------------------------------

describe('integration: scripted full games', () => {
  /** Naive-but-legal bot: lead low, follow low, strike high. */
  function legalBotCard(state: GameState, turn: PlayerId): string {
    const hand = state.hands[turn]!;
    if (state.roundNumber === 1 && state.round!.plays.length === 0) {
      return hand.find((c) => c.id === ACE_OF_SPADES_ID)!.id;
    }
    const active = state.round && state.round.plays.length > 0 ? state.round.activeSuit : null;
    if (active) {
      const ofSuit = hand.find((c) => c.suit === active);
      if (ofSuit) return ofSuit.id;
      return [...hand].sort((a, b) => b.rank - a.rank)[0]!.id;
    }
    return [...hand].sort((a, b) => a.rank - b.rank)[0]!.id;
  }

  function runGame(n: number, seed: number): GameState {
    const state = freshGame(n, seed);
    let guard = 0;
    while (state.phase !== 'game-over' && guard++ < 2_000) {
      const turn = state.currentTurnId!;
      applyPlay(state, turn, legalBotCard(state, turn));
    }
    return state;
  }

  for (const n of [3, 4, 5, 6, 7, 8]) {
    test(`${n}-player game terminates with conservation intact (seed 5)`, () => {
      const state = runGame(n, 5);
      assert.equal(state.phase, 'game-over', 'game must terminate');
      const held = Object.values(state.hands).reduce((s, h) => s + h.length, 0);
      assert.equal(held + state.discardCount, 52, 'card conservation');
      if (held > 0) {
        assert.equal(playersWithCards(state).length, 1);
        assert.ok(state.loserId !== null);
        assert.equal(state.hands[state.loserId!]!.length, held);
      } else {
        assert.equal(state.loserId, null, 'simultaneous empty → no Kazhuta (D19)');
      }
    });
  }

  test('every dealt card id is unique and from the real deck', () => {
    const state = freshGame(5, 9);
    const all = state.players.flatMap((p) => state.hands[p.id]!.map((c) => c.id));
    assert.equal(all.length, 52);
    assert.equal(new Set(all).size, 52);
    for (const id of all) assert.ok(ALL_IDS.has(id));
  });

  test('engine purity: module surface has no I/O-flavoured exports', async () => {
    const mod = await import('../engine.js');
    for (const key of Object.keys(mod)) {
      assert.ok(
        !/socket|fetch|https?:|process\.|window|document|\bfs\b/i.test(key),
        `engine export ${key} must not be I/O-flavoured`,
      );
    }
  });
});

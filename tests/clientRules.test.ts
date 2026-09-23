/**
 * Phase 3 unit tests — client/rules.ts, the pure mirror of the engine's play
 * rules that decides what the UI lets you click (U1/U2, D44). The server
 * remains the sole authority; these tests pin the mirror so it can't drift
 * silently.
 *
 * Runs on the existing node:test runner; no DOM, no React.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ACE_OF_SPADES_ID } from '../engine.js';
import { ACE_OF_SPADES, handPlayability } from '../client/rules.js';
import type { Card, PlayerView, Suit } from '../engine.js';

const card = (id: string): Card => ({ id, suit: id[0] as Suit, rank: Number(id.slice(1)) });

function viewOf({ yourHand, ...overrides }: Partial<PlayerView> & { yourHand: Card[] }): PlayerView {
  return {
    phase: 'in-round',
    roundNumber: 2,
    players: [
      { id: 'me', seat: 0, name: 'Me', connected: true, cardCount: yourHand.length },
      { id: 'other', seat: 1, name: 'Other', connected: true, cardCount: 3 },
    ],
    currentTurnId: 'me',
    activeSuit: null,
    playedThisRound: [],
    discardCount: 0,
    forfeited: [],
    loserId: null,
    log: [],
    yourHand,
    ...overrides,
  };
}

function states(view: PlayerView): Map<string, string> {
  return new Map(handPlayability(view, 'me').map((p) => [p.card.id, p.playability]));
}

describe('client rules — hand playability (U1/U2 mirror, D44)', () => {
  test('the mirror pins the same ace id as the engine (E9 consistency)', () => {
    assert.equal(ACE_OF_SPADES, ACE_OF_SPADES_ID);
  });

  test('U1: every card is disabled when it is not your turn', () => {
    const view = viewOf({ yourHand: [card('H5'), card('S9')], currentTurnId: 'other' });
    for (const p of handPlayability(view, 'me')) {
      assert.equal(p.playability, 'disabled');
      assert.match(p.reason ?? '', /not your turn/i);
    }
  });

  test('U1: every card is disabled when the game is over', () => {
    const view = viewOf({ yourHand: [card('H5')], phase: 'game-over' });
    for (const p of handPlayability(view, 'me')) {
      assert.equal(p.playability, 'disabled');
    }
  });

  test('spectator (selfId null) can never click anything', () => {
    const view = viewOf({ yourHand: [card('H5')] });
    for (const p of handPlayability(view, null)) {
      assert.equal(p.playability, 'disabled');
    }
  });

  test('E9 mirror: round 1 opener must be the Ace of Spades — only S14 is playable', () => {
    const view = viewOf({
      yourHand: [card('S14'), card('H5'), card('D9')],
      roundNumber: 1,
      playedThisRound: [],
    });
    const s = states(view);
    assert.equal(s.get('S14'), 'playable');
    assert.equal(s.get('H5'), 'disabled');
    assert.match(handPlayability(view, 'me').find((p) => p.card.id === 'H5')!.reason ?? '', /ace of spades/i);
  });

  test('round ≥ 2 leader opening the round may play any card (activeSuit still null)', () => {
    const view = viewOf({ yourHand: [card('H5'), card('D9'), card('C2')], playedThisRound: [] });
    const s = states(view);
    assert.equal(s.get('H5'), 'playable');
    assert.equal(s.get('D9'), 'playable');
    assert.equal(s.get('C2'), 'playable');
  });

  test('U2: holding the active suit — suit cards playable, off-suit cards need the strike confirmation (D44)', () => {
    const view = viewOf({
      yourHand: [card('H5'), card('H12'), card('S9'), card('C3')],
      activeSuit: 'H',
      playedThisRound: [{ playerId: 'other', card: card('H7') }],
    });
    const s = states(view);
    assert.equal(s.get('H5'), 'playable');
    assert.equal(s.get('H12'), 'playable');
    assert.equal(s.get('S9'), 'confirm-strike');
    assert.equal(s.get('C3'), 'confirm-strike');
    assert.match(handPlayability(view, 'me').find((p) => p.card.id === 'S9')!.reason ?? '', /false strike/i);
  });

  test('no active-suit card in hand: every card is a playable (forced true) strike', () => {
    const view = viewOf({
      yourHand: [card('S9'), card('C3')],
      activeSuit: 'H',
      playedThisRound: [{ playerId: 'other', card: card('H7') }],
    });
    const s = states(view);
    assert.equal(s.get('S9'), 'playable');
    assert.equal(s.get('C3'), 'playable');
  });

  test('empty hand yields no entries (U6 is the UI\'s "safe" message, not the mirror\'s)', () => {
    const view = viewOf({ yourHand: [] });
    assert.equal(handPlayability(view, 'me').length, 0);
  });

  test('duplicate display names are disambiguated by seat (S4)', async () => {
    const { displayName } = await import('../client/rules.js');
    const seats = [
      { name: 'Appu', seat: 0 },
      { name: 'Appu', seat: 2 },
      { name: 'Kunju', seat: 1 },
    ];
    assert.equal(displayName(seats[0]!, seats), 'Appu (seat 1)');
    assert.equal(displayName(seats[1]!, seats), 'Appu (seat 3)');
    assert.equal(displayName(seats[2]!, seats), 'Kunju');
  });
});

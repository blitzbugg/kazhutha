/**
 * Client-side mirror of the engine's play rules — UX only (U1/U2).
 *
 * The server remains the sole authority (AGENTS.md architecture principle);
 * this module decides what the UI lets you click. The order of checks mirrors
 * engine `validatePlay`: game-over → not-your-turn → round-1 A♠ opener.
 *
 * U2 (must follow suit) is a PRODUCT decision layered on top: while you hold
 * the active suit, off-suit cards require an explicit second-click strike
 * confirmation (D44). A single mis-tap can therefore never fire an off-suit
 * play — but deliberate (false) strikes remain possible, which keeps E7 mode
 * (b) challenges meaningful. When you hold no active-suit card, every card is
 * a forced true strike and plays directly.
 */
import type { Card, PlayerView, Suit } from '../engine.js';

export const ACE_OF_SPADES = 'S14';

export const SUIT_SYMBOL: Record<Suit, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
export const SUIT_NAME: Record<Suit, string> = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };

export function isRedSuit(suit: Suit): boolean {
  return suit === 'H' || suit === 'D';
}

export function rankLabel(rank: number): string {
  return rank === 11 ? 'J' : rank === 12 ? 'Q' : rank === 13 ? 'K' : rank === 14 ? 'A' : String(rank);
}

export function cardText(card: Card): string {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

export type Playability = 'playable' | 'confirm-strike' | 'disabled';

export interface CardPlayability {
  card: Card;
  playability: Playability;
  /** Why the card is not playable directly (tooltip / aria-label). */
  reason: string | null;
}

/**
 * Per-card clickability for the hand owner.
 *
 * Pre: `view` is the seat's own PlayerView; `selfId` is the seat's player id
 * (null for spectators — everything disabled).
 * Post: one entry per hand card, in the server's sorted order.
 */
export function handPlayability(view: PlayerView, selfId: string | null): CardPlayability[] {
  const over = view.phase !== 'in-round';
  const myTurn = !over && selfId !== null && view.currentTurnId === selfId;
  const round1Opener = myTurn && view.roundNumber === 1 && view.playedThisRound.length === 0;
  const activeSuit = view.activeSuit;
  const holdsSuit = activeSuit !== null && view.yourHand.some((c) => c.suit === activeSuit);

  return view.yourHand.map((card) => {
    if (over) return { card, playability: 'disabled' as const, reason: 'The game is over.' };
    if (!myTurn) return { card, playability: 'disabled' as const, reason: 'It is not your turn.' };
    if (round1Opener) {
      return card.id === ACE_OF_SPADES
        ? { card, playability: 'playable' as const, reason: null }
        : { card, playability: 'disabled' as const, reason: 'Round 1 must open with the Ace of Spades.' };
    }
    if (activeSuit === null || card.suit === activeSuit) {
      return { card, playability: 'playable' as const, reason: null };
    }
    if (holdsSuit) {
      return {
        card,
        playability: 'confirm-strike' as const,
        reason: `Strike — you still hold ${SUIT_NAME[activeSuit]}. A false strike can be challenged.`,
      };
    }
    // No active-suit card in hand: off-suit play is a forced true strike.
    return { card, playability: 'playable' as const, reason: null };
  });
}

/**
 * S4: disambiguate duplicate display names by seat. Names are never identity
 * keys — the caller must always keep the entry's id for logic.
 */
export function displayName(
  entry: { name: string; seat: number },
  all: ReadonlyArray<{ name: string; seat: number }>,
): string {
  const duplicates = all.filter((p) => p.name === entry.name).length > 1;
  return duplicates ? `${entry.name} (seat ${entry.seat + 1})` : entry.name;
}

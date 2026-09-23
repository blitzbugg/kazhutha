import type { Card } from '../../engine.js';
import { SUIT_SYMBOL, isRedSuit, rankLabel } from '../rules';

/** A read-only card face (pile / log contexts). Interactive cards are buttons in Hand. */
export function CardFace({ card, small }: { card: Card; small?: boolean }) {
  return (
    <span className={`cardface${isRedSuit(card.suit) ? ' red' : ' black'}${small === true ? ' small' : ''}`}>
      <span className="corner">
        {rankLabel(card.rank)}
        {SUIT_SYMBOL[card.suit]}
      </span>
      <span className="suit">{SUIT_SYMBOL[card.suit]}</span>
    </span>
  );
}

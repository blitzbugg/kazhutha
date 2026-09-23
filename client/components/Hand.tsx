import type { PlayerView } from '../../engine.js';
import { SUIT_SYMBOL, cardText, handPlayability, isRedSuit, rankLabel } from '../rules';

export interface HandProps {
  view: PlayerView;
  selfId: string | null;
  /** Card currently awaiting strike confirmation, if any. */
  strikeCardId: string | null;
  onPlayCard: (cardId: string) => void;
  onStrikeSelect: (cardId: string | null) => void;
}

/**
 * The seat's hand (U1/U2). 'playable' cards fire on click; 'confirm-strike'
 * cards (off-suit while holding the suit) require the explicit banner
 * confirmation above the hand so a single mis-tap can never declare a strike
 * (D44) — deliberate false strikes stay possible for E7 mode (b).
 */
export function Hand({ view, selfId, strikeCardId, onPlayCard, onStrikeSelect }: HandProps) {
  const playable = handPlayability(view, selfId);
  const selected = playable.find((p) => p.card.id === strikeCardId);

  return (
    <section className="handwrap" aria-label="Your hand">
      {selected !== undefined && (
        <div className="strikebar" role="alertdialog" aria-label="Confirm strike">
          <span>
            Declare a strike with <b>{cardText(selected.card)}</b>? {selected.reason}
          </span>
          <span className="row tight">
            <button
              className="btn danger"
              onClick={() => {
                onPlayCard(selected.card.id);
                onStrikeSelect(null);
              }}
            >
              Play strike
            </button>
            <button className="btn" onClick={() => onStrikeSelect(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      <div className="hand">
        {playable.map(({ card, playability, reason }) => (
          <button
            key={card.id}
            className={[
              'card',
              'interactive',
              isRedSuit(card.suit) ? 'red' : 'black',
              playability,
              card.id === strikeCardId ? 'selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={playability === 'disabled'}
            title={reason ?? `Play ${cardText(card)}`}
            aria-label={`Card ${cardText(card)}${reason === null ? ' — playable' : ` — ${reason}`}`}
            onClick={() => {
              if (playability === 'playable') onPlayCard(card.id);
              else if (playability === 'confirm-strike') onStrikeSelect(strikeCardId === card.id ? null : card.id);
            }}
          >
            <span className="corner">
              {rankLabel(card.rank)}
              {SUIT_SYMBOL[card.suit]}
            </span>
            <span className="suit">{SUIT_SYMBOL[card.suit]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Kazhutakali engine — Phase 1 (pure logic, no I/O).
 *
 * Canonical rules: docs/RULES.md. Architectural decisions: docs/DECISIONS.md.
 * This module must stay importable from a plain Node script with zero runtime
 * dependencies (AGENTS.md Phase 1 exit criteria). It never touches sockets,
 * React, the filesystem, or the network.
 *
 * Core invariants:
 *  - The engine never mutates `GameState` on a rejected action.
 *  - `checkGameOver` conditions are re-evaluated after every state mutation.
 *  - False-strike bookkeeping (`falseStrikes`) is server-only truth and is
 *    stripped from every view function.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** French suits, per docs/RULES.md "Requirements". Jokers are not used. */
export type Suit = 'C' | 'D' | 'H' | 'S';

/** Rank as an integer: 2..10 are pips, 11=J, 12=Q, 13=K, 14=A (RULES.md hierarchy). */
export type Rank = number;

/** String identity of a card, e.g. `"S14"` = Ace of Spades (DECISIONS.md D6). */
export type CardId = string;

export interface Card {
  id: CardId;
  suit: Suit;
  rank: Rank;
}

/** Opaque player identifier. Never derived from display names (AGENTS.md S4). */
export type PlayerId = string;

export interface PlayerState {
  id: PlayerId;
  /** Seat index; play order is ascending seat index mod N (anticlockwise, D9). */
  seat: number;
  /** Display name only — duplicates allowed, never an identity key (S4). */
  name: string;
  /** Connectivity flag; Phase 2 flips this on socket disconnect (S1). */
  connected: boolean;
}

/** One card placed into the current round. */
export interface PlayedCard {
  playerId: PlayerId;
  card: Card;
  /**
   * True if this play was off-suit (a "strike"). Note: a strike may still be
   * *false* — see wasFalseStrike (DECISIONS.md D11/D14).
   */
  strikeDeclared: boolean;
  /**
   * True iff the player declared a strike while actually holding a card of the
   * active suit at play time. Snapshot taken at the moment of the play so a
   * later collection can never turn a true strike into a false accusation
   * (DECISIONS.md D11). Server-only truth.
   */
  wasFalseStrike: boolean;
}

export interface LogEntry {
  seq: number;
  message: string;
}

export interface RoundState {
  /** Player who opened the round (Ace of Spades holder in round 1, else collector). */
  leaderId: PlayerId;
  /**
   * Suit declared by the round's first card. Null only while the leader has
   * not yet opened (or in a not-started game). Rounds are resolved strictly
   * against this suit, even if nobody else can follow it (AGENTS.md E4).
   */
  activeSuit: Suit | null;
  plays: PlayedCard[];
  /**
   * Players who forfeited their turn because someone struck before them
   * (RULES.md: "Remaining players forfeit their turn"). Includes empty-handed
   * players only insofar as they were skipped — skipped players are not
   * forfeits; this list is for able players who never got to play.
   */
  forfeited: PlayerId[];
}

export type GamePhase = 'not-started' | 'in-round' | 'game-over';

/**
 * Full authoritative game state. Lives on the server only; clients receive
 * redacted projections via `toPublicView` / `toPlayerView`.
 */
export interface GameState {
  players: PlayerState[];
  hands: Record<PlayerId, Card[]>;
  /**
   * Transient server-only deck: shuffled in createGame, consumed by dealCards.
   * Never exposed through any view. Undefined after dealing.
   */
  deck?: Card[];
  /** Seat index of the dealer for this game (rotates per game, AGENTS.md E6). */
  dealerIndex: number;
  roundNumber: number;
  round: RoundState | null;
  /** Cards permanently out of play (all-follow rounds only — D13). */
  discardCount: number;
  phase: GamePhase;
  currentTurnId: PlayerId | null;
  /** Set when the game ends; `null` if the last round emptied every hand (D19). */
  loserId: PlayerId | null;
  log: LogEntry[];
  /**
   * False-strike records for the whole game: every play that was flagged
   * `wasFalseStrike`. Server-only truth for challenge resolution (E7 mode (b),
   * DECISIONS.md D10–D12). Never serialized into any client view.
   */
  falseStrikes: Record<PlayerId, Card[]>;
  seq: number;
}

/** Everything about a game needed to construct it (DECISIONS.md D8). */
export interface CreateGameOptions {
  /** 3–8 players, seated anticlockwise in the order given (seat = array index). */
  players: Array<{ id: PlayerId; name: string; connected?: boolean }>;
  /**
   * Seat index of the dealer. Defaults to 0. Rotate it anticlockwise across
   * games in the same room (E6) — e.g. `(game.dealerIndex + 1) % playerCount`.
   */
  dealerIndex?: number;
  /** Deterministic shuffle for tests/demo; defaults to Math.random (D7). */
  rng?: () => number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable rejection reasons. Phase 2 relays these codes to clients (E8). */
export type PlayErrorCode =
  | 'GAME_OVER'
  | 'NOT_YOUR_TURN'
  | 'CARD_NOT_IN_HAND'
  | 'MUST_LEAD_ACE_OF_SPADES'
  | 'INVALID_PAYLOAD';

/** Rejection of a play. `code` distinguishes specific causes (AGENTS.md E8). */
export class PlayError extends Error {
  readonly code: PlayErrorCode;

  constructor(code: PlayErrorCode, message: string) {
    super(message);
    this.name = 'PlayError';
    this.code = code;
  }
}

/** Thrown on internal invariant violations (E10) — surfaces Phase 2 bugs loudly. */
export class EngineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInvariantError';
  }
}

// ---------------------------------------------------------------------------
// Deck helpers
// ---------------------------------------------------------------------------

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'] as const;
const MIN_RANK = 2;
const MAX_RANK = 14; // Ace
export const ACE_OF_SPADES_ID: CardId = 'S14';

/** Well-known card display names, used only for logs. */
const RANK_LABELS: Record<number, string> = {
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

export function cardLabel(card: Card): string {
  const rank = RANK_LABELS[card.rank] ?? String(card.rank);
  const suits: Record<Suit, string> = { C: '♣', D: '♦', H: '♥', S: '♠' };
  return `${rank}${suits[card.suit]}`;
}

/**
 * Build the standard 52-card French deck (RULES.md "Requirements": A, 2..10,
 * J, Q, K in ♣ ♦ ♥ ♠; no jokers).
 *
 * Post: 52 unique card ids, 13 per suit.
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
      deck.push({ id: `${suit}${rank}`, suit, rank });
    }
  }
  return deck;
}

/**
 * Fisher–Yates shuffle.
 *
 * Pre: `rng` returns uniform floats in [0, 1).
 * Post: returns a new array; input is not mutated. Deterministic when a seeded
 * RNG is supplied (DECISIONS.md D7).
 */
export function shuffleDeck(deck: Card[], rng: () => number = Math.random): Card[] {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Seeded deterministic RNG (mulberry32) for tests and demo bots.
 *
 * Post: repeatable uniform floats in [0, 1) for a given seed.
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

function log(state: GameState, message: string): void {
  state.seq += 1;
  state.log.push({ seq: state.seq, message });
}

function pushFalseStrike(state: GameState, playerId: PlayerId, card: Card): void {
  const bucket = state.falseStrikes[playerId] ?? [];
  bucket.push(card);
  state.falseStrikes[playerId] = bucket;
}

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) =>
    a.suit === b.suit ? a.rank - b.rank : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit),
  );
}

/**
 * Create a fresh, not-yet-dealt game.
 *
 * Pre: 3–8 players with unique ids (D21); `dealerIndex` within range if given.
 * Post: phase 'not-started', hands empty, dealerIndex set, roundNumber 0, no
 * round in progress, no loser. Does NOT shuffle or deal (D8) — call `dealCards`.
 */
export function createGame(options: CreateGameOptions): GameState {
  const { players, dealerIndex = 0, rng = Math.random } = options;

  if (!Number.isInteger(dealerIndex) || dealerIndex < 0 || dealerIndex >= players.length) {
    throw new EngineInvariantError(
      `dealerIndex ${dealerIndex} out of range for ${players.length} players`,
    );
  }
  if (players.length < 3 || players.length > 8) {
    throw new EngineInvariantError(`Kazhutakali requires 3-8 players, got ${players.length}`);
  }
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) {
    throw new EngineInvariantError('player ids must be unique');
  }

  const state: GameState = {
    players: players.map((p, seat) => ({
      id: p.id,
      seat,
      name: p.name,
      connected: p.connected ?? true,
    })),
    hands: {},
    dealerIndex,
    roundNumber: 0,
    round: null,
    discardCount: 0,
    phase: 'not-started',
    currentTurnId: null,
    loserId: null,
    log: [],
    falseStrikes: {},
    seq: 0,
  };

  for (const p of state.players) state.hands[p.id] = [];

  // Shuffle now, deal later (D8): deck order lives in state until dealCards.
  state.deck = shuffleDeck(createDeck(), rng);
  log(state, `Game created. ${players.length} players, dealer seat ${dealerIndex}.`);
  return state;
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/**
 * Deal the shuffled deck anticlockwise, one card at a time, starting at the
 * seat after the dealer (RULES.md "Game Instructions"; E1/E6).
 *
 * Pre: phase 'not-started', deck present.
 * Post: all 52 cards distributed; some players may legitimately hold one more
 * card than others (E1); phase 'in-round'; round 1 opened by the Ace of
 * Spades holder (E9); turn order skips nothing (nobody is empty yet).
 */
export function dealCards(state: GameState): void {
  if (state.phase !== 'not-started') {
    throw new EngineInvariantError(`dealCards requires phase 'not-started', got '${state.phase}'`);
  }
  const deck: Card[] = state.deck ?? [];
  if (deck.length !== 52) {
    throw new EngineInvariantError(`deck must hold 52 cards to deal, got ${deck.length}`);
  }

  const n = state.players.length;
  // Anticlockwise dealing: start right of the dealer, one card at a time (D9).
  let i = 0;
  for (const card of deck) {
    const seat = (state.dealerIndex + 1 + i) % n;
    const player = state.players[seat]!;
    state.hands[player.id]!.push(card);
    i++;
  }
  state.deck = undefined;
  state.phase = 'in-round';
  state.roundNumber = 1;

  const aceHolder = findAceOfSpadesHolder(state);
  state.round = {
    leaderId: aceHolder,
    activeSuit: null, // becomes 'S' the instant the A♠ is led (D16)
    plays: [],
    forfeited: [],
  };
  state.currentTurnId = aceHolder;
  log(state, `Cards dealt. ${aceHolder} holds the Ace of Spades and leads round 1.`);
}

/**
 * Locate the Ace of Spades holder.
 *
 * Pre: hands dealt.
 * Post: the PlayerId of whoever holds card id "S14" (E9). Throws if the deck
 * was dealt incorrectly — a missing A♠ is an invariant breach, not a game state.
 */
export function findAceOfSpadesHolder(state: GameState): PlayerId {
  for (const p of state.players) {
    if (state.hands[p.id]!.some((c) => c.id === ACE_OF_SPADES_ID)) return p.id;
  }
  throw new EngineInvariantError('Ace of Spades not found in any hand');
}

// ---------------------------------------------------------------------------
// Turn / round queries
// ---------------------------------------------------------------------------

/**
 * Players still holding at least one card, in play order.
 *
 * Post: fresh array; empty-handed players excluded (E2).
 */
export function playersWithCards(state: GameState): PlayerState[] {
  return state.players.filter((p) => state.hands[p.id]!.length > 0);
}

/**
 * Next seat (anticlockwise) after `fromId` that holds cards. Skips
 * empty-handed players (E2) and disconnected ones (AGENTS.md S1 assigns this
 * to Phase 1's advanceTurn).
 *
 * Note: may return the CURRENT player when they are the only holder left —
 * such a state is transient because `checkGameOver` (E3) ends the game before
 * the turn matters. Callers must not rely on the result to keep a lone holder
 * playing.
 *
 * Pre: at least one other player still holds cards, else returns the current
 * holder (see note) or null when the current id is unknown/none.
 */
export function advanceTurn(state: GameState): PlayerId | null {
  const n = state.players.length;
  const current = state.players.find((p) => p.id === state.currentTurnId);
  const startSeat = current ? current.seat : -1;
  for (let step = 1; step <= n; step++) {
    const seat = (startSeat + step) % n;
    const p = state.players[seat]!;
    if (!p.connected) continue; // S1: skip disconnected
    if (state.hands[p.id]!.length === 0) continue; // E2: skip empty-handed
    return p.id;
  }
  return null;
}

/**
 * Has every still-eligible player acted in the current round?
 *
 * "Eligible" = held cards when the round reached them and did not forfeit
 * (RULES.md forfeit rule) — empty-handed players are skipped, not counted
 * (E2). The leader counts once they have played. A strike forfeits everyone
 * who had not yet played, so a post-strike round is complete by definition
 * (D15); `resolveRound` will still be invoked via applyPlay.
 */
export function roundComplete(state: GameState): boolean {
  if (!state.round) return false;
  const played = new Set(state.round.plays.map((pl) => pl.playerId));
  const forfeited = new Set(state.round.forfeited);
  for (const p of playersWithCards(state)) {
    if (forfeited.has(p.id)) continue;
    if (!played.has(p.id)) return false;
  }
  return state.round.plays.length > 0;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a play attempt WITHOUT mutating anything.
 *
 * Pre: `state.phase === 'in-round'`, `cardId` is a known card id.
 * Post: throws PlayError with a specific code on every illegal case (E8):
 *   - GAME_OVER               — the game has ended
 *   - NOT_YOUR_TURN           — it is another player's turn
 *   - CARD_NOT_IN_HAND        — the player does not hold this card
 *   - MUST_LEAD_ACE_OF_SPADES — round 1 opener other than the A♠ (D16)
 *   - INVALID_PAYLOAD         — unknown card id
 * Off-suit plays while holding the suit are deliberately LEGAL (a false
 * strike, tracked silently — D11/D14).
 */
export function validatePlay(state: GameState, playerId: PlayerId, cardId: CardId): void {
  if (state.phase === 'game-over') {
    throw new PlayError('GAME_OVER', 'The game is already over.');
  }
  if (state.phase !== 'in-round' || !state.round) {
    throw new PlayError('INVALID_PAYLOAD', 'No round is in progress.');
  }
  // Payload shape first (a malformed card id must not leak whose turn it is),
  // then turn, then possession (E8).
  if (typeof cardId !== 'string' || !/^[CDHS](?:[2-9]|1[0-4])$/.test(cardId)) {
    throw new PlayError('INVALID_PAYLOAD', `Unknown card id: ${String(cardId)}`);
  }
  if (state.currentTurnId !== playerId) {
    throw new PlayError('NOT_YOUR_TURN', `It is not ${playerId}'s turn.`);
  }
  const hand = state.hands[playerId] ?? [];
  if (!hand.some((c) => c.id === cardId)) {
    throw new PlayError('CARD_NOT_IN_HAND', `${playerId} does not hold card ${cardId}.`);
  }
  if (state.roundNumber === 1 && state.round.plays.length === 0 && cardId !== ACE_OF_SPADES_ID) {
    throw new PlayError('MUST_LEAD_ACE_OF_SPADES', 'Round 1 must be opened with the Ace of Spades.');
  }
}

// ---------------------------------------------------------------------------
// Playing cards
// ---------------------------------------------------------------------------

/**
 * Attempt to play `cardId` from `playerId`'s hand.
 *
 * Pre: `validatePlay`'s conditions.
 * Post (success): card removed from hand, appended to the round with strike
 * bookkeeping; if the play is a strike, every eligible player who had not yet
 * acted forfeits and the round resolves immediately (D15); otherwise the turn
 * advances (E2) and, when that completes the round, the round resolves.
 * **Round resolution is automatic** — callers do not need to poll
 * `roundComplete` and call `resolveRound`; those exports remain for explicit
 * control and tests (D22). `checkGameOver` runs after every mutation. On ANY
 * PlayError the state is untouched (validate-then-mutate).
 */
export function applyPlay(state: GameState, playerId: PlayerId, cardId: CardId): void {
  validatePlay(state, playerId, cardId);
  const round = state.round!;
  const hand = state.hands[playerId]!;
  const idx = hand.findIndex((c) => c.id === cardId);
  const card = hand[idx]!;

  const roundJustOpened = round.plays.length === 0;
  if (roundJustOpened) {
    round.activeSuit = card.suit; // opener declares the active suit (RULES.md)
  }
  const activeSuit: Suit = round.activeSuit!;
  const offSuit = card.suit !== activeSuit;
  // Snapshot at play time: did they hold the active suit despite striking?
  const heldSuit = hand.some((c) => c.suit === activeSuit && c.id !== cardId);
  const wasFalseStrike = offSuit && heldSuit;

  // ---- mutation starts (all validation passed) ----
  hand.splice(idx, 1);
  round.plays.push({ playerId, card, strikeDeclared: offSuit, wasFalseStrike });
  if (wasFalseStrike) pushFalseStrike(state, playerId, card);
  // The log is shipped to ALL clients via views, so it must be identical for
  // true and false strikes — announcing "false" here would leak the secret
  // that mode (b) depends on keeping hidden (DECISIONS.md D10/D11).
  log(state, `${playerId} plays ${cardLabel(card)}${offSuit ? ' (strike)' : ''}.`);

  if (offSuit) {
    // Strike: remaining players forfeit, round resolves now (RULES.md, D15).
    const played = new Set(round.plays.map((pl) => pl.playerId));
    for (const p of playersWithCards(state)) {
      if (!played.has(p.id)) {
        round.forfeited.push(p.id);
        log(state, `${p.id} forfeits their turn (strike).`);
      }
    }
    resolveRound(state);
  } else if (roundComplete(state)) {
    resolveRound(state);
  } else {
    const next = advanceTurn(state);
    state.currentTurnId = next;
  }

  checkGameOver(state);
}

// ---------------------------------------------------------------------------
// Round resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the current round.
 *
 * Pre: `state.round` exists and `plays` is non-empty (E10 — throws loudly,
 * never silently returns a broken state).
 * Post: the collector is the player of the highest card of the *originally
 * declared* `activeSuit` (E4 — struck cards' suits are irrelevant; unique
 * cards guarantee no tie, RULES.md). If any strike occurred the whole pile
 * goes back to the collector's hand (D13); otherwise all played cards are
 * discarded permanently. The collector leads the next round; `checkGameOver`
 * runs at the end.
 */
export function resolveRound(state: GameState): void {
  const round = state.round;
  if (!round) throw new EngineInvariantError('resolveRound called with no active round');
  if (round.plays.length === 0) {
    // E10: fail loudly so Phase 2 bugs surface in dev instead of corrupting state.
    throw new EngineInvariantError(
      'resolveRound called with empty cardsPlayedThisRound — roundComplete gating was violated',
    );
  }

  const activeSuit: Suit = round.activeSuit ?? (() => {
    throw new EngineInvariantError('round resolved before the active suit was declared');
  })();

  // Collector: highest rank among plays of the active suit ONLY (E4, D15).
  const suitPlays = round.plays.filter((pl) => pl.card.suit === activeSuit);
  if (suitPlays.length === 0) {
    throw new EngineInvariantError(
      `no play of the declared active suit ${activeSuit} found — round bookkeeping is corrupt`,
    );
  }
  const collector = suitPlays.reduce(
    (best, pl) => (pl.card.rank > best.card.rank ? pl : best),
    suitPlays[0]!,
  );

  const anyStrike = round.plays.some((pl) => pl.strikeDeclared);
  const pileCards = round.plays.map((pl) => pl.card);

  if (anyStrike) {
    // Whole pile returns to the collector's hand (RULES.md strike rule, D13).
    state.hands[collector.playerId]!.push(...pileCards);
    state.hands[collector.playerId] = sortCards(state.hands[collector.playerId]!);
    log(
      state,
      `Strike! ${collector.playerId} collects ${pileCards.length} card(s) with ${cardLabel(collector.card)}.`,
    );
  } else {
    state.discardCount += pileCards.length;
    log(state, `All followed. ${collector.playerId} led the highest ${activeSuit} (${cardLabel(collector.card)}); pile discarded.`);
  }

  state.roundNumber += 1;

  // Empty-handed players cannot lead (E2); if the collector emptied their hand
  // by discarding, leadership passes anticlockwise to the next player holding
  // cards. Zero holders possible via simultaneous final discard (D19).
  const holders = playersWithCards(state);
  if (holders.length === 0) {
    state.round = null;
    state.currentTurnId = null;
    return;
  }
  const collectorStillIn = state.hands[collector.playerId]!.length > 0;
  let nextLeader: PlayerId;
  if (collectorStillIn) {
    nextLeader = collector.playerId;
  } else {
    // Collector discarded their last card: leadership passes anticlockwise to
    // the next holder after the collector (their left, in play order).
    const collectorSeat = state.players.find((p) => p.id === collector.playerId)!.seat;
    const n = state.players.length;
    let found: PlayerId | null = null;
    for (let step = 1; step <= n && !found; step++) {
      const p = state.players[(collectorSeat + step) % n]!;
      if (state.hands[p.id]!.length > 0) found = p.id;
    }
    if (!found) {
      throw new EngineInvariantError('no player available to lead the next round');
    }
    nextLeader = found;
  }

  state.round = {
    leaderId: nextLeader,
    activeSuit: null, // next round's suit chosen by its opener (RULES.md)
    plays: [],
    forfeited: [],
  };
  state.currentTurnId = nextLeader;
  log(state, `Round ${state.roundNumber - 1} resolved. ${nextLeader} leads round ${state.roundNumber}.`);
}

// ---------------------------------------------------------------------------
// Game end
// ---------------------------------------------------------------------------

/**
 * End-condition check. Runs after every mutation.
 *
 * Post: if exactly one player still holds cards (E3) the game ends and that
 * player is `loserId` — even mid-round, without playing anything further. If
 * nobody holds cards (D19 simultaneous final discard) the game ends with
 * `loserId: null`. Otherwise state is unchanged.
 */
export function checkGameOver(state: GameState): void {
  if (state.phase === 'game-over') return;
  if (state.phase !== 'in-round') return;

  const holders = playersWithCards(state);
  if (holders.length === 1) {
    // Book any still-on-the-table played cards into the last holder's hand so
    // `held + discardCount` always equals 52 (mid-round E3 termination would
    // otherwise strand the in-flight pile).
    if (state.round && state.round.plays.length > 0) {
      const stranded = state.round.plays.map((pl) => pl.card);
      state.hands[holders[0]!.id]!.push(...stranded);
      log(
        state,
        `Unfinished pile (${stranded.length} card(s)) left on the table goes to ${holders[0]!.id}.`,
      );
    }
    state.phase = 'game-over';
    state.loserId = holders[0]!.id;
    state.currentTurnId = null;
    state.round = null;
    log(state, `Game over — ${holders[0]!.id} is the Kazhuta!`);
  } else if (holders.length === 0) {
    state.phase = 'game-over';
    state.loserId = null;
    state.currentTurnId = null;
    state.round = null;
    log(state, 'Game over — every hand emptied simultaneously; no Kazhuta this game.');
  }
}

// ---------------------------------------------------------------------------
// False strikes (E7, mode (b) — DECISIONS.md D10–D12)
// ---------------------------------------------------------------------------

/**
 * Was `play` a false strike?
 *
 * Post: true iff the player was off-suit while holding a card of the active
 * suit *at that moment* (D11 snapshot). Pure query over the play record.
 */
export function isFalseStrike(play: PlayedCard): boolean {
  return play.wasFalseStrike;
}

/**
 * Resolve a "Challenge!" by `challengerId` accusing `accusedId` of a false
 * strike (E7 mode (b), D12).
 *
 * Pre: game in progress; challenger is a seated player.
 * Post: on a successful challenge the accused is IMMEDIATELY the loser and the
 * game is over (RULES.md: "If caught within a game, the player is immediately
 * declared the loser, ending the game."). On failure: log only, no penalty,
 * state otherwise unchanged (RULES.md: "If undetected within a game, there is
 * no penalty"). Returns true iff the challenge succeeded.
 */
export function resolveChallenge(state: GameState, challengerId: PlayerId, accusedId: PlayerId): boolean {
  if (state.phase === 'game-over') {
    throw new PlayError('GAME_OVER', 'The game is already over.');
  }
  const accused = state.players.find((p) => p.id === accusedId);
  if (!accused) {
    throw new PlayError('INVALID_PAYLOAD', `${accusedId} is not a player in this game.`);
  }
  const challenger = state.players.find((p) => p.id === challengerId);
  if (!challenger) {
    throw new PlayError('INVALID_PAYLOAD', `${challengerId} is not a player in this game.`);
  }
  if (challengerId === accusedId) {
    throw new PlayError('INVALID_PAYLOAD', 'You cannot challenge yourself.');
  }

  const evidence = state.falseStrikes[accusedId] ?? [];
  if (evidence.length > 0) {
    state.phase = 'game-over';
    state.loserId = accusedId;
    state.currentTurnId = null;
    state.round = null;
    log(state, `${challengerId} challenged ${accusedId} — CHALLENGE SUCCEEDED. ${accusedId} is the Kazhuta!`);
    return true;
  }
  log(state, `${challengerId} challenged ${accusedId} — challenge failed; no evidence of a false strike.`);
  return false;
}

// ---------------------------------------------------------------------------
// Views (network redaction)
// ---------------------------------------------------------------------------

/** Redacted, non-authoritative projection of the game for a specific player. */
export interface PlayerView {
  phase: GamePhase;
  roundNumber: number;
  players: Array<{ id: PlayerId; seat: number; name: string; connected: boolean; cardCount: number }>;
  yourHand: Card[];
  currentTurnId: PlayerId | null;
  activeSuit: Suit | null;
  playedThisRound: Array<{ playerId: PlayerId; card: Card }>;
  discardCount: number;
  /** Players in the current round who forfeited (strike happened). */
  forfeited: PlayerId[];
  loserId: PlayerId | null;
  log: LogEntry[];
}

/** Fully redacted view for spectators / lobby listings. */
export interface PublicView {
  phase: GamePhase;
  roundNumber: number;
  players: Array<{ id: PlayerId; seat: number; name: string; connected: boolean; cardCount: number }>;
  currentTurnId: PlayerId | null;
  activeSuit: Suit | null;
  playedThisRoundCount: number;
  discardCount: number;
  forfeitedCount: number;
  loserId: PlayerId | null;
  log: LogEntry[];
}

/**
 * Project the state for one player. Contains ONLY their own hand plus public
 * information — never another player's cards and never `falseStrikes`
 * (AGENTS.md security principle; D11).
 *
 * Pre: `playerId` must be a seated player (throws EngineInvariantError on an
 * unknown id so callers cannot silently get an empty view of someone else).
 * Post: fresh object graph; safe to JSON-serialize to that socket.
 */
export function toPlayerView(state: GameState, playerId: PlayerId): PlayerView {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    throw new EngineInvariantError(`toPlayerView called for non-seated player ${playerId}`);
  }
  return {
    phase: state.phase,
    roundNumber: state.roundNumber,
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      cardCount: state.hands[p.id]!.length,
    })),
    yourHand: sortCards(state.hands[playerId]!),
    currentTurnId: state.currentTurnId,
    activeSuit: state.round?.activeSuit ?? null,
    playedThisRound: (state.round?.plays ?? []).map((pl) => ({ playerId: pl.playerId, card: pl.card })),
    discardCount: state.discardCount,
    forfeited: [...(state.round?.forfeited ?? [])],
    loserId: state.loserId,
    log: [...state.log],
  };
}

/**
 * Project the state for spectators / pre-game lobby. No hands at all, and no
 * false-strike records (D11).
 *
 * Post: fresh object graph; safe to JSON-serialize to anyone.
 */
export function toPublicView(state: GameState): PublicView {
  return {
    phase: state.phase,
    roundNumber: state.roundNumber,
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      cardCount: state.hands[p.id]!.length,
    })),
    currentTurnId: state.currentTurnId,
    activeSuit: state.round?.activeSuit ?? null,
    playedThisRoundCount: state.round?.plays.length ?? 0,
    discardCount: state.discardCount,
    forfeitedCount: state.round?.forfeited.length ?? 0,
    loserId: state.loserId,
    log: [...state.log],
  };
}

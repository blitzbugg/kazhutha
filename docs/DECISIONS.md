# Architectural Decision Log — Kazhutakali

Non-obvious choices made while building this project, newest phase first. A future
session (human or agent) should be able to reconstruct the *why* from this file
without reverse-engineering the code. Superseded decisions are struck through, not
deleted.

## Phase 1 — Core engine

| # | Decision | Rationale / alternatives |
|---|----------|--------------------------|
| D1 | **Reference `engine.ts`/`demo.ts` did not exist in the repo; engine written fresh** against the Phase 1 function list in AGENTS.md | User confirmed (asked explicitly). AGENTS.md said to extend rather than rewrite, but there was nothing to extend. The Phase 1 required-function list + edge-case table was the contract. |
| D2 | **Canonical rules source is `docs/RULES.md`** — it already existed on disk, so no copy was made. All rule interpretations below cite it. | AGENTS.md §0.1: "Copy the rules document into `docs/RULES.md`". It was already present and complete; verbatim copy of the user's source. |
| D3 | **Testing framework: `node:test` executed via `tsx`** (`npm test` → `tsx --test tests/*.test.ts`) | AGENTS.md Phase 1 exit criteria offered `node:test` or vitest. `node:test` is built into Node ≥20, keeps the engine testable with zero test-framework dependencies, and preserves the "engine importable in a plain Node script" criterion. vitest rejected for now: extra dependency for no Phase-1 benefit; can be adopted in Phase 2/3 if the UI needs component tests. |
| D4 | **ESM project** (`"type": "module"`, NodeNext module resolution) | Modern Node default; matches Socket.IO v4 server/client packaging for Phase 2. |
| D5 | **Dev-only dependencies** (`typescript`, `tsx`, `@types/node`) — zero runtime dependencies | Phase 1 must be pure logic with no I/O. Phase 2 will add `socket.io`, `express`, `zod` as the first runtime deps. |
| D6 | **Cards have a string `id`** (`"S14"` = Ace of Spades, `"H11"` = Jack of Hearts) alongside `suit`/`rank` | Hands, piles and payloads need a stable, JSON-serializable, human-debuggable identity; Phase 2 socket payloads can then reference cards by `id` instead of shipping structured objects. |
| D7 | **`shuffleDeck` uses an injectable RNG; `createGame` accepts optional `rng`** (seeded `mulberry32` provided for tests/demo) | AGENTS.md requires "RNG-injectable for deterministic tests". Default falls back to `Math.random` for production dealing. |
| D8 | **`createGame` is separate from dealing**: it fixes seat order + dealer, leaves hands empty until `dealCards` | AGENTS.md E6 wants `dealerIndex` at game creation and E9 wants the Ace-of-Spades holder located for round 1. Separating setup from the shuffle/deal lets `createGame` validate 3–8 players and dealer rotation without RNG, and mirrors the physical flow (pick dealer → shuffle → deal). |
| D9 | **Anticlockwise play order = ascending seat index mod N**; dealing starts at seat `(dealerIndex + 1) % N`, one card at a time | RULES.md: "deals the cards face down, one at a time, in an anti-clockwise direction"; E1 explicitly allows uneven distribution (some players get one more card). Play order and deal order are the same direction. |
| D10 | **False-strike mode: (b) Challenge!** — strikes are recorded silently server-side; the loser is determined only by hand size, *unless* a successful `resolveChallenge` pins it on a false striker | User confirmed after being asked (AGENTS.md E7 forbids assuming). See D11/D12 for the mechanics. |
| D11 | **False strikes are tracked per play with a play-time snapshot** (`wasFalseStrike` = player was off-suit *and* held an active-suit card at that moment) | Prevents false positives if the player later collects cards of the suit they appeared not to hold. `falseStrikes` lives in `GameState` as server-only truth and is **excluded from `toPublicView`/`toPlayerView`** — that's what preserves the deception (RULES.md: "It is easy to get caught because, ultimately, all cards must be revealed"). |
| D12 | **A successful challenge makes the accused the loser immediately** (`loserId`, game over), per RULES.md "If caught within a game, the player is immediately declared the loser, ending the game." A failed challenge is logged and carries no penalty (RULES.md: "If undetected within a game, there is no penalty"). Challenges are allowed until the game is over. | Directly implements mode (b); Phase 2 will expose this as `game:challenge-strike`. |
| D13 | **Collected cards return to the collector's hand; only all-follow rounds grow the discard pile** | RULES.md strike rule: "The player who played the highest-value card of the active suit collects all cards of that suit in play, along with the striking card." The game's end condition is "the last player *holding* cards" — so collected cards must be held again, not discarded. |
| D14 | **`validatePlay` permits off-suit plays even when the player holds the active suit** | A false strike is a legal-but-dishonest *move*, not an engine-level illegal move (RULES.md treats it under "Penalties", not under following suit). Server-side detection is what makes the game work; rejecting it client-side would delete the game's core bluff mechanic. |
| D15 | **At most one strike can actually happen per round** (after a strike, every not-yet-played player forfeits their turn and the round resolves), but `resolveRound` tolerates multiple struck cards and always resolves via `activeSuit` only | RULES.md: "Remaining players forfeit their turn". The tolerance covers the E4 worst case and any future variant without changing the collector formula: collector = highest card of the *originally declared* suit among plays. |
| D16 | **Round 1's opening lead is forced to be the Ace of Spades** (validatePlay rejects any other opener in round 1) | RULES.md: "The player holding the Ace of Spades begins the first round by revealing it". Rounds ≥ 2 pick the suit freely via the opening card (E9: Ace-of-Spades logic is never applied again). |
| D17 | **Players with 0 cards are skipped by `advanceTurn` and excluded from round-completion counts; they cannot regain cards.** Exception: a player who plays their *last* card into a round where a strike occurs wins the collection and stays in (the pile returns to their hand). | E2 (skip empty players) + D13 (collection returns cards). The exception is forced by D13's reading: RULES.md says the collector "starts the next round", which an eliminated player could not do. |
| D18 | **`validatePlay` rejects out-of-turn plays before any mutation, so RULES.md's "playing out of turn" penalties are unreachable in the digital engine** | E8 requires a *specific* rejection. The physical-game penalty (retrieve the card / collect the pile) is a human arbitration mechanism; the server simply never allows the illegal play. Documented as a deliberate simplification, not an omission. |
| D19 | **Zero players holding cards after a round resolves** (possible only via a simultaneous final discard in an all-follow round) ends the game with `loserId: null` — "no Kazhuta" | RULES.md defines the loser as "the last player holding cards"; if nobody holds cards there is no loser. Must not crash (invariant: E3's check runs after every state change). |
| D20 | **`resolveRound` throws on empty `round.plays`** (E10) and `applyPlay` asserts hands stay ≤ 52 cards | AGENTS.md E10: "add an assertion/throw rather than silently returning a broken state". |
| D21 | **`createGame` throws on `< 3` players** at engine level | RULES.md: "A group of 3 to 8 players". Phase 2's S8 rejection then has a structural backstop. |
| D22 | **`applyPlay` auto-resolves a round the moment it completes** — including strike rounds, which are complete by forfeit (D15). `roundComplete`/`resolveRound` remain exported for explicit control and tests, but callers do not need them. | Single-entry-point state machine: Phase 2's socket handlers then only ever call `applyPlay`/`resolveChallenge`, eliminating a class of "forgot to resolve" bugs. All post-completion assertions must observe outcomes (hands, next leader, log), not the transient round record. |
| D23 | **`validatePlay` checks payload shape before turn/possession**, with a strict card-id regex (`^[CDHS](2-9|1[0-4])$`) | A malformed payload from any player gets `INVALID_PAYLOAD` instead of `NOT_YOUR_TURN` — otherwise the error channel could leak whose turn it is to a sniffing client. Surfaced by a test that found the original order reported `NOT_YOUR_TURN` for a garbage id. |
| D24 | **When E3 ends the game mid-round, any cards already on the table are booked into the last holder's hand** | Preserves the global invariant `held + discardCount === 52` (physically: the last player at the table sweeps the pile). Without it, a mid-round E3 termination stranded the in-flight pile and conservation tests failed. |
| D25 | **Card ids are strictly numeric (`S14`, not `SA`)** and `advanceTurn` may return the current player when they are the sole holder (that state is transient — E3 ends it); both documented in JSDoc | Contract precision for Phase 2: the socket layer will map client card ids 1:1 onto engine ids, and the turn-advance quirk must not be "fixed" into an error that freezes a lone holder's client. |

## Known limitations

- **Server restart loses all game state.** Phase 2 keeps rooms in memory only
  (AGENTS.md S12 explicitly defers persistence to Phase 4, if ever). Restarting the
  process mid-game abandons the match; no auto-save exists by design.
- **Failed challenges are free.** RULES.md specifies no penalty for an unsuccessful
  challenge, so none is applied. If this enables challenge-spam griefing in practice,
  revisit with the user before adding a cooldown.

## Open questions / deferred to later phases

- Phase 2 socket contract for E7 mode (b): `game:challenge-strike` event shape —
  must decide per-player challenge rate limits (S6) and whether spectators can see
  `falseStrikes` after game over (pending user input at Phase 2 start).
- Phase 4: whether persistence (Postgres + Prisma) is wanted at all — must ask user
  per AGENTS.md general rule 3.

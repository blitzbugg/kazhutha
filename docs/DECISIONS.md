# Architectural Decision Log — Kazhutakali

Non-obvious choices made while building this project, newest phase first. A future
session (human or agent) should be able to reconstruct the *why* from this file
without reverse-engineering the code. Superseded decisions are struck through, not
deleted.

## Phase 2 — Socket.IO room/session server

| # | Decision | Rationale / alternatives |
|---|----------|--------------------------|
| D26 | **Offline seats KEEP receiving the turn and are auto-played after a grace timer** (default 90s) rather than being skipped or removed from rounds | AGENTS.md S1 mandates grace + auto-play. Skipping offline holders would freeze rounds: engine `roundComplete` counts all holders (correct per E2), so a skipped-but-counting player is a deadlock. Auto-play is also the honest simulation of "the player would eventually act". `ensureTurnTimers` is a systemic safety net called on every store emit, covering the case where the turn *arrives* while the player is already offline. |
| D27 | **Two-layer identity: secret `sessionToken` (control key, server-issued, 24 CSPRNG bytes) vs public `playerId` (opaque label, safe to broadcast)** | AGENTS.md S2. Client JSON can never grant control — guessing a token is infeasible, and a token only works in the room that issued it. Public ids let any player challenge any other without leaking control. Names are display-only (duplicates allowed). |
| D28 | **Room codes: 5 chars from an unambiguous alphabet** (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no 0/O, 1/I/L) | Human-shareable by design; dictation-safe. Collision-retry on allocation; 30-bit space is ample for in-memory rooms. |
| D29 | **All wall-clock behavior injected via `StoreClock`** (`now()`/`setTimeout`/`clearTimeout`); production passes real timers, tests pass a virtual clock | Deterministic S1/S3/S6 tests with zero sleeps in store tests (`fc.advance(30_000)` fires grace timers synchronously). Mirrors Phase 1's injectable RNG philosophy. |
| D30 | **Auto-play card choice: lowest-rank legal card, preferring to follow the active suit** | Minimizes harm to the absent player: following suit avoids the false-strike record (D11) and losing strikes; lowest rank avoids winning collections they'd then have to burn. Chosen over "random legal card" (unfair) and "highest card" (griefing the absent player). |
| D31 | **Challenge cooldown: 10s between challenges from one seat** (store-enforced, `CHALLENGE_COOLDOWN`) | Failed challenges are free (RULES.md), so without a cooldown the E7 accusation event doubles as a polling oracle for challenge-spam. Cooldown makes oracle use expensive without touching game rules. |
| D32 | **Seat connectivity is NEVER written into `state.players[].connected`** — views are patched per socket from live Seat state instead | Critical: engine `advanceTurn` reads `p.connected` and would skip offline holders, but `roundComplete` counts all holders — skipping mid-round freezes the game (see D26). Round completion stays connection-blind on purpose; presence is a *presentation* concern. Reconnecting never invalidates plays made meanwhile. |
| D33 | **`applyPlay` auto-resolves completing rounds (D22), so the store captures a `lastResolution` snapshot per room** and the socket layer emits one `game:round-resolved` per actual resolution | By fanout time `state.round` is already the NEXT round; without the snapshot the resolution event would be unobservable. Consumed-once semantics prevent duplicate events. |
| D34 | **Event names: `game:challenge` (client→server) + `challenge:result` unicast (server→challenger)** — supersedes Phase 1's anticipated `game:challenge-strike` | The result detail (succeeded/failed) must NOT be broadcast: a broadcast would leak exactly who holds off-suit cards to everyone watching. Only the challenger learns their own result; everyone else infers only what the subsequent state/log shows (D10/D12). |
| D35 | **Per-room mutation serialization via promise chains** (`runExclusive`), not a global lock | S10 requires total order per room; Socket.IO interleaves events across sockets. A promise chain per room keeps rooms independent (S1) and avoids head-of-line blocking across rooms. Only `game:play-card` / `game:again` / `game:challenge` queue — lobby ops are already naturally ordered. |
| D36 | **S6 is two-layer: per-socket connect-op spacing (1s, socket layer) + per-seat action interval (250ms, store)** | Connect-op spacing stops room-code brute force; action spacing stops turn-tick spam. Both floor-bounded, both sender-visible via `RATE_LIMITED`. |
| D37 | **`room:leave` semantics: lobby leave removes the seat permanently; mid-game leave is treated as a disconnect** (hand retained, grace auto-play finishes the game) | Losing a seated player's dealt hand on accidental leave would corrupt the game; the seat can resume via token. The leaving socket stays in the Socket.IO room so late broadcasts (`room:closed`) still reach it. |
| D38 | **Spectator fallback happens in the socket layer** — the store's `joinRoom` throws `ROOM_FULL`, and the handler converts it into a spectator join | Keeps the store a pure model (no implicit mode switches) while S7 gives clients a graceful fallback instead of a dead end. Spectators get `PublicView` only (S5). |
| D39 | **Sockets are keyed by `socket.data` session objects; every inbound event re-derives authority from the bound context** — no trust in payload-declared identity | Only `room:create` / `room:join` (which carry the secret token when resuming) may mint a context; all other events act through it. `hello` + `error` are the only events sent before a context exists. |

### Phase 2 engine-view note

`patchViewPresence` overrides `players[].connected` in every shipped view from live Seat state (D32) — the ONLY place seat connectivity reaches client output.

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
  process mid-game abandons the match; no auto-save exists by design. Clients can
  detect this (`room:join` with a token → fresh seat) but cannot recover the match.
- **Failed challenges are free, but rate-limited.** RULES.md specifies no penalty
  for an unsuccessful challenge; D31 adds a 10s per-seat cooldown so accusations
  can't be used as a cheap false-strike oracle. Tune `challengeCooldownMs` if
  playtesting shows it's too tight or loose.

## Open questions / deferred to later phases

- ~~Phase 2 socket contract for E7 mode (b)~~ — resolved as `game:challenge` +
  unicast `challenge:result` (D34), with a per-seat cooldown (D31).
- Whether `falseStrikes` should be REVEALED to everyone after game over (a
  post-game "here's who bluffed" screen). Current default: views never contain
  them, even after game over (D11/D34). The engine retains the data server-side,
  so Phase 3 can add an opt-in reveal event without schema changes — needs user
  preference.
- ~~Phase 3: UI framework and whether the client bundles (Vite) or stays separate.~~
  — resolved as React 19 + Vite SPA served by the game server (D41).
- Phase 4: whether persistence (Postgres + Prisma) is wanted at all — must ask user
  per AGENTS.md general rule 3.

## Phase 3 — Browser client (D40–D47)

| # | Decision | Rationale / alternatives |
|---|----------|--------------------------|
| D40 | **`shared/protocol.ts`** — dependency-free module with all socket event names, payload types and the `ErrorCode` union; imported by both server and client. | Server `types.ts` previously duplicated this and had `'GAME_OVER'` listed twice. The client needs the contract without importing zod/socket.io server code. Alternative (codegen from zod) rejected as overkill for ~15 events. |
| D41 | **Client stack: React 19 + Vite + socket.io-client; production build served as static files by the same Express server** (`server/index.ts` serves `dist/`, SPA fallback). | Single origin in production → no CORS, session tokens stay same-origin, one process to run. Vite dev server proxies `/socket.io` for HMR during development. Frameworks considered: vanilla TS (more boilerplate for reactive views), Svelte/Solid (smaller but new deps). |
| D42 | **`client/rules.ts` mirrors `validatePlay`** (turn check → round-1 A♠ opener → active-suit follow with off-suit fallback) to drive playability badges (U1/U2); the server remains the sole authority. `tests/clientRules.test.ts` pins the mirror against engine behavior so it can't drift silently. | A client that can't predict legality gives terrible UX (click → server error). The mirror is advisory only: the server still rejects anything illegal, so drift can't corrupt state, only UX. |
| D43 | **Session resume UX (S2/U5): same-transport reconnects auto-resume silently; a fresh page load shows an explicit "Rejoin room" button** instead of silently re-seating. Tokens persist in `localStorage` per room. | Auto-joining on page load would make it impossible to deliberately leave a room or switch accounts; the button makes resumption a visible choice. Verified live: reload mid-game → button → seat/hand intact. |
| D44 | **`EventLog` humanizes raw player ids → display names.** Engine log lines contain ids by design (server doesn't know viewer context); the client owns presentation. | Raw ids leaked into the UI in the first live run ("0o0p233p0v2l plays A♠") — fixed by resolving ids against `view.players` at render time. |
| D45 | **ChallengeBar v1 (superseded): round-scoped, shown only while a strike sat on the table.** | Seemed right but was stricter than the game: see D46. Kept here because the *reason* it failed is the interesting part. |
| D46 | **ChallengeBar v2: strikers derived from the whole-game public log** (`"<id> plays <card> (strike)."` lines), bar available all game. Two engine facts forced this: (a) challenges are valid at any time — `resolveChallenge` consults the whole-game `falseStrikes` record which never expires; (b) a strike that auto-resolves in the same engine call (last follower forfeits) is never visible "on the table", so the log is the only durable public record. | Live discovery: challenge against a logged striker failed with "no evidence" — which exposed the deeper rule that the evidence record only contains TRUE false strikes (off-suit played while still holding the active suit), not forced strikes (off-suit with none held). The UI cannot and must not distinguish them: that's the hidden information mode (b) is built on. |
| D47 | **Grace auto-play verified live, not just in tests:** a rematch seat left AWAY through the whole 90s window was auto-played by the server (its A♠ opener), unblocking the round. Presence badges (AWAY) come from live seat state patched into views (D32), never written into engine state. | Confirms the Phase 2 S1 design end-to-end under real reconnect timing. |

## Open questions / deferred to later phases (Phase 3 additions)

- Whether `falseStrikes` should be revealed on a post-game screen — still open,
  unchanged by Phase 3 (views contain them never; D11/D34).

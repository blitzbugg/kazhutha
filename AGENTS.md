# AGENTS.md — Kazhuta (Kazhutakali) Multiplayer Card Game

This file is the operating brief for any AI coding agent (Claude Code) working on this
repository. Read it fully before writing code. Work through the phases **in order** —
each phase has explicit exit criteria; do not start the next phase until the current
one's criteria are met.

---

## 0. Project Summary

A web-based multiplayer implementation of **Kazhutakali**, a Kerala trick-avoidance
card game. Players shed cards by following suit; whoever is last holding cards is the
"Kazhuta" (loser). Full rules are in `docs/RULES.md` (see §0.1) — **read that file
before implementing any game logic.** Do not infer rules from card-game genre
conventions; this game has specific mechanics (strikes, collection, false-strike
penalties) that differ from typical shedding games like Uno or Crazy Eights.

### 0.1 Canonical rules source
Copy the rules document into `docs/RULES.md` at the start of the project. Every
ambiguity in this brief should be resolved by re-reading that file, not by guessing.

### Tech stack (fixed — do not substitute without asking the user)
- **Frontend:** React 19 (Vite), TypeScript, plain SPA — no meta-framework, no
  server-side rendering, no file-based routing needed for this app
- **Real-time:** Socket.IO (server + client)
- **Server runtime:** Node.js running a standalone Express + Socket.IO server,
  separate from the frontend build — the React app is a static SPA that connects
  to it over a WebSocket URL (configurable via env var for local vs. deployed)
- **Persistence (optional, Phase 4 only):** PostgreSQL + Prisma for match history /
  stats. Do not add a database in Phases 1–3 — game state lives in memory.
- **Package manager:** npm (match existing project conventions if this is added to
  an existing repo)

### Non-negotiable architecture principle
**The server is the single source of truth.** No game rule is ever enforced
client-side only. A malicious or buggy client must never be able to:
- see another player's hand
- play a card it doesn't hold
- play out of turn
- claim "no suit" while holding the suit, undetected by the server

Every phase's acceptance criteria include a check for this.

---

## Phase 1 — Core Game Engine (pure logic, no I/O)

**Status: reference implementation exists at `engine.ts` / `demo.ts` (already
written and type-checked). Use it as the starting point — read it fully, then
extend it to close the gaps below rather than rewriting from scratch.**

### Scope
Pure TypeScript functions operating on a `GameState` object. No sockets, no
database, no rendering. Fully unit-testable without mocking anything.

### Required functions (extend existing engine.ts)
- `createDeck`, `shuffleDeck` (RNG-injectable for deterministic tests)
- `dealCards` (anticlockwise, uneven distribution allowed)
- `findAceOfSpadesHolder` (round-1 starter only)
- `validatePlay` / `applyPlay` (throws on illegal moves, never mutates on failure)
- `advanceTurn`, `roundComplete`, `resolveRound`
- `isFalseStrike` — see Edge Case E7 below for the design decision required here
- `toPublicView` / `toPlayerView` — hand redaction for network transmission
- `checkGameOver`

### Edge cases Phase 1 MUST handle (write a unit test for each)

| ID | Case | Required behavior |
|----|------|--------------------|
| E1 | 52 cards don't divide evenly among players (3, 5, 6, 7, 8 players) | Deal proceeds anticlockwise one at a time; some players legitimately end up with one more card than others. No error. |
| E2 | A player empties their hand mid-game | They are skipped in all future turns and round-completion counts; they cannot be dealt back in. |
| E3 | Only one player has cards left | Game ends immediately; that player is `loserId`. Do not wait for them to "play out" an empty round. |
| E4 | Everyone strikes in the same round (no one follows the original suit) | Highest card of the *originally declared* active suit — even though no one else played that suit again after round 1's leader — still determines the collector. Verify against `docs/RULES.md` for the exact tie-break: since each card is unique, there is never an actual tie, but confirm the collector calculation only considers `activeSuit`, not the struck cards' suits. |
| E5 | A player has zero cards of any suit that could ever strike (down to 1 card) | Still must follow suit if they hold it; otherwise their single card is a strike by definition. Engine must not special-case "last card." |
| E6 | Dealer rotation across multiple games in the same room | Dealer position rotates anticlockwise each new game; the engine's `createGame` should accept a `dealerIndex` / `startIndex` param rather than always defaulting to seat 0. |
| E7 | **False-strike detection — design decision required, do not silently pick one:** | Two valid modes: **(a) Server auto-penalizes** the instant `isFalseStrike` returns true — ends the game immediately, that player is declared loser regardless of hand size. **(b) Manual "Challenge!" mode** — the server tracks the fact silently (for later reveal) and only penalizes if another player invokes a `challenge` action before the accused player's suit is later proven false by their own subsequent play. **Ask the user which mode they want before building Phase 2's socket contract for this**, since it changes the event shape. Default assumption if unanswered: mode (b), since it preserves the social-deception fun the rules explicitly call out. |
| E8 | Playing out of turn | Rejected by `validatePlay` with a specific error distinguishing "not your turn" from "you don't hold that card" — Phase 2's socket layer needs to relay the correct one to the client. |
| E9 | Round-1 special case: first player is fixed by Ace of Spades, not by dealer position | `createGame` must locate the Ace of Spades holder for round 1 regardless of dealer seat, but subsequent rounds use normal winner/collector rotation, not Ace-of-Spades logic again. |
| E10 | Empty `cardsPlayedThisRound` when `resolveRound` is called | Should never happen if `roundComplete` gating is respected — add an assertion/throw rather than silently returning a broken state, so Phase 2 bugs surface loudly in dev. |

### Phase 1 exit criteria
- [ ] All 10 edge cases above have a passing unit test (use `node:test` or `vitest`
      — pick one and note the choice in `docs/DECISIONS.md`)
- [ ] `demo.ts`-style bot simulation runs to completion for 3, 4, 6, and 8 player
      counts without throwing
- [ ] Every exported function has a JSDoc comment describing pre/post-conditions
- [ ] Zero dependencies on React, Socket.IO, or any I/O — `engine.ts` must be
      importable in a plain Node script with no other setup

---

## Phase 2 — Socket.IO Real-Time Layer

### Scope
Wrap the Phase 1 engine in a room-based multiplayer server. This is the highest-risk
phase for security/cheating bugs — go slowly and validate every inbound event.

### Room & session model
- Room = in-memory object: `{ roomCode, gameState, hostId, spectators[], createdAt }`
- Room code: short human-shareable code (e.g. 4–6 alphanumeric chars), collision-checked
- One `GameState` per room; rooms are independent — no cross-room leakage of any kind
- Player identity: a server-generated session token (not just a socket ID, since
  sockets reconnect) stored client-side (e.g. in a cookie or localStorage) so a
  refresh doesn't kick the player from the game

### Required socket events (design the exact payload shapes yourself, but cover)
- `room:create`, `room:join`, `room:leave`, `room:list-players`
- `game:start` (host-only, requires 3–8 players present)
- `game:play-card`
- `game:challenge-strike` (only if E7 mode (b) is chosen)
- Server → client broadcasts: `game:state-update` (per-player redacted view via
  `toPlayerView`), `game:round-resolved`, `game:over`, `player:disconnected`,
  `player:reconnected`

### Edge cases Phase 2 MUST handle

| ID | Case | Required behavior |
|----|------|--------------------|
| S1 | Player disconnects mid-turn | Mark `connected: false` on their `PlayerState`; `advanceTurn` already skips disconnected players (Phase 1 handles this) — but start a grace-period timer (e.g. 60–120s) before auto-folding or auto-playing their lowest legal card, rather than freezing the game forever. Make the timeout configurable. |
| S2 | Player reconnects with their session token | Rehydrate them into the same seat with their existing hand intact; do not re-deal or reset state. |
| S3 | Host disconnects before game starts | Promote the next-joined player to host, or close the room after a timeout if empty. Never leave a room host-less indefinitely. |
| S4 | Duplicate player names in the same room | Allowed, but disambiguate in the UI by seat position or a suffix — do not use name as an identity key anywhere in game logic (use session token / player id only). |
| S5 | A client sends a `play-card` event for a card it doesn't currently hold, or out of turn | Reject server-side via `validatePlay`; emit an error event back to *that client only* — never broadcast the rejected attempt to others (it could leak information about hand contents by process of elimination if handled carelessly). |
| S6 | A client sends events faster than physically possible (scripted/automated play) | Rate-limit per socket (e.g. debounce or a minimum ms between accepted actions) to blunt basic automation/cheating attempts. |
| S7 | Room fills to 8 players and a 9th tries to join | Reject with a clear error; optionally offer spectator mode. |
| S8 | Fewer than 3 players when host tries to start | Reject `game:start` with a specific error message; do not allow a 2-player or solo "game" since the rules require 3–8. |
| S9 | Malformed or missing fields in an inbound event payload | Validate every event payload (e.g. with `zod`) before touching game state — never trust client JSON shape. |
| S10 | Two players click "play card" at effectively the same moment (race condition) | Socket.IO event handling for a single room's game state must be effectively serialized (e.g. process one event fully — including the state mutation — before starting the next for that room) so simultaneous submissions can't corrupt turn order. |
| S11 | A spectator or a player who already emptied their hand tries to play a card | Reject — only the current active, still-in-hand player may play. |
| S12 | Server restarts / process crash mid-game | Out of scope for Phase 2 unless you add persistence in Phase 4; document this as a known limitation in `docs/DECISIONS.md` rather than silently losing games. |

### Phase 2 exit criteria
- [ ] All game-state mutations happen only in response to server-validated events —
      grep the codebase to confirm no client-side file mutates `GameState` fields directly
- [ ] Manual test: open the app in 4 separate browser tabs/profiles, play a full game
      to completion, confirm a `loserId` is correctly reached
- [ ] Manual test: disconnect one tab mid-game (close it), confirm the remaining
      players can still finish the game once the grace period elapses
- [ ] Manual test: reconnect with the same session token, confirm hand is preserved
- [ ] No event handler trusts a client-supplied player id without checking it
      matches the session attached to that socket

---

## Phase 3 — Minimal Local UI

### Scope
Just enough UI to actually play a full game and validate Phases 1–2 end-to-end.
Not the polish pass — no theming, no sound, no animation library yet.

### Required screens
1. **Lobby**: create room / join by code, name entry, player list, host "Start" button
2. **Game table**: your hand (sorted, tap/click to play), other players shown as
   card-back counts only, active suit indicator, discard/collected pile count,
   current turn indicator, event log (reuses `state.log` from the engine)
3. **Game over**: show the Kazhuta, offer "play again" (new game, same room)

### Edge cases Phase 3 MUST handle

| ID | Case | Required behavior |
|----|------|--------------------|
| U1 | It's not your turn | Your cards are visibly non-interactive (no click handler / disabled state) — don't rely on the server rejection alone for UX. |
| U2 | You hold the active suit | Only cards of that suit are clickable/playable in the UI; attempting to click an off-suit card should be prevented client-side *in addition to* the server check (defense in depth for UX, not security). |
| U3 | Mobile viewport | Hand must remain usable on a narrow screen — horizontal scroll or fan layout, not cards overflowing off-screen uninteractively. |
| U4 | Long room codes / player names | Truncate gracefully in fixed-width UI elements (player list, turn indicator). |
| U5 | Network hiccup / temporary disconnect | Show a visible "reconnecting..." state rather than a frozen or blank screen. |
| U6 | Empty hand | Player's hand area shows "You're safe — waiting for others" instead of an empty box. |

### Phase 3 exit criteria
- [ ] A full 3-player game is playable start-to-finish using only the UI (no
      manual socket calls from devtools)
- [ ] Illegal moves are impossible to attempt through the UI under normal play
      (not just rejected after the fact)
- [ ] Works on both a desktop browser and a mobile browser viewport

---

## Phase 4 — Polish

### Scope
Everything that makes it feel like a finished product rather than a working
prototype. Do not start this phase until Phase 3's exit criteria are all checked.

### Suggested scope (prioritize with the user before building — don't assume all of this is wanted)
- Card flip / deal / collect animations
- Malayalam-language UI strings alongside English (toggle), matching the user's
  existing Malayalam/Manglish work in other projects
- Sound effects (card play, strike, game over) — must be mutable/toggleable
- Turn timer visible countdown (if not already added in Phase 2)
- Match history / stats if Postgres+Prisma persistence is added
- Shareable room links (deep link that pre-fills the room code on the join screen)
- Basic accessibility pass: keyboard navigation for hand selection, ARIA labels
  for screen readers on card elements

### Edge cases Phase 4 MUST handle

| ID | Case | Required behavior |
|----|------|--------------------|
| P1 | Sound/animation on a low-end device or with reduced-motion OS setting | Respect `prefers-reduced-motion`; keep animations optional/skippable. |
| P2 | Language toggle mid-game | Should not require a page reload or lose game state. |
| P3 | Match history persistence if added | Must not store other players' hand contents from completed games in a way that's queryable by future players (privacy — a finished game's hand data is fine to log for the players who were in it, not to expose generally). |

### Phase 4 exit criteria
- [ ] Whatever subset of the above was agreed with the user is implemented and
      does not regress Phase 2's server-authoritative guarantees
- [ ] Full playthrough on both desktop and mobile with sound/animations enabled
      feels complete — no dev-only UI artifacts (console logs as the only feedback,
      placeholder text, etc.) visible to end users

---

## General working rules for the agent

1. **Never weaken server authority to make a UI bug disappear.** If the UI and
   server disagree about a legal move, the bug is in the UI's mirrored validation
   logic, not a reason to loosen server checks.
2. **Write a test before fixing a bug** found in any edge case above, so it can't
   regress silently.
3. **Ask the user, don't assume,** for: the E7 false-strike mode, whether Phase 4's
   persistence is wanted at all, and any deviation from the fixed tech stack.
4. **Keep `docs/DECISIONS.md` updated** with any non-obvious architectural choice
   (server topology, validation library, testing framework, false-strike mode
   chosen) so a future session — human or agent — doesn't have to reverse-engineer
   the reasoning.
5. **Commit at phase boundaries**, not just at the end, so the user can review
   incrementally rather than reviewing one giant diff.
# Kazhutakali (കഴുതകളി) — Online Multiplayer Card Game

A web-based, real-time multiplayer implementation of **Kazhutakali**, the Kerala
trick-avoidance card game where the goal is *not to win* — it's to avoid being the
last player holding cards. Whoever is left holding cards is the **Kazhuta**
(കഴുത, "donkey").

3–8 players, a standard 52-card deck, suit-following, strikes, and a healthy
amount of bluffing. Full rules: [`docs/RULES.md`](docs/RULES.md).

---

## Features

- **Real-time multiplayer** — rooms of 3–8 players over Socket.IO, shareable by
  5-character room codes (dictation-safe alphabet: no `0/O`, `1/I/L`)
- **Server-authoritative engine** — every move is validated server-side; clients
  never see another player's hand, and the UI's own rule checks are UX-only
- **Challenge mode for false strikes** — striking while secretly holding the
  active suit is legal-but-dishonest; other players can call **"Challenge!"**
  and catch the liar, who immediately loses (the engine tracks this silently)
- **Disconnect-safe sessions** — a secret session token per seat survives page
  refreshes and transport reconnects with the hand intact; disconnected seats
  get a grace period before the server auto-plays for them
- **Spectators** — a full room gracefully falls back to spectator mode
- **Rate limiting & payload validation** — per-socket and per-seat limits, with
  every inbound event schema-validated (`zod`)

## Tech Stack

| Layer      | Choice                                    |
| ---------- | ----------------------------------------- |
| Frontend   | React 19 (Vite), TypeScript, plain SPA    |
| Real-time  | Socket.IO v4 (server + client)            |
| Server     | Node.js ≥ 20, Express + Socket.IO         |
| Validation | zod (server-side only)                    |
| Testing    | `node:test` via `tsx` (zero test deps)    |
| Persistence| None — game state lives in memory         |

The client is a static SPA. In development, Vite serves it on :5173 and proxies
`/socket.io` to the game server on :3000. In production, `npm run build` emits
`dist/` and the game server serves it — one origin end to end.

## Getting Started

```bash
npm install
npm run dev
```

- Open **http://localhost:5173** (the client)
- The game server listens on **http://localhost:3000**
- Create a room, share the 5-character code, and join from other tabs/devices

For a quick sanity check without browsers, the engine self-simulation runs bot
games for 3, 4, 6, and 8 players:

```bash
npm run demo
```

### Production build

```bash
npm run build   # emits dist/
npm start       # serves the SPA + game server from one origin
```

`PORT` overrides the listen port (default `3000`). For split deployments, set
`VITE_SERVER_URL` at client build time to the game server's absolute URL
(default: same origin).

### Playing against bots

A human can drive one seat through the browser UI while bots fill the rest:

```bash
npx tsx scripts/ui-bots.ts <ROOM_CODE> <BOT_COUNT>
```

## Project Structure

```
├── engine.ts             # Phase 1 — pure game logic, zero I/O, zero deps
├── demo.ts               # Bot simulation exit criterion (npm run demo)
├── server/
│   ├── main.ts           # Production entrypoint (npm start)
│   ├── index.ts          # Express + Socket.IO wiring, static serving
│   ├── roomStore.ts      # Room/session model, all game-state mutations
│   └── types.ts          # zod schemas for inbound events
├── shared/
│   └── protocol.ts       # Wire protocol: event names + payload types
├── client/
│   ├── App.tsx           # Screen routing (home / lobby / table / game over)
│   ├── socket.ts         # The only place the client talks to the server
│   ├── rules.ts          # Mirrored play rules for UX (never authoritative)
│   ├── session.ts        # localStorage session-token persistence
│   └── components/       # Home, Lobby, Table, GameOver, etc.
├── scripts/
│   └── ui-bots.ts        # Bot clients to fill seats during manual testing
├── tests/                # node:test suites (engine, room store, sockets, UI rules)
├── docs/
│   ├── RULES.md          # Canonical game rules
│   └── DECISIONS.md      # Architectural decision log (the "why")
└── AGENTS.md             # Operating brief for AI coding agents
```

## How to Play (Short Version)

1. Cards are dealt anticlockwise, one at a time; uneven hands are fine. The
   holder of the **Ace of Spades** leads round 1.
2. The first card of a round declares the **active suit**. Everyone must follow
   suit if they can.
3. **All followed** → the pile is discarded, everyone sheds a card, and the
   highest card of the suit leads the next round.
4. **A strike** (someone can't follow suit) → remaining players forfeit the
   round, and the highest active-suit card *collects the whole pile* back into
   their hand.
5. **False strike** — you held the suit but struck anyway. It's not illegal;
   it's a bluff. Get challenged successfully and you instantly lose.
6. The last player holding cards is the **Kazhuta**. There is no winner.

Strategy notes (when to discard high cards, when to strike, how to bluff):
[`docs/RULES.md`](docs/RULES.md).

## Scripts

| Command         | What it does                                        |
| --------------- | --------------------------------------------------- |
| `npm run dev`   | Server (:3000) + Vite client (:5173) concurrently   |
| `npm start`     | Production: serves `dist/` + game server on :3000   |
| `npm run build` | Vite production build → `dist/`                     |
| `npm test`      | All `node:test` suites (`tests/*.test.ts`)          |
| `npm run demo`  | Bot-simulation sanity run for 3/4/6/8 players       |
| `npm run typecheck` | `tsc --noEmit` for server and client            |

## Testing

```bash
npm test
```

Covers the engine's edge cases (uneven deals, mid-game hand-emptying, strike
collection, false-strike snapshots, challenge resolution, game-over conditions),
the room store (join/leave/reconnect, seat exclusivity, rate limits, grace
timers), socket behavior, and the client's mirrored rule logic. Deterministic
where it matters: the engine takes an injectable RNG and the store takes an
injectable clock, so disconnect grace timers are tested with a virtual clock —
no sleeps.

## Architecture Notes

- **The server is the single source of truth.** No game rule is enforced
  client-side only; `client/rules.ts` exists purely so illegal moves are hard
  to *attempt*, never to replace validation.
- **Views, not state.** Clients receive redacted per-player projections
  (`toPlayerView` / `toPublicView`). Hands other than your own and the engine's
  false-strike records never leave the server.
- **One engine, no I/O.** `engine.ts` imports nothing — it runs in a plain Node
  script, which is what makes the bot demo and unit tests trivial.
- Mutations per room are serialized through a promise chain, so two players
  clicking at the same instant can't corrupt turn order.
- Known limitation: a server restart loses in-memory games. Documented in
  [`docs/DECISIONS.md`](docs/DECISIONS.md) rather than hidden.

## Status

Phase 3 (minimal playable UI) — Phases 1–3 complete: engine, real-time
room/session layer, and lobby/table/game-over screens. Phase 4 (polish:
animations, sound, Malayalam UI, persistence) is planned but not started. See
[`AGENTS.md`](AGENTS.md) for the phase plan and exit criteria.

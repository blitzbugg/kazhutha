/**
 * Shared Phase 2 test utilities (not a test file — matched by tests/*.test.ts
 * only). See DECISIONS.md D29 for the clock-abstraction rationale.
 */
import { createDeck, type Card, type GameState } from '../engine.js';
import type { StoreClock } from '../server/roomStore.js';

/** Deterministic clock whose timers fire only when the test advances it. */
export function fakeClock(): {
  clock: StoreClock;
  advance(ms: number): void;
  now(): number;
} {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const clock: StoreClock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
  };
  return {
    clock,
    now: () => now,
    /** Fire every timer scheduled within the next `ms`, in schedule order. */
    advance(ms: number): void {
      const deadline = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= deadline)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, t] = due[0]!;
        timers.delete(id);
        now = Math.max(now, t.at);
        t.fn();
      }
      now = deadline;
    },
  };
}

const ALL_CARDS = new Map<string, Card>(createDeck().map((c) => [c.id, c] as const));

/**
 * Overwrite hands with a deterministic card set. Leftover deck cards are
 * distributed round-robin so the 52-card conservation invariant still holds —
 * every crafted hand only pins the cards the scenario actually plays.
 */
export function setHands(state: GameState, hands: Record<string, string[]>): void {
  const crafted: Record<string, string[]> = {};
  for (const [pid, ids] of Object.entries(hands)) {
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate card ids for ${pid}`);
    crafted[pid] = [...ids];
  }
  const used = new Set<string>(Object.values(crafted).flat());
  const leftovers = createDeck().map((c) => c.id).filter((id) => !used.has(id));
  const pids = Object.keys(crafted);
  let i = 0;
  for (const id of leftovers) {
    const pid = pids[i % pids.length]!;
    crafted[pid]!.push(id);
    i++;
  }
  for (const [pid, ids] of Object.entries(crafted)) {
    state.hands[pid] = ids.map((id) => ALL_CARDS.get(id)!);
  }
}

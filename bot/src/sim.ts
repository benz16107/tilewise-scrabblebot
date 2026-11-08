// Offline 6-bot match simulator with the module's rules (game.ts):
// 98-tile bag, 5-tile starting racks, 1 letter per sealed-bid Vickrey
// auction (reserve 1, ties random), no-bid letters are discarded, the
// match ends the moment the last auction closes. Words take `LAG`
// auctions to land, so a word sent with fewer auctions left is lost.
//
//   npx tsx src/sim.ts [matches]

import * as fs from "node:fs";
import * as path from "node:path";
import {
  BAG, LETTER_VALUE, PARAMS, type Params, bestWord, chooseWord, decideBid,
  indexFor, toCounts,
} from "./strategy.js";

const LAG = Number(process.env.SIM_LAG ?? 2);

const dictPath = path.join(
  path.dirname(new URL(import.meta.url).pathname), "..", "..", "spacetimedb", "wordlist.txt",
);
const DICT = fs.readFileSync(dictPath, "utf8").split("\n").map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);
const idx = indexFor(DICT);
const BY_LEN = [...DICT].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
// START[n] = first index in BY_LEN of a word with length <= n.
const START: number[] = [];
for (let n = 0; n <= 40; n++) {
  const i = BY_LEN.findIndex((w) => w.length <= n);
  START.push(i < 0 ? BY_LEN.length : i);
}

let seed = Number(process.env.SIM_SEED ?? 1);
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

interface Player {
  name: string;
  rack: Map<string, number>;
  balance: number;
  score: number;
  bid(letter: string, bag: number): number;
  // Words to play after a rack change; returns them in order.
  play(bag: number, wonThis: boolean): string[];
}

function canSpell(w: string, rack: Map<string, number>) {
  const used: Record<string, number> = {};
  for (const c of w) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c]! > (rack.get(c) ?? 0)) return false;
  }
  return true;
}
function tiles(r: Map<string, number>) {
  let n = 0;
  for (const v of r.values()) n += v;
  return n;
}
function longest(rack: Map<string, number>, minLen: number): string | null {
  const n = Math.min(tiles(rack), 40);
  for (let i = START[n]!; i < BY_LEN.length; i++) {
    const w = BY_LEN[i]!;
    if (w.length < minLen) return null;
    if (canSpell(w, rack)) return w;
  }
  return null;
}
function take(rack: Map<string, number>, w: string) {
  for (const c of w) {
    const n = rack.get(c)! - 1;
    if (n) rack.set(c, n);
    else rack.delete(c);
  }
}
function wordReward(w: string) {
  let b = 0;
  for (const c of w) b += LETTER_VALUE[c]!;
  const n = w.length;
  return n <= 3 ? b : n === 4 ? Math.floor((b * 3) / 2) : n === 5 ? b * 2 : n === 6 ? Math.floor((b * 5) / 2) : b * 3;
}

// The stock starter: face (+2 if new letter), longest word on every change.
function starter(name: string): Player {
  const p: Player = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter) {
      const v = LETTER_VALUE[letter]!;
      const want = (p.rack.get(letter) ?? 0) === 0 ? v + 2 : Math.max(1, v);
      return Math.min(want, p.balance);
    },
    play() {
      const out: string[] = [];
      const r = new Map(p.rack);
      for (let w = longest(r, 2); w; w = longest(r, 2)) {
        out.push(w);
        take(r, w);
      }
      return out;
    },
  };
  return p;
}

// The module's simulated bots: face-based bid with jitter, longest 3+
// word right after winning.
function simBot(name: string, kind: "Cheapskate" | "ValueBidder" | "Aggressive"): Player {
  const p: Player = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter) {
      const v = LETTER_VALUE[letter]!;
      const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + ("AEIOU".includes(letter) ? 4 : 2);
      return Math.max(Math.min(Math.max(base + randInt(-2, 2), 1), p.balance), 0);
    },
    play(_bag, won) {
      if (!won) return [];
      const w = longest(p.rack, 3);
      return w ? [w] : [];
    },
  };
  return p;
}

// Mean price paid per letter on the live server, 2026-11-07 (60k auctions).
const LIVE_PRICE: Record<string, number> = {
  A: 10.8, B: 16.1, C: 17, D: 13.6, E: 11, F: 18.9, G: 12.6, H: 20.2, I: 10.2,
  J: 27.9, K: 23.1, L: 10.8, M: 16.8, N: 10.6, O: 10.1, P: 16.2, Q: 26, R: 11,
  S: 11.9, T: 10.2, U: 10.1, V: 16.7, W: 18, X: 30.4, Y: 20.4, Z: 36.2,
};
// A stand-in for the live field: bids near the live price, plays 5+ words.
function market(name: string): Player {
  const p: Player = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter) {
      return Math.min(p.balance, Math.round(LIVE_PRICE[letter]! * (0.7 + 0.6 * rand())));
    },
    play(bag) {
      const out: string[] = [];
      const r = new Map(p.rack);
      for (;;) {
        const f = bestWord(idx, toCounts(r), bag <= 4 ? 2 : 5);
        if (!f) return out;
        out.push(f.word);
        take(r, f.word);
      }
    },
  };
  return p;
}

function ours(name: string, params: Params): Player {
  const p: Player = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter, bag) {
      return decideBid({ letter, myBalance: p.balance, myRack: p.rack, bagTotal: bag, dictionary: DICT, params });
    },
    play(bag) {
      const out: string[] = [];
      const r = new Map(p.rack);
      for (;;) {
        const w = chooseWord({ myRack: r, dictionary: DICT, bagTotal: bag, myBalance: p.balance, params });
        if (!w) return out;
        out.push(w);
        take(r, w);
      }
    },
  };
  return p;
}

export function playMatch(players: Player[]) {
  const bag: string[] = [];
  for (const [l, n] of Object.entries(BAG)) for (let i = 0; i < n; i++) bag.push(l);
  const draw = () => bag.splice(randInt(0, bag.length - 1), 1)[0];
  for (const p of players) {
    for (let i = 0; i < 5; i++) {
      const l = draw()!;
      p.rack.set(l, (p.rack.get(l) ?? 0) + 1);
    }
  }
  const doPlays = (p: Player, won: boolean) => {
    const remaining = bag.length; // auctions still to close after this one
    if (remaining < LAG) return; // lands after the match ends
    for (const w of p.play(remaining, won)) {
      if (!canSpell(w, p.rack) || !DICTSET.has(w)) continue;
      take(p.rack, w);
      const r = wordReward(w);
      p.balance += r;
      p.score += r;
    }
  };
  for (const p of players) doPlays(p, false);
  while (bag.length > 0) {
    const letter = draw()!;
    const bagLeft = bag.length;
    const bids = players
      .map((p, i) => ({ i, a: Math.min(Math.floor(p.bid(letter, bagLeft)), p.balance) }))
      .filter((b) => b.a > 0);
    for (let i = bids.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [bids[i], bids[j]] = [bids[j]!, bids[i]!];
    }
    bids.sort((a, b) => b.a - a.a);
    let winner = -1;
    if (bids.length) {
      winner = bids[0]!.i;
      const paid = bids[1] ? bids[1].a : Math.min(1, bids[0]!.a);
      const w = players[winner]!;
      w.balance -= paid;
      w.rack.set(letter, (w.rack.get(letter) ?? 0) + 1);
    }
    if (bag.length === 0) break; // match ended as this auction closed
    players.forEach((p, i) => doPlays(p, i === winner));
  }
  return players.map((p) => p.score);
}
const DICTSET = new Set(DICT);

type Make = (name: string) => Player;
function league(label: string, lineup: Make[], n: number, focus = 0) {
  const totals = lineup.map(() => 0);
  const wins = lineup.map(() => 0);
  for (let m = 0; m < n; m++) {
    const ps = lineup.map((mk, i) => mk(`p${i}`));
    const s = playMatch(ps);
    const top = Math.max(...s);
    s.forEach((v, i) => {
      totals[i]! += v;
      if (v === top) wins[i]!++;
    });
  }
  const row = (i: number) => `${(totals[i]! / n).toFixed(1)} pts, ${((100 * wins[i]!) / n).toFixed(0)}% wins`;
  console.log(`${label}: focus ${row(focus)} | others ${lineup.map((_, i) => (i === focus ? "" : row(i))).filter(Boolean).join("; ")}`);
  return { mean: totals[focus]! / n, win: wins[focus]! / n };
}

const mk = (p: Partial<Params>): Make => (name) => ours(name, { ...PARAMS, ...p });
const sims: Make[] = [
  (n) => simBot(n, "Cheapskate"), (n) => simBot(n, "ValueBidder"), (n) => simBot(n, "Aggressive"),
  (n) => simBot(n, "ValueBidder"), (n) => simBot(n, "Aggressive"),
];
const markets: Make[] = [0, 1, 2, 3, 4].map(() => (n: string) => market(n));
const starters: Make[] = [0, 1, 2, 3, 4].map(() => (n: string) => starter(n));

if (import.meta.url === `file://${process.argv[1]}`) {
  const N = Number(process.argv[2] ?? 300);
  const mode = process.argv[3] ?? "report";
  if (mode === "market") {
    league("starter vs 5 market", [starters[0]!, ...markets], N);
    league("ours vs 5 market", [mk({}), ...markets], N);
    league("ours x2 vs 4 market", [mk({}), mk({}), ...markets.slice(0, 4)], N);
  } else if (mode === "mtune") {
    const grid: [keyof Params, number[]][] = JSON.parse(process.argv[4]!);
    const fixed: Partial<Params> = JSON.parse(process.argv[5] ?? "{}");
    for (const [k, vals] of grid) {
      for (const v of vals) league(`${k}=${v}`, [mk({ ...fixed, [k]: v }), ...markets], N);
    }
  } else if (mode === "report") {
    league("starter vs 5 sims", [starters[0]!, ...sims], N);
    league("ours vs 5 sims", [mk({}), ...sims], N);
    league("starter vs 5 starters", [starters[0]!, ...starters], N);
    league("ours vs 5 starters", [mk({}), ...starters], N);
    league("ours vs 2 ours + 3 starters", [mk({}), mk({}), mk({}), ...starters.slice(0, 3)], N);
    league("ours vs 5 ours", [mk({}), mk({}), mk({}), mk({}), mk({}), mk({})], N);
  } else if (mode === "tune") {
    // One knob at a time against a mixed field: 2 default ours, 3 starters.
    const grid: [keyof Params, number[]][] = JSON.parse(process.argv[4]!);
    for (const [k, vals] of grid) {
      for (const v of vals) {
        const r = league(`${k}=${v}`, [mk({ [k]: v }), mk({}), mk({}), ...starters.slice(0, 2), sims[2]!], N);
        void r;
      }
    }
  }
}

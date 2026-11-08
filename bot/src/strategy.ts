// Bidding and word choice. Pure functions, shared by the live client
// (index.ts) and the offline simulator (sim.ts).

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

// The module's bag (letters.ts): standard Scrabble, no blanks, 98 tiles.
export const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

// Median clearing price per letter on the live server, last 464 matches
// before the HackUTD tournament (2026-11-07).
export const MARKET_PRICE: Record<string, number> = {
  A: 11, B: 17, C: 18, D: 14, E: 11, F: 20, G: 13, H: 21, I: 10, J: 31, K: 24,
  L: 11, M: 17, N: 11, O: 10, P: 17, Q: 26, R: 11, S: 12, T: 10, U: 11, V: 18,
  W: 19, X: 33, Y: 22, Z: 39,
};

// Tunable knobs. Defaults are the simulator's best (see RUN.md).
export const PARAMS = {
  playLen: 7, // before the endgame, only play words at least this long (3x)
  cashAt: 4, // bag_total at or below this: play every word we can, best first
  midBag: 20, // bag_total at or below this: play words of `midLen`+
  midLen: 7,
  lateBag: 10, // bag_total at or below this: play words of `lateLen`+
  lateLen: 6,
  lowBalance: 8, // below this balance, also play words of `lowLen`+ to refill
  lowLen: 5,
  gainW: 0.4, // weight on the immediate rise in best-word score
  faceMult: 0.5, // weight on face value as future long-word value
  base: 1, // flat value for any useful letter
  mkt: 0.7, // weight on the live market price as future value
  richRef: 2.5, // balance per remaining auction at which bids start scaling up
  lastUseful: 2, // bag_total below this: a won letter can't be played in time
  endSpend: 1, // endgame bid on a letter with no immediate use, x balance/(bag+1)
};
export type Params = typeof PARAMS;

export function wordScore(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const n = word.length;
  // Integer division, as the module does it.
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// Sorted-letter key -> one word with those letters (anagrams score the
// same), plus every prefix of every key so the rack search can prune.
export interface WordIndex {
  byKey: Map<string, string>;
  prefixes: Set<string>;
}

// shortcut: racks longer than this never find longer words; raise it if
// racks routinely pass 16 tiles.
const MAX_INDEX_LEN = 16;

export function buildIndex(words: Iterable<string>): WordIndex {
  const byKey = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const w of words) {
    if (w.length < 2 || w.length > MAX_INDEX_LEN) continue;
    if (!/^[A-Z]+$/.test(w)) continue;
    const key = [...w].sort().join("");
    if (byKey.has(key)) continue;
    byKey.set(key, w);
    for (let i = 1; i <= key.length; i++) prefixes.add(key.slice(0, i));
  }
  return { byKey, prefixes };
}

let cachedFor: unknown = null;
let cachedIndex: WordIndex | null = null;
export function indexFor(dictionary: string[]): WordIndex {
  if (cachedFor !== dictionary || !cachedIndex) {
    cachedIndex = buildIndex(dictionary);
    cachedFor = dictionary;
  }
  return cachedIndex;
}

export function toCounts(rack: Map<string, number>): number[] {
  const c = new Array<number>(26).fill(0);
  for (const [l, n] of rack) {
    const i = l.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i] += n;
  }
  return c;
}

export interface Found {
  word: string;
  score: number;
}

// Highest-scoring word of at least `minLen` letters spellable from `counts`.
export function bestWord(
  idx: WordIndex,
  counts: number[],
  minLen = 2,
): Found | null {
  let best: Found | null = null;
  const rec = (from: number, prefix: string) => {
    if (prefix.length >= minLen) {
      const w = idx.byKey.get(prefix);
      if (w) {
        const s = wordScore(w);
        if (!best || s > best.score) best = { word: w, score: s };
      }
    }
    for (let j = from; j < 26; j++) {
      const c = counts[j]!;
      if (!c) continue;
      const ch = String.fromCharCode(65 + j);
      let p = prefix;
      for (let k = 1; k <= c; k++) {
        p += ch;
        if (!idx.prefixes.has(p)) break;
        rec(j + 1, p);
      }
    }
  };
  rec(0, "");
  return best;
}

// Greedy split of the rack into words, best first. Used for the endgame.
export function greedyPlan(idx: WordIndex, counts: number[]): Found[] {
  const c = counts.slice();
  const out: Found[] = [];
  for (;;) {
    const f = bestWord(idx, c);
    if (!f) return out;
    out.push(f);
    for (const ch of f.word) c[ch.charCodeAt(0) - 65]!--;
  }
}

function planTotal(idx: WordIndex, counts: number[]): number {
  return greedyPlan(idx, counts).reduce((s, f) => s + f.score, 0);
}

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  bagTotal?: number; // match_state.bag_total: tiles still in the bag
  dictionary?: string[];
  params?: Params;
}

/** How much to bid for `letter`. 0 = skip. Never above balance. */
export function decideBid(ctx: BidContext): number {
  const P = ctx.params ?? PARAMS;
  const bal = Math.max(0, Math.floor(ctx.myBalance));
  if (bal <= 0) return 0;
  const bag = ctx.bagTotal ?? 40;
  if (bag < P.lastUseful) return 0; // the match ends before we could use it
  const face = LETTER_VALUE[ctx.letter] ?? 1;
  const li = ctx.letter.charCodeAt(0) - 65;
  const counts = toCounts(ctx.myRack);
  const idx = ctx.dictionary ? indexFor(ctx.dictionary) : null;
  const withL = counts.slice();
  withL[li]!++;

  if (bag <= P.cashAt) {
    // Endgame: money is worthless after the match, so pay anything for a
    // letter that raises what we can cash in now.
    if (!idx) return 0;
    const gain = planTotal(idx, withL) - planTotal(idx, counts);
    if (gain > 0) return bal;
    // Money is worthless after the match; a letter may still pair with a
    // later one, and winning it keeps it from an opponent.
    return Math.min(bal, Math.round((bal * P.endSpend) / (bag + 1)));
  }

  let gain = 0;
  if (idx) {
    const before = bestWord(idx, counts)?.score ?? 0;
    const after = bestWord(idx, withL)?.score ?? 0;
    gain = Math.max(0, after - before);
  }

  let future = face * P.faceMult + P.mkt * (MARKET_PRICE[ctx.letter] ?? 11);
  const vowels = counts[0]! + counts[4]! + counts[8]! + counts[14]! + counts[20]!;
  const tiles = counts.reduce((a, b) => a + b, 0);
  const isVowel = "AEIOU".includes(ctx.letter);
  if (ctx.letter === "Q" && counts[20] === 0) future *= 0.15; // Q without U
  const have = counts[li]!;
  if (have >= (isVowel ? 2 : 1)) future *= have >= 3 ? 0.1 : 0.4;
  // Keep roughly 40% vowels so the rack can still form long words.
  const vowelShare = tiles ? vowels / tiles : 0.4;
  if (isVowel && vowelShare < 0.3) future += 3;
  if (!isVowel && vowelShare > 0.55) future += 2;
  if (isVowel && vowelShare > 0.55) future *= 0.3;

  let value = P.gainW * gain + future + P.base;
  // Spend the balance down: scale bids up when money per remaining auction
  // is high, since leftover balance scores nothing.
  const rich = bal / Math.max(1, bag - P.cashAt);
  if (rich > P.richRef) value *= rich / P.richRef;
  return Math.max(0, Math.min(bal, Math.round(value)));
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  bagTotal?: number;
  myBalance?: number;
  params?: Params;
}

/** The word to play now, or null to hold the letters. */
export function chooseWord(ctx: WordContext): string | null {
  const P = ctx.params ?? PARAMS;
  const idx = indexFor(ctx.dictionary);
  const counts = toCounts(ctx.myRack);
  const bag = ctx.bagTotal ?? 0; // unknown: treat as endgame, play
  if (bag <= P.cashAt) return bestWord(idx, counts)?.word ?? null;
  const minLen = bag <= P.lateBag ? P.lateLen : bag <= P.midBag ? P.midLen : P.playLen;
  const long = bestWord(idx, counts, minLen);
  if (long) return long.word;
  if ((ctx.myBalance ?? 100) < P.lowBalance) {
    return bestWord(idx, counts, P.lowLen)?.word ?? null;
  }
  return null;
}

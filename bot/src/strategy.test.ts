import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestWord, buildIndex, chooseWord, decideBid, greedyPlan, toCounts, wordScore,
} from "./strategy.js";

const DICT = ["CAT", "ACT", "TACO", "COAT", "CATS", "COATS", "ASCOT", "TACOS", "QI", "AT", "OCTANES"];
const rack = (s: string) => {
  const m = new Map<string, number>();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};

test("wordScore matches the module's multipliers and integer division", () => {
  assert.equal(wordScore("CAT"), 5); // 3+1+1, 1x
  assert.equal(wordScore("TACO"), 9); // 6 * 1.5
  assert.equal(wordScore("COATS"), 14); // 7 * 2
  assert.equal(wordScore("OCTANES"), 27); // 9 * 3
});

test("bestWord finds the highest-scoring word, anagram-aware", () => {
  const idx = buildIndex(DICT);
  assert.equal(bestWord(idx, toCounts(rack("TOCAS")))?.score, 14);
  assert.equal(bestWord(idx, toCounts(rack("ZZZ"))), null);
  assert.equal(bestWord(idx, toCounts(rack("TCAQI")))?.word, "QI"); // 11 beats CAT's 5
});

test("greedyPlan never reuses a tile", () => {
  const idx = buildIndex(DICT);
  const plan = greedyPlan(idx, toCounts(rack("CATQIAT")));
  const have = rack("CATQIAT");
  for (const c of plan.map((f) => f.word).join("")) {
    const n = have.get(c) ?? 0;
    assert.ok(n > 0, `reused ${c}`);
    have.set(c, n - 1);
  }
  assert.deepEqual(plan.map((f) => f.word).sort(), ["AT", "CAT", "QI"].sort());
});

test("chooseWord holds short words mid-game and cashes in at the end", () => {
  assert.equal(chooseWord({ myRack: rack("CATS"), dictionary: DICT, bagTotal: 40, myBalance: 50 }), null);
  assert.ok(chooseWord({ myRack: rack("CATS"), dictionary: DICT, bagTotal: 3, myBalance: 50 }));
  assert.equal(chooseWord({ myRack: rack("OCTANES"), dictionary: DICT, bagTotal: 40, myBalance: 50 }), "OCTANES");
});

test("decideBid stays within balance and skips the useless last letters", () => {
  for (const letter of ["A", "Q", "Z", "E"]) {
    const b = decideBid({ letter, myBalance: 7, myRack: rack("AEIRST"), bagTotal: 30, dictionary: DICT });
    assert.ok(b >= 0 && b <= 7, `${letter}: ${b}`);
  }
  assert.equal(decideBid({ letter: "E", myBalance: 50, myRack: rack("A"), bagTotal: 0, dictionary: DICT }), 0);
  assert.equal(decideBid({ letter: "E", myBalance: 0, myRack: rack("A"), bagTotal: 30, dictionary: DICT }), 0);
  // Endgame: a letter that completes a word is worth the whole balance.
  assert.equal(decideBid({ letter: "S", myBalance: 20, myRack: rack("COAT"), bagTotal: 4, dictionary: DICT }), 20);
});

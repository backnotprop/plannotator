import { describe, expect, test } from "vitest";
import { buildStacks } from "./buildStacks";
import type { PRListItem } from "../../daemon/contracts";

function pr({
  number,
  head,
  base,
  state = "open",
}: {
  number: number;
  head: string;
  base: string;
  state?: PRListItem["state"];
}): PRListItem {
  return {
    id: `pr-${number}`,
    number,
    title: `PR #${number}`,
    author: "tater",
    url: `https://example.com/pr/${number}`,
    baseBranch: base,
    headBranch: head,
    state,
  };
}

/** Every distinct ordering of a list, for permutation-invariance checks. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

// A 3-deep stack: A(base=main) ← B(base=A) ← C(base=B)
const A = pr({ number: 1, head: "a", base: "main" });
const B = pr({ number: 2, head: "b", base: "a" });
const C = pr({ number: 3, head: "c", base: "b" });

// A 4-deep stack: W ← X ← Y ← Z
const W = pr({ number: 10, head: "w", base: "main" });
const X = pr({ number: 11, head: "x", base: "w" });
const Y = pr({ number: 12, head: "y", base: "x" });
const Z = pr({ number: 13, head: "z", base: "y" });

// A second independent 2-deep stack: P(base=main) ← Q(base=P)
const P = pr({ number: 20, head: "p", base: "main" });
const Q = pr({ number: 21, head: "q", base: "p" });

interface Case {
  name: string;
  prs: PRListItem[];
  expected: { stackLabels: string[]; looseNumbers: number[] };
}

const cases: Case[] = [
  {
    name: "3-deep stack, leaf-first order",
    prs: [C, B, A],
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "3-deep stack, base-first order",
    prs: [A, B, C],
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "3-deep stack, interleaved order",
    prs: [B, A, C],
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "4-deep stack, base-first order",
    prs: [W, X, Y, Z],
    expected: { stackLabels: ["#10 → #13"], looseNumbers: [] },
  },
  {
    name: "4-deep stack, scrambled order",
    prs: [Y, W, Z, X],
    expected: { stackLabels: ["#10 → #13"], looseNumbers: [] },
  },
  {
    name: "two independent stacks in one input",
    prs: [A, B, C, P, Q],
    expected: { stackLabels: ["#1 → #3", "#20 → #21"], looseNumbers: [] },
  },
  {
    name: "two independent stacks, interleaved input",
    prs: [Q, B, A, P, C],
    expected: { stackLabels: ["#1 → #3", "#20 → #21"], looseNumbers: [] },
  },
  {
    name: "all loose — every PR based on default branch",
    prs: [
      pr({ number: 30, head: "f1", base: "main" }),
      pr({ number: 31, head: "f2", base: "main" }),
      pr({ number: 32, head: "f3", base: "main" }),
    ],
    expected: { stackLabels: [], looseNumbers: [30, 31, 32] },
  },
  {
    name: "single non-default-based PR with no parent in the set stays loose",
    prs: [pr({ number: 40, head: "feature", base: "missing-parent" })],
    expected: { stackLabels: [], looseNumbers: [40] },
  },
  {
    name: "stack plus an unrelated loose PR",
    prs: [A, B, C, pr({ number: 50, head: "solo", base: "main" })],
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [50] },
  },
  {
    name: "empty input",
    prs: [],
    expected: { stackLabels: [], looseNumbers: [] },
  },
];

describe("buildStacks", () => {
  for (const c of cases) {
    test(c.name, () => {
      // Output is now fully order-independent: stacks sorted by base PR number,
      // loose sorted by number. Assert the raw arrays — no sort() smoothing.
      const { stacks, loose } = buildStacks(c.prs);
      expect(stacks.map((s) => s.label)).toEqual(c.expected.stackLabels);
      expect(loose.map((pr) => pr.number)).toEqual(c.expected.looseNumbers);
    });
  }

  test("stacks are ordered base → leaf with #base → #leaf labels", () => {
    const { stacks } = buildStacks([C, A, B]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(stacks[0].label).toBe("#1 → #3");
  });

  test("the base PR (base = default branch) is included in the stack", () => {
    const { stacks, loose } = buildStacks([A, B, C]);
    expect(loose).toHaveLength(0);
    expect(stacks[0].prs.some((p) => p.number === 1)).toBe(true);
  });

  // The core invariant: grouping must not depend on the order the API returns
  // PRs. Every permutation of the same stack must yield identical grouping.
  test("every permutation of a 3-deep stack yields the same single stack", () => {
    for (const perm of permutations([A, B, C])) {
      const { stacks, loose } = buildStacks(perm);
      expect(stacks.map((s) => s.label)).toEqual(["#1 → #3"]);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([1, 2, 3]);
      expect(loose).toHaveLength(0);
    }
  });

  test("every permutation of a 4-deep stack yields the same single stack", () => {
    for (const perm of permutations([W, X, Y, Z])) {
      const { stacks, loose } = buildStacks(perm);
      expect(stacks.map((s) => s.label)).toEqual(["#10 → #13"]);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([10, 11, 12, 13]);
      expect(loose).toHaveLength(0);
    }
  });

  // Output ordering itself is now order-independent: independent stacks come
  // back sorted by base PR number, so they never swap positions between polls.
  test("every permutation of two independent stacks yields the same ordered grouping", () => {
    for (const perm of permutations([A, B, C, P, Q])) {
      const { stacks, loose } = buildStacks(perm);
      expect(stacks.map((s) => s.label)).toEqual(["#1 → #3", "#20 → #21"]);
      expect(loose).toHaveLength(0);
    }
  });

  // Cycles must not loop forever. A ↔ B (each based on the other's head) are
  // neither leaves, so they never root a chain and fall through to loose.
  test("a 2-cycle does not loop and lands in loose", () => {
    const c1 = pr({ number: 60, head: "cy1", base: "cy2" });
    const c2 = pr({ number: 61, head: "cy2", base: "cy1" });
    const { stacks, loose } = buildStacks([c1, c2]);
    expect(stacks).toHaveLength(0);
    expect(loose.map((p) => p.number)).toEqual([60, 61]);
  });

  // A leaf feeding into a cycle terminates via the `stacked` guard: the walk
  // visits leaf → cy1 → cy2 → cy1(already stacked, stop). The resulting chain
  // includes the cyclic members. This pins current bounded behaviour — the key
  // guarantee is termination, not a particular policy on cyclic members.
  test("a leaf feeding into a cycle terminates and forms a bounded stack", () => {
    const cy1 = pr({ number: 65, head: "cyc1", base: "cyc2" });
    const cy2 = pr({ number: 66, head: "cyc2", base: "cyc1" });
    const leaf = pr({ number: 67, head: "tip", base: "cyc1" });
    for (const perm of permutations([cy1, cy2, leaf])) {
      const { stacks, loose } = buildStacks(perm);
      // Terminates (no hang) and produces exactly one bounded stack containing
      // every member of the walk, in base → leaf order.
      expect(stacks).toHaveLength(1);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([66, 65, 67]);
      expect(stacks[0].label).toBe("#66 → #67");
      expect(loose).toHaveLength(0);
    }
  });

  // A fork (one branch is the base of two PRs) must group deterministically,
  // independent of input order. The shared ancestor joins the chain rooted at
  // the lowest-numbered leaf; the other leaf falls through to loose. We assert
  // this across ALL permutations rather than one hardcoded ordering.
  test("a fork groups deterministically across every input order", () => {
    const root = pr({ number: 70, head: "root", base: "main" });
    const child1 = pr({ number: 71, head: "child1", base: "root" });
    const child2 = pr({ number: 72, head: "child2", base: "root" });
    for (const perm of permutations([root, child1, child2])) {
      const { stacks, loose } = buildStacks(perm);
      // Exactly one stack: the lowest-numbered leaf (71) wins the root.
      expect(stacks).toHaveLength(1);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([70, 71]);
      expect(stacks[0].label).toBe("#70 → #71");
      // The shared ancestor is never double-counted.
      const allStackNumbers = stacks.flatMap((s) => s.prs.map((p) => p.number));
      expect(allStackNumbers.filter((n) => n === 70)).toHaveLength(1);
      // The losing sibling is loose.
      expect(loose.map((p) => p.number)).toEqual([72]);
    }
  });

  // Duplicate head branches (e.g. `state=all` returns a merged + an open PR on
  // the same branch) must resolve deterministically when a chain follows that
  // head: the open PR wins the `byHead` mapping so chain-following does not
  // depend on input order. Here a tip (#91) is based on branch `mid`, which is
  // the head of both a merged (#88) and an open (#89) PR.
  test("duplicate head branches resolve to the open PR across every order", () => {
    const tip = pr({ number: 91, head: "tip", base: "mid" });
    const midMerged = pr({ number: 88, head: "mid", base: "main", state: "merged" });
    const midOpen = pr({ number: 89, head: "mid", base: "main", state: "open" });
    for (const perm of permutations([tip, midMerged, midOpen])) {
      const { stacks, loose } = buildStacks(perm);
      // The open PR (#89) wins byHead, so the chain is #89 → #91 and the merged
      // duplicate (#88) — never followed — is loose.
      expect(stacks).toHaveLength(1);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([89, 91]);
      expect(stacks[0].label).toBe("#89 → #91");
      expect(loose.map((p) => p.number)).toEqual([88]);
    }
  });
});

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

const sorted = (xs: string[]) => [...xs].sort();
const sortedNums = (xs: number[]) => [...xs].sort((a, b) => a - b);

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
  defaultBranch: string;
  expected: { stackLabels: string[]; looseNumbers: number[] };
}

const cases: Case[] = [
  {
    name: "3-deep stack, leaf-first order",
    prs: [C, B, A],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "3-deep stack, base-first order",
    prs: [A, B, C],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "3-deep stack, interleaved order",
    prs: [B, A, C],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [] },
  },
  {
    name: "4-deep stack, base-first order",
    prs: [W, X, Y, Z],
    defaultBranch: "main",
    expected: { stackLabels: ["#10 → #13"], looseNumbers: [] },
  },
  {
    name: "4-deep stack, scrambled order",
    prs: [Y, W, Z, X],
    defaultBranch: "main",
    expected: { stackLabels: ["#10 → #13"], looseNumbers: [] },
  },
  {
    name: "two independent stacks in one input",
    prs: [A, B, C, P, Q],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3", "#20 → #21"], looseNumbers: [] },
  },
  {
    name: "two independent stacks, interleaved input",
    prs: [Q, B, A, P, C],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3", "#20 → #21"], looseNumbers: [] },
  },
  {
    name: "all loose — every PR based on default branch",
    prs: [
      pr({ number: 30, head: "f1", base: "main" }),
      pr({ number: 31, head: "f2", base: "main" }),
      pr({ number: 32, head: "f3", base: "main" }),
    ],
    defaultBranch: "main",
    expected: { stackLabels: [], looseNumbers: [30, 31, 32] },
  },
  {
    name: "single non-default-based PR with no parent in the set stays loose",
    prs: [pr({ number: 40, head: "feature", base: "missing-parent" })],
    defaultBranch: "main",
    expected: { stackLabels: [], looseNumbers: [40] },
  },
  {
    name: "stack plus an unrelated loose PR",
    prs: [A, B, C, pr({ number: 50, head: "solo", base: "main" })],
    defaultBranch: "main",
    expected: { stackLabels: ["#1 → #3"], looseNumbers: [50] },
  },
  {
    name: "empty input",
    prs: [],
    defaultBranch: "main",
    expected: { stackLabels: [], looseNumbers: [] },
  },
];

describe("buildStacks", () => {
  for (const c of cases) {
    test(c.name, () => {
      const { stacks, loose } = buildStacks(c.prs, c.defaultBranch);
      expect(sorted(stacks.map((s) => s.label))).toEqual(sorted(c.expected.stackLabels));
      expect(sortedNums(loose.map((pr) => pr.number))).toEqual(sortedNums(c.expected.looseNumbers));
    });
  }

  test("stacks are ordered base → leaf with #base → #leaf labels", () => {
    const { stacks } = buildStacks([C, A, B], "main");
    expect(stacks).toHaveLength(1);
    expect(stacks[0].prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(stacks[0].label).toBe("#1 → #3");
  });

  test("the base PR (base = default branch) is included in the stack", () => {
    const { stacks, loose } = buildStacks([A, B, C], "main");
    expect(loose).toHaveLength(0);
    expect(stacks[0].prs.some((p) => p.number === 1)).toBe(true);
  });

  // The core invariant: grouping must not depend on the order the API returns
  // PRs. Every permutation of the same stack must yield identical grouping.
  test("every permutation of a 3-deep stack yields the same single stack", () => {
    for (const perm of permutations([A, B, C])) {
      const { stacks, loose } = buildStacks(perm, "main");
      expect(stacks.map((s) => s.label)).toEqual(["#1 → #3"]);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([1, 2, 3]);
      expect(loose).toHaveLength(0);
    }
  });

  test("every permutation of a 4-deep stack yields the same single stack", () => {
    for (const perm of permutations([W, X, Y, Z])) {
      const { stacks, loose } = buildStacks(perm, "main");
      expect(stacks.map((s) => s.label)).toEqual(["#10 → #13"]);
      expect(stacks[0].prs.map((p) => p.number)).toEqual([10, 11, 12, 13]);
      expect(loose).toHaveLength(0);
    }
  });

  test("every permutation of two independent stacks yields the same grouping", () => {
    for (const perm of permutations([A, B, C, P, Q])) {
      const { stacks, loose } = buildStacks(perm, "main");
      expect(sorted(stacks.map((s) => s.label))).toEqual(sorted(["#1 → #3", "#20 → #21"]));
      expect(loose).toHaveLength(0);
    }
  });

  // Cycles must not loop forever. A ↔ B (each based on the other's head) are
  // neither leaves, so they never root a chain and fall through to loose.
  test("a 2-cycle does not loop and lands in loose", () => {
    const c1 = pr({ number: 60, head: "cy1", base: "cy2" });
    const c2 = pr({ number: 61, head: "cy2", base: "cy1" });
    const { stacks, loose } = buildStacks([c1, c2], "main");
    expect(stacks).toHaveLength(0);
    expect(sortedNums(loose.map((p) => p.number))).toEqual([60, 61]);
  });

  // A fork (one branch is the base of two PRs) must not double-count the shared
  // ancestor or crash. It degrades to one stack plus a loose sibling.
  test("a fork does not double-count the shared base", () => {
    const root = pr({ number: 70, head: "root", base: "main" });
    const child1 = pr({ number: 71, head: "child1", base: "root" });
    const child2 = pr({ number: 72, head: "child2", base: "root" });
    const { stacks, loose } = buildStacks([root, child1, child2], "main");
    // Exactly one stack contains the root; the other child is loose.
    const allStackNumbers = stacks.flatMap((s) => s.prs.map((p) => p.number));
    expect(allStackNumbers.filter((n) => n === 70)).toHaveLength(1);
    expect(stacks).toHaveLength(1);
    expect(loose.map((p) => p.number)).toContain(72);
  });
});

import { describe, expect, test } from "bun:test";
import { computePlanDiff, computeInlineDiff } from "./planDiffEngine";

describe("computePlanDiff — block-level behavior", () => {
  test("pure unchanged produces a single unchanged block, no stats", () => {
    const plan = "# Plan\n\nOne line.\n";
    const { blocks, stats } = computePlanDiff(plan, plan);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("unchanged");
    expect(stats).toEqual({ additions: 0, deletions: 0, modifications: 0 });
  });

  test("pure addition yields an added block", () => {
    const { blocks, stats } = computePlanDiff("A\n", "A\nB\n");
    const added = blocks.filter((b) => b.type === "added");
    expect(added).toHaveLength(1);
    expect(added[0].content).toContain("B");
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(0);
  });

  test("pure removal yields a removed block", () => {
    const { blocks, stats } = computePlanDiff("A\nB\n", "A\n");
    const removed = blocks.filter((b) => b.type === "removed");
    expect(removed).toHaveLength(1);
    expect(stats.deletions).toBe(1);
    expect(stats.additions).toBe(0);
  });

  test("adjacent remove+add pair becomes a modified block", () => {
    const { blocks, stats } = computePlanDiff("old line\n", "new line\n");
    const mods = blocks.filter((b) => b.type === "modified");
    expect(mods).toHaveLength(1);
    expect(mods[0].oldContent).toContain("old");
    expect(mods[0].content).toContain("new");
    expect(stats.modifications).toBe(1);
  });
});

describe("computeInlineDiff — qualification gate", () => {
  test("paragraph → paragraph with word edit qualifies", () => {
    const result = computeInlineDiff(
      "The quick brown fox.\n",
      "The slow brown fox.\n"
    );
    expect(result).not.toBeNull();
    expect(result!.wrap.type).toBe("paragraph");
    expect(result!.tokens.length).toBeGreaterThan(0);
  });

  test("heading h2 → heading h2 qualifies", () => {
    const result = computeInlineDiff("## Title\n", "## New Title\n");
    expect(result).not.toBeNull();
    expect(result!.wrap.type).toBe("heading");
    expect(result!.wrap.level).toBe(2);
  });

  test("heading h1 → heading h2 does NOT qualify (level mismatch)", () => {
    const result = computeInlineDiff("# Title\n", "## Title\n");
    expect(result).toBeNull();
  });

  test("list-item → list-item same kind qualifies", () => {
    const result = computeInlineDiff("- first item\n", "- first entry\n");
    expect(result).not.toBeNull();
    expect(result!.wrap.type).toBe("list-item");
    expect(result!.wrap.ordered).toBeUndefined();
  });

  test("ordered → unordered list-item does NOT qualify", () => {
    const result = computeInlineDiff("1. item\n", "- item\n");
    expect(result).toBeNull();
  });

  test("checkbox toggle (unchecked → checked) does NOT qualify", () => {
    const result = computeInlineDiff("- [ ] task\n", "- [x] task\n");
    expect(result).toBeNull();
  });

  test("paragraph → list-item does NOT qualify", () => {
    const result = computeInlineDiff("some text\n", "- some text\n");
    expect(result).toBeNull();
  });

  test("code block → code block does NOT qualify", () => {
    const old = "```\nconsole.log(1);\n```\n";
    const next = "```\nconsole.log(2);\n```\n";
    const result = computeInlineDiff(old, next);
    expect(result).toBeNull();
  });

  test("paragraph → two paragraphs does NOT qualify (multi-block)", () => {
    const result = computeInlineDiff("one para\n", "one para\n\nsecond para\n");
    expect(result).toBeNull();
  });

  test("paragraph with inline code qualifies; code spans round-trip atomically", () => {
    // Changed code spans are replaced with internal sentinels before the
    // word diff and restored afterwards, so the final tokens contain the
    // original `backtick-wrapped` text — not raw sentinel placeholders.
    const result = computeInlineDiff(
      "Call `foo()` here.\n",
      "Call `bar()` here.\n"
    );
    expect(result).not.toBeNull();
    const serialized = result!.tokens.map((t) => t.value).join("");
    // Sentinels must not leak through
    expect(serialized).not.toMatch(/PLDIFFCODE/);
    // The two code spans appear in the restored output, one on each side
    const removed = result!.tokens
      .filter((t) => t.type === "removed")
      .map((t) => t.value)
      .join("");
    const added = result!.tokens
      .filter((t) => t.type === "added")
      .map((t) => t.value)
      .join("");
    expect(removed).toContain("`foo()`");
    expect(added).toContain("`bar()`");
  });
});

describe("computeInlineDiff — token content", () => {
  test("single word swap produces one removed + one added token surrounded by unchanged", () => {
    const result = computeInlineDiff(
      "The quick brown fox.\n",
      "The slow brown fox.\n"
    );
    expect(result).not.toBeNull();
    const added = result!.tokens.filter((t) => t.type === "added");
    const removed = result!.tokens.filter((t) => t.type === "removed");
    expect(added.map((t) => t.value.trim())).toContain("slow");
    expect(removed.map((t) => t.value.trim())).toContain("quick");
  });

  test("unified string round-trip preserves delimiter pair around diff tags", () => {
    const result = computeInlineDiff(
      "**important** text\n",
      "**critical** text\n"
    );
    expect(result).not.toBeNull();
    const unified = result!.tokens
      .map((t) => {
        if (t.type === "added") return `<ins>${t.value}</ins>`;
        if (t.type === "removed") return `<del>${t.value}</del>`;
        return t.value;
      })
      .join("");
    expect(unified.startsWith("**")).toBe(true);
    expect(unified.includes("** text")).toBe(true);
    expect(unified).toContain("<ins>critical</ins>");
    expect(unified).toContain("<del>important</del>");
  });
});

describe("computePlanDiff — modified blocks populate inlineTokens when qualified", () => {
  test("paragraph reword populates inlineTokens", () => {
    const { blocks } = computePlanDiff(
      "The quick brown fox.\n",
      "The slow brown fox.\n"
    );
    const mod = blocks.find((b) => b.type === "modified");
    expect(mod).toBeDefined();
    expect(mod!.inlineTokens).toBeDefined();
    expect(mod!.inlineWrap?.type).toBe("paragraph");
  });

  test("modification spanning multiple blocks does NOT populate inlineTokens", () => {
    const { blocks } = computePlanDiff(
      "first paragraph\n\nsecond paragraph\n",
      "new only paragraph\n"
    );
    const mod = blocks.find((b) => b.type === "modified");
    if (mod) {
      expect(mod.inlineTokens).toBeUndefined();
    }
  });
});

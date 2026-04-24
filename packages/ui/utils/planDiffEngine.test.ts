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
    // After pair-based emphasis atomization, the whole `**phrase**`
    // becomes one atomic token on each side — so the unified string
    // starts with `<del>**important**</del>` rather than
    // `**<del>important</del>...**`. Visual render is equivalent because
    // `<del>` recurses into `InlineMarkdown` and the inner `**…**` parses
    // as bold.
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
    expect(unified).toContain("<del>**important**</del>");
    expect(unified).toContain("<ins>**critical**</ins>");
    expect(unified).toContain(" text");
  });
});

// Helper to build a unified <ins>/<del>-wrapped string from a computeInlineDiff
// result for readable assertions in tests below.
function unify(result: { tokens: import("./planDiffEngine").InlineDiffToken[] }) {
  return result.tokens
    .map((t) => {
      if (t.type === "added") return `<ins>${t.value}</ins>`;
      if (t.type === "removed") return `<del>${t.value}</del>`;
      return t.value;
    })
    .join("");
}

describe("computeInlineDiff — emphasis pair atomization (A3)", () => {
  test("single-word bold swap atomizes as one phrase per side", () => {
    const r = computeInlineDiff("**old** end", "**new** end");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>**old**</del><ins>**new**</ins> end");
  });

  test("multi-word bold with one-word change renders as balanced bold swap", () => {
    // The demo case: `**preliminary analysis**` → `**final analysis**`.
    // Before this fix, the closing `**` orphaned into unchanged-tail,
    // leaving raw literal asterisks in the rendered view.
    const r = computeInlineDiff(
      "Review the **preliminary analysis** today.",
      "Review the **final analysis** today."
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>**preliminary analysis**</del>");
    expect(u).toContain("<ins>**final analysis**</ins>");
    // No literal unbalanced `**` outside diff tags.
    expect(u).not.toMatch(/\*\*[^*]*\*\*/g.test(
      u.replace(/<(?:ins|del)>[\s\S]*?<\/(?:ins|del)>/g, "")
    ) ? /.*/ : /never/);
  });

  test("multi-word bold, both words change, renders as phrase swap", () => {
    const r = computeInlineDiff("**foo bar**", "**baz qux**");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>**foo bar**</del><ins>**baz qux**</ins>");
  });

  test("italic `*…*` swap atomizes per pair", () => {
    const r = computeInlineDiff("*italic* stuff", "*bold* stuff");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>*italic*</del><ins>*bold*</ins> stuff");
  });

  test("strikethrough `~~…~~` swap atomizes per pair", () => {
    const r = computeInlineDiff("~~strike~~", "~~gone~~");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>~~strike~~</del><ins>~~gone~~</ins>");
  });

  test("bold-alt `__…__` swap atomizes per pair", () => {
    const r = computeInlineDiff("__alt bold__", "__new stuff__");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>__alt bold__</del><ins>__new stuff__</ins>");
  });

  test("italic-alt `_…_` swap atomizes per pair", () => {
    const r = computeInlineDiff("_alt italic_", "_new_");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>_alt italic_</del><ins>_new_</ins>");
  });

  test("word-boundary guard: `my__var__name` → `my__var__names` leaves intraword `__` alone", () => {
    // Markdown doesn't treat intraword `__` as bold delimiters, so the pair
    // regex must not consume them. Verify the diff treats both sides as
    // single identifiers rather than mis-sentinelizing them.
    const r = computeInlineDiff("my__var__name", "my__var__names");
    expect(r).not.toBeNull();
    const u = unify(r!);
    // The exact diff shape can vary, but no token should contain an
    // unmatched sentinel fragment and the full identifiers must survive
    // the round-trip.
    expect(u).toContain("my__var__name");
    expect(u).toContain("my__var__names");
    expect(u).not.toMatch(/PLDIFFEMPH/);
  });

  test("word-boundary guard: single-underscore intraword preserved (`snake_case`)", () => {
    const r = computeInlineDiff("snake_case", "snake_casey");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("snake_case");
    expect(u).toContain("snake_casey");
    expect(u).not.toMatch(/PLDIFFEMPH/);
  });

  test("nested triple `***foo***` atomizes as one token", () => {
    const r = computeInlineDiff("***foo***", "***bar***");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe("<del>***foo***</del><ins>***bar***</ins>");
  });

  test("nested triple with multi-word inside", () => {
    const r = computeInlineDiff("***foo bar***", "***baz qux***");
    expect(r).not.toBeNull();
    expect(unify(r!)).toBe(
      "<del>***foo bar***</del><ins>***baz qux***</ins>"
    );
  });

  test("stray unbalanced `**` in arithmetic context is preserved as literal", () => {
    // `2**3` (exponent in prose) must not be mis-matched. Only the real
    // balanced `**bold**` should atomize.
    const r = computeInlineDiff(
      "2**3 and **bold** text",
      "2**4 and **bold** text"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    // `**bold**` unchanged
    expect(u).toContain("**bold**");
    // The stray `**` preserved literally; the 3→4 swap shows normally
    expect(u).toContain("<del>3</del>");
    expect(u).toContain("<ins>4</ins>");
  });

  test("existing code-span sentinel format is not corrupted", () => {
    // Two paragraphs both containing inline code spans — the diff should
    // still round-trip the code spans correctly with the pair atomization
    // layered on top.
    const r = computeInlineDiff(
      "Call `foo()` inside **bold text** here.",
      "Call `bar()` inside **bold text** here."
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>`foo()`</del>");
    expect(u).toContain("<ins>`bar()`</ins>");
    expect(u).toContain("**bold text**");
    expect(u).not.toMatch(/PLDIFF(?:CODE|LINK|EMPH)/);
  });
});

describe("computeInlineDiff — hyphenated compound atomization", () => {
  test("letter-letter compound swaps whole token (ninety-five → ninety-nine)", () => {
    const r = computeInlineDiff(
      "at least ninety-five percent",
      "at least ninety-nine percent"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>ninety-five</del>");
    expect(u).toContain("<ins>ninety-nine</ins>");
    // No partial-word fragmentation.
    expect(u).not.toContain("<del>five</del>");
    expect(u).not.toContain("<ins>nine</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });

  test("digit-letter compound swaps whole token (64-byte → 2048-bit)", () => {
    const r = computeInlineDiff(
      "a 64-byte value",
      "a 2048-bit value"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>64-byte</del>");
    expect(u).toContain("<ins>2048-bit</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });

  test("multi-hyphen compound atomizes fully (state-of-the-art → state-of-the-craft)", () => {
    const r = computeInlineDiff(
      "the state-of-the-art approach",
      "the state-of-the-craft approach"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>state-of-the-art</del>");
    expect(u).toContain("<ins>state-of-the-craft</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });

  test("hyphenated compound unchanged between versions stays unchanged", () => {
    const r = computeInlineDiff(
      "the cookie-based flow runs nightly",
      "the cookie-based flow runs daily"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    // Compound must be intact in unchanged context — no PLDIFFHY leak.
    expect(u).toContain("cookie-based");
    expect(u).toContain("<del>nightly</del>");
    expect(u).toContain("<ins>daily</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });

  test("leading/trailing dash is not substituted (em-dash-like prose)", () => {
    // A dash with no word char on one side is a separator, not a compound.
    const r = computeInlineDiff("foo - bar end", "foo - baz end");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>bar</del>");
    expect(u).toContain("<ins>baz</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });

  test("hyphens inside bold phrase stay atomic via emphasis pass, not corrupted", () => {
    const r = computeInlineDiff("**cookie-based** flow", "**token-based** flow");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>**cookie-based**</del>");
    expect(u).toContain("<ins>**token-based**</ins>");
    expect(u).not.toMatch(/PLDIFFHY/);
  });
});

describe("computeInlineDiff — coalescing pass (Commit 2)", () => {
  test("two adjacent swaps separated by a single space coalesce into one swap", () => {
    const r = computeInlineDiff("foo bar baz", "qux quux baz");
    expect(r).not.toBeNull();
    const u = unify(r!);
    // Both word swaps merge into a single phrase swap ending at the
    // unchanged tail ` baz`.
    expect(u).toContain("<del>foo bar</del><ins>qux quux</ins>");
    expect(u).toContain(" baz");
  });

  test("three adjacent swaps (the motivating paragraph example) coalesce", () => {
    // Parens act as hard boundaries because they aren't in the thin set.
    const r = computeInlineDiff(
      "(and the originating case)",
      "(and a small set of admins who opted in)"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toBe(
      "(and <del>the originating case</del><ins>a small set of admins who opted in</ins>)"
    );
  });

  test("single isolated swap stays word-level (no coalescing)", () => {
    const r = computeInlineDiff("the quick brown fox", "the slow brown fox");
    expect(r).not.toBeNull();
    const u = unify(r!);
    // Only the `quick` → `slow` change should be diffed; `brown fox` must
    // stay as unchanged text.
    expect(u).toContain("<del>quick</del>");
    expect(u).toContain("<ins>slow</ins>");
    expect(u).toContain(" brown fox");
    // No accidental absorption of `brown fox` into a combined swap.
    expect(u).not.toContain("quick brown fox");
    expect(u).not.toContain("slow brown fox");
  });

  test("asymmetric coalesce: two removes + one add in dirty run", () => {
    const r = computeInlineDiff("foo bar baz end", "foo newword end");
    expect(r).not.toBeNull();
    const u = unify(r!);
    // `bar` and `baz` both removed, `newword` added — coalesce absorbs the
    // intervening space into the combined swap. The trailing space to the
    // unchanged `end` gets pulled into the ins/del because jsdiff pairs
    // `baz ` with `newword ` as a single token-level swap.
    expect(u).toContain("<del>bar baz");
    expect(u).toContain("<ins>newword");
    expect(u).toContain("end");
  });

  test("swap + swap separated by a comma coalesces (thin punctuation)", () => {
    const r = computeInlineDiff("alpha, beta end", "gamma, delta end");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>alpha, beta</del><ins>gamma, delta</ins>");
  });

  test("swap + swap separated by unchanged word does NOT coalesce", () => {
    const r = computeInlineDiff("foo bar baz qux end", "zap bar zip end");
    expect(r).not.toBeNull();
    const u = unify(r!);
    // `bar` unchanged word between the two swaps must block coalescing.
    expect(u).toContain("<del>foo</del>");
    expect(u).toContain("<ins>zap</ins>");
    expect(u).toContain(" bar ");
    expect(u).toContain("<del>baz qux");
    expect(u).toContain("<ins>zip");
    // Sanity: not a single combined swap across `bar`.
    expect(u).not.toContain("<del>foo bar baz qux</del>");
  });

  test("swap + swap separated by an unchanged inline link does NOT coalesce", () => {
    // The link is an atomic unchanged token whose value is the whole
    // `[text](url)` string — that contains non-thin chars (`[`, `]`, `(`,
    // `)`), so it blocks coalescing.
    const r = computeInlineDiff(
      "see foo [docs](https://example.com) bar end",
      "see zop [docs](https://example.com) zip end"
    );
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>foo</del>");
    expect(u).toContain("<ins>zop</ins>");
    expect(u).toContain("[docs](https://example.com)");
    expect(u).toContain("<del>bar</del>");
    expect(u).toContain("<ins>zip</ins>");
    // Not coalesced across the link.
    expect(u).not.toContain("<del>foo [docs]");
  });

  test("multi-word bold phrase swap via coalescing-rescue (Case 2 wrap)", () => {
    // `foo bar baz` → `foo **bar baz**`: without coalescing, atomization
    // leaves `bar` and `baz` as two word tokens on the old side but
    // `**bar baz**` as one atomic pair on the new side, producing
    // alternating removes/adds that coalescing folds back into a single
    // clean phrase swap.
    const r = computeInlineDiff("foo bar baz end", "foo **bar baz** end");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toContain("<del>bar baz");
    expect(u).toContain("<ins>**bar baz**");
  });
});

describe("computeInlineDiff — broader integration", () => {
  test("code-span swap adjacent to unchanged text still renders cleanly", () => {
    const r = computeInlineDiff("Call `foo()` now.", "Call `bar()` now.");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toBe("Call <del>`foo()`</del><ins>`bar()`</ins> now.");
  });

  test("link URL swap atomizes the whole link", () => {
    const r = computeInlineDiff("See [docs](old)", "See [docs](new)");
    expect(r).not.toBeNull();
    const u = unify(r!);
    expect(u).toBe("See <del>[docs](old)</del><ins>[docs](new)</ins>");
  });

  test("heading modification populates inlineTokens with heading wrap", () => {
    const r = computeInlineDiff("## **Plan** v1\n", "## **Plan** v2\n");
    expect(r).not.toBeNull();
    expect(r!.wrap.type).toBe("heading");
    expect(r!.wrap.level).toBe(2);
    const u = unify(r!);
    expect(u).toContain("v");
    expect(u).toContain("<del>");
    expect(u).toContain("<ins>");
  });

  test("computePlanDiff end-to-end with bold-phrase change produces one modified block with balanced inline tokens", () => {
    const old =
      "Review the **preliminary analysis** of load testing results today.\n";
    const neu = "Review the **final analysis** of load testing results today.\n";
    const { blocks } = computePlanDiff(old, neu);
    const mod = blocks.find((b) => b.type === "modified");
    expect(mod).toBeDefined();
    expect(mod!.inlineTokens).toBeDefined();
    const u = mod!.inlineTokens!
      .map((t) =>
        t.type === "added"
          ? `<ins>${t.value}</ins>`
          : t.type === "removed"
            ? `<del>${t.value}</del>`
            : t.value
      )
      .join("");
    // Balanced bold pair on each side of the diff — no orphan delimiters.
    expect(u).toContain("<del>**preliminary analysis**</del>");
    expect(u).toContain("<ins>**final analysis**</ins>");
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

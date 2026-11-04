import { describe, expect, test } from "bun:test";
import { CODE_INLINE_DIFF_LIMIT, computeCodeInlineDiff, computeInlineDiff } from "./planDiffEngine";

const join = (tokens: { type: string; value: string }[], keep: "added" | "removed") =>
  tokens.filter((t) => t.type === "unchanged" || t.type === keep).map((t) => t.value).join("");

describe("computeCodeInlineDiff", () => {
  test("the tokens rebuild both raw sides, comment markers and list dashes included", () => {
    const oldText = '# Deployment for notes-api (version 1)\n- name: api\n  image: notes-api:1.4.2\n';
    const newText = '# Deployment for notes-api (version 2)\n- name: api\n  image: notes-api:1.5.0\n';
    const tokens = computeCodeInlineDiff(oldText, newText)!;
    expect(join(tokens, "removed")).toBe(oldText.replace(/\n$/, ""));
    expect(join(tokens, "added")).toBe(newText.replace(/\n$/, ""));
  });

  test("the markdown word diff is why: it reads a # comment as a heading and drops the #", () => {
    const inline = computeInlineDiff("# poll every 50 ms\n", "# poll every 40 ms\n");
    expect(inline?.wrap.type).toBe("heading");
    expect(inline?.tokens.map((t) => t.value).join("")).not.toContain("#");
  });

  test("a pair past the limit is not diffed inline", () => {
    const big = "x = 1\n".repeat(Math.ceil(CODE_INLINE_DIFF_LIMIT / 6));
    expect(computeCodeInlineDiff(big, `${big}y = 2\n`)).toBeNull();
  });
});

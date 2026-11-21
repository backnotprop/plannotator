import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlanDiff } from "./planDiffEngine";

// A plan version saved on Windows (CRLF) and the same plan from the editor (LF) read the same to a person, so
// comparing them must not report a rewrite. The versions are real files on disk, so the diff sees the bytes a
// stored plan version holds (a copy kept in git could be converted by autocrlf).
function onDisk(files: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "plan-eol-"));
  try {
    const out: Record<string, string> = {};
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
      out[name] = readFileSync(join(dir, name), "utf-8");
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lf = "# Plan\n\nFirst step.\nSecond step.\n\n- one\n- two\n";
const crlf = lf.replace(/\n/g, "\r\n");
const none = { additions: 0, deletions: 0, modifications: 0 };

describe("computePlanDiff, line endings", () => {
  test("the same plan with CRLF on one side and LF on the other is no change", () => {
    const f = onDisk({ "001.md": crlf, "002.md": lf });
    expect(f["001.md"]).toContain("\r\n");
    expect(f["002.md"]).not.toContain("\r");
    for (const [a, b] of [[f["001.md"], f["002.md"]], [f["002.md"], f["001.md"]], [f["001.md"], f["001.md"]]]) {
      const { blocks, stats } = computePlanDiff(a, b);
      expect(stats).toEqual(none);
      expect(blocks.every((x) => x.type === "unchanged")).toBe(true);
    }
  });

  test("a real change is one change, not a rewrite, when the old version is CRLF", () => {
    const f = onDisk({ "001.md": crlf, "002.md": lf.replace("Second step.", "Second step, revised.") });
    const { blocks, stats } = computePlanDiff(f["001.md"], f["002.md"]);
    // The diff of the same two plans with LF throughout: the line endings change nothing.
    const reference = computePlanDiff(lf, lf.replace("Second step.", "Second step, revised."));
    expect(stats).toEqual(reference.stats);
    expect(stats.modifications).toBe(1);
    expect(blocks.map((b) => b.type)).toEqual(reference.blocks.map((b) => b.type));
    const mod = blocks.find((b) => b.type === "modified");
    expect(mod?.oldContent).toContain("Second step.");
    expect(mod?.content).toContain("revised");
    expect(blocks.some((b) => b.type === "unchanged")).toBe(true);
  });

  test("a dropped trailing newline is still a change, whatever the line endings", () => {
    const { stats } = computePlanDiff(crlf, lf.replace(/\n$/, ""));
    expect(stats.additions + stats.deletions + stats.modifications).toBeGreaterThan(0);
  });

  test("a lone CR inside a code fence is content: changing it is a change, and it is kept as written", () => {
    const fence = (sep: string) => "# Plan\n\n```\nprogress 10%" + sep + "progress 20%\n```\n";
    expect(computePlanDiff(fence("\r"), fence("\n")).stats).not.toEqual(none);
    const { blocks, stats } = computePlanDiff(fence("\r"), fence("\r"));
    expect(stats).toEqual(none);
    expect(blocks.map((b) => b.content).join("")).toContain("progress 10%\rprogress 20%");
  });
});

/**
 * Context notes on a guide (issue #2588, prototype): the format version they
 * need, and the authored path's checks. The e2e proof
 * (tests/e2e/review-context-notes.spec.ts) shows they never become comments.
 */
import { describe, expect, test } from "bun:test";
import { parseGuideSnapshot } from "@plannotator/shared/guide-format";
import { buildAuthoredGuideSnapshot } from "./guide-cli";

const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";
const guide = (notes?: unknown) =>
  JSON.stringify({
    title: "T",
    intent: "I",
    sections: [{ title: "S", overview: "O", diffs: [{ file: "src/a.ts", summary: "s", ...(notes !== undefined && { notes }) }] }],
    unplacedFiles: [],
  });
const opts = { cwd: "/nonexistent", source: { kind: "local", repo: "acme/x" }, now: "2026-11-04T00:00:00.000Z" } as never;

describe("context notes", () => {
  test("a guide with a note is version 3 and keeps it; one without stays version 1", () => {
    const withNote = buildAuthoredGuideSnapshot(guide([{ lineStart: 2, lineEnd: 3, text: "Why." }]), PATCH, opts);
    expect(withNote.ok && withNote.snapshot.version).toBe(3);
    expect(withNote.ok && withNote.snapshot.guide.sections[0]!.diffs[0]!.notes).toEqual([{ lineStart: 2, lineEnd: 3, text: "Why." }]);
    const plain = buildAuthoredGuideSnapshot(guide(), PATCH, opts);
    expect(plain.ok && plain.snapshot.version).toBe(1);
  });

  test("a version 1 or 2 document cannot carry notes", () => {
    const built = buildAuthoredGuideSnapshot(guide([{ lineStart: 2, lineEnd: 2, text: "Why." }]), PATCH, opts);
    if (!built.ok) throw new Error(built.error);
    for (const version of [1, 2]) {
      const parsed = parseGuideSnapshot({ ...built.snapshot, version });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.message).toContain("notes");
    }
  });

  test("a note outside the file's hunks, or malformed, is refused by name", () => {
    const outside = buildAuthoredGuideSnapshot(guide([{ lineStart: 9, lineEnd: 9, text: "Why." }]), PATCH, opts);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toContain("sections[0].diffs[0].notes[0] lines 9-9 (new side) are not inside one hunk");
    const empty = buildAuthoredGuideSnapshot(guide([{ lineStart: 2, lineEnd: 2, text: " " }]), PATCH, opts);
    expect(!empty.ok && empty.error).toContain("notes[0].text must be a non-empty string");
    const removed = buildAuthoredGuideSnapshot(guide([{ lineStart: 2, lineEnd: 2, side: "old", text: "The old line." }]), PATCH, opts);
    expect(removed.ok).toBe(true);
  });
});

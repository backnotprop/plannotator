import { describe, expect, test } from "bun:test";
import {
  checkMermaidStructure,
  createGuideDraft,
  guideAddChapter,
  guideClearOverview,
  guideDraftProgress,
  guideDraftToOutput,
  guideFinish,
  guideMoveChapter,
  guideMoveFile,
  guidePlaceFile,
  guideRead,
  guideRemoveChapter,
  guideSaveAsIs,
  guideSetHeader,
  guideSetOverview,
  guideUnplaceFile,
  guideUpdateChapter,
  parseGuideDraft,
  runGuideBuilderTool,
  serializeGuideDraft,
  suggestChangedPath,
  type GuideBuilderAnswer,
  type GuideBuilderHooks,
  type GuideDraft,
} from "./guide-builder";
import { parseGuideSnapshot } from "./guide-format";

const PATCH = `diff --git a/src/webhooks/deliver.ts b/src/webhooks/deliver.ts
index 1111111..2222222 100644
--- a/src/webhooks/deliver.ts
+++ b/src/webhooks/deliver.ts
@@ -1,4 +1,6 @@
 export function deliverWebhook(url: string) {
-  return send(url);
+  const budget = computeBackoff(1);
+  if (budget < 0) return null;
+  return send(url, budget);
 }
@@ -40,3 +42,4 @@ export function retry() {
   wait();
+  log("retry");
 }
diff --git a/src/webhooks/backoff.ts b/src/webhooks/backoff.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/webhooks/backoff.ts
@@ -0,0 +1,3 @@
+export function computeBackoff(attempt: number) {
+  return 2 ** attempt;
+}
diff --git a/src/webhooks/deliver.test.ts b/src/webhooks/deliver.test.ts
index 4444444..5555555 100644
--- a/src/webhooks/deliver.test.ts
+++ b/src/webhooks/deliver.test.ts
@@ -1,2 +1,3 @@
 import { deliverWebhook } from "./deliver";
+test("backs off", () => {});
 test("sends", () => {});
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 6666666..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const old = 1;
-export const older = 2;
`;

const NOW = "2026-10-22T12:00:00.000Z";
const hooks: GuideBuilderHooks = { now: () => NOW };

function newDraft(): GuideDraft {
  return createGuideDraft({
    review: { rawPatch: PATCH, gitRef: "origin/main..HEAD", base: "origin/main", diffType: "merge-base", source: { kind: "local", repo: "acme/hooks", branch: "feat/backoff" } },
    generator: { engine: "claude-code", model: "sonnet" },
    now: NOW,
  });
}

function ok(a: GuideBuilderAnswer): GuideDraft {
  if (!a.ok) throw new Error(`expected ok, got: ${a.text}`);
  return a.draft;
}

function lastLine(text: string): string {
  return text.split("\n").pop()!;
}

async function twoChapters(): Promise<GuideDraft> {
  let d = newDraft();
  d = ok(await guideSetHeader(d, { title: "Webhook backoff", intent: "Retries back off instead of hammering the endpoint." }, hooks));
  d = ok(await guideAddChapter(d, { title: "Retry budget", overview: "The delivery loop asks for a budget before it sends." }, hooks));
  d = ok(await guideAddChapter(d, { title: "Tests", overview: "One new test for the backoff." }, hooks));
  return d;
}

describe("progress line", () => {
  test("every answer ends with it, and it counts what is placed and left", async () => {
    const d = newDraft();
    expect(guideDraftProgress(d).line).toBe("0 chapters · 0 of 4 files placed");
    const a = await guideSetHeader(d, { title: "T" }, hooks);
    expect(lastLine(a.text)).toBe("0 chapters · 0 of 4 files placed");
    let d2 = await twoChapters();
    d2 = ok(await guidePlaceFile(d2, { file: "src/webhooks/deliver.ts", chapter: "c1", summary: "Asks for a budget." }, hooks));
    d2 = ok(await guideUnplaceFile(d2, { file: "src/old.ts", reason: "dead code" }, hooks));
    expect(guideDraftProgress(d2).line).toBe("2 chapters · 1 of 4 files placed · 1 not in a chapter · 2 left");
    d2 = ok(await guidePlaceFile(d2, { file: "src/webhooks/backoff.ts", chapter: "c1", summary: "The backoff curve." }, hooks));
    d2 = ok(await guidePlaceFile(d2, { file: "src/webhooks/deliver.test.ts", chapter: "c2", summary: "A test." }, hooks));
    const p = guideDraftProgress(d2);
    expect(p.line).toBe("2 chapters · 3 of 4 files placed · 1 not in a chapter · ready to finish");
    expect(p.ready).toBe(true);
    expect(p.remaining).toEqual([]);
  });
});

describe("guide_set_header", () => {
  test("sets either part, says what is still missing", async () => {
    const a = await guideSetHeader(newDraft(), { title: "  Webhook backoff  " }, hooks);
    expect(a.ok).toBe(true);
    expect(a.changed).toBe(true);
    expect(a.draft.title).toBe("Webhook backoff");
    expect(a.text).toContain("still needs an intent");
    expect(a.draft.updatedAt).toBe(NOW);
  });
  test("refuses empty text, a multi-line title, and no arguments", async () => {
    const d = newDraft();
    expect((await guideSetHeader(d, { title: "   " })).text).toContain("The title is empty.");
    expect((await guideSetHeader(d, { title: "a\nb" })).text).toContain("The title is one line.");
    const none = await guideSetHeader(d, {});
    expect(none.ok).toBe(false);
    expect(none.changed).toBe(false);
    expect(none.draft).toBe(d);
  });
});

describe("chapters", () => {
  test("add answers stable ids; position inserts; at most 10", async () => {
    let d = newDraft();
    const first = await guideAddChapter(d, { title: "A", overview: "a" }, hooks);
    expect(first.chapterId).toBe("c1");
    d = first.draft;
    const front = await guideAddChapter(d, { title: "B", overview: "b", position: 1 }, hooks);
    expect(front.chapterId).toBe("c2");
    expect(front.draft.chapters.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(front.text).toContain('Added chapter c2 "B" at position 1.');
    d = front.draft;
    expect((await guideAddChapter(d, { title: "C", overview: "c", position: 4 })).text).toContain("The position is from 1 to 3.");
    for (let i = 0; i < 8; i++) d = ok(await guideAddChapter(d, { title: `X${i}`, overview: "x" }, hooks));
    const eleventh = await guideAddChapter(d, { title: "Too many", overview: "x" });
    expect(eleventh.ok).toBe(false);
    expect(eleventh.text).toContain("already has 10 chapters");
  });

  test("ids are never reused after a removal", async () => {
    let d = await twoChapters();
    d = ok(await guideRemoveChapter(d, { chapter: "c2" }, hooks));
    const again = await guideAddChapter(d, { title: "New", overview: "n" }, hooks);
    expect(again.chapterId).toBe("c3");
  });

  test("empty title or overview is refused", async () => {
    const a = await guideAddChapter(newDraft(), { title: "", overview: " " });
    expect(a.ok).toBe(false);
    expect(a.text).toContain("The chapter title is empty.");
    expect(a.text).toContain("The chapter overview is empty.");
  });

  test("unknown chapter ids, and positions given as ids, are explained", async () => {
    const d = await twoChapters();
    const unknown = await guideUpdateChapter(d, { chapter: "c9", title: "x" });
    expect(unknown.text).toContain('`c9` is not a chapter. Chapters: c1 "Retry budget", c2 "Tests".');
    const byNumber = await guideUpdateChapter(d, { chapter: "2", title: "x" });
    expect(byNumber.text).toContain("chapter 2 in reading order is c2");
    const none = await guideUpdateChapter(newDraft(), { chapter: "c1", title: "x" });
    expect(none.text).toContain("no chapters yet");
  });

  test("update changes title and overview", async () => {
    const d = await twoChapters();
    const a = await guideUpdateChapter(d, { chapter: "c2", title: "Backoff tests", overview: "Covers the backoff." }, hooks);
    expect(a.ok).toBe(true);
    expect(a.draft.chapters[1]).toMatchObject({ id: "c2", title: "Backoff tests", overview: "Covers the backoff." });
    expect((await guideUpdateChapter(d, { chapter: "c2" })).text).toContain("Give a new `title`, `overview` or `diagram`.");
  });

  test("move answers the new order", async () => {
    const d = await twoChapters();
    const a = await guideMoveChapter(d, { chapter: "c2", position: 1 }, hooks);
    expect(a.draft.chapters.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(a.text).toContain('Order: 1. c2 "Tests", 2. c1 "Retry budget".');
    expect((await guideMoveChapter(d, { chapter: "c2", position: 3 })).text).toContain("The position is from 1 to 2.");
    const same = await guideMoveChapter(d, { chapter: "c1", position: 1 });
    expect(same.ok).toBe(true);
    expect(same.changed).toBe(false);
  });

  test("moving or removing a chapter names the chapter: links it re-points", async () => {
    let d = await twoChapters();
    d = ok(await guideAddChapter(d, { title: "Glue", overview: "Wiring, after [the tests](chapter:2)." }, hooks));
    d = ok(await guideSetOverview(d, { text: "Start at [budget](chapter:1), then [tests](chapter:2).", diagram: { kind: "mermaid", source: 'flowchart LR\n  a --> b\n  click b "chapter:2"' } }, hooks));
    const moved = await guideMoveChapter(d, { chapter: "c2", position: 1 }, hooks);
    expect(moved.text).toContain('`chapter:1` in the overview now points at c2 "Tests" (was c1 "Retry budget").');
    expect(moved.text).toContain('`chapter:2` in the overview now points at c1 "Retry budget" (was c2 "Tests").');
    expect(moved.text).toContain('`chapter:2` in the overview diagram now points at c1 "Retry budget"');
    expect(moved.text).toContain('`chapter:2` in the overview of c3 now points at c1 "Retry budget"');
    const removed = await guideRemoveChapter(d, { chapter: "c1" }, hooks);
    expect(removed.text).toContain('`chapter:1` in the overview now points at c2 "Tests" (was c1 "Retry budget").');
    expect(removed.text).toContain('`chapter:2` in the overview now points at c3 "Glue" (was c2 "Tests").');
    let e = await twoChapters();
    e = ok(await guideAddChapter(e, { title: "Glue", overview: "Wiring." }, hooks));
    e = ok(await guideSetOverview(e, { text: "Start at [budget](chapter:1)." }, hooks));
    const quiet = await guideMoveChapter(e, { chapter: "c3", position: 2 }, hooks);
    expect(quiet.ok).toBe(true);
    expect(quiet.text).not.toContain("now points at");
  });

  test("remove sends its files back to not placed", async () => {
    let d = await twoChapters();
    d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.test.ts", chapter: "c2", summary: "A test." }, hooks));
    const a = await guideRemoveChapter(d, { chapter: "c2" }, hooks);
    expect(a.ok).toBe(true);
    expect(a.text).toContain("1 file is back to not placed: `src/webhooks/deliver.test.ts`.");
    expect(guideDraftProgress(a.draft).remaining).toContain("src/webhooks/deliver.test.ts");
  });
});

describe("files", () => {
  test("a path not in the change gets a did-you-mean", async () => {
    const d = await twoChapters();
    const a = await guidePlaceFile(d, { file: "src/webhook/deliver.ts", chapter: "c1", summary: "x" });
    expect(a.ok).toBe(false);
    expect(a.text).toContain("`src/webhook/deliver.ts` is not in this change. Did you mean `src/webhooks/deliver.ts`?");
    const far = await guidePlaceFile(d, { file: "totally/else.go", chapter: "c1", summary: "x" });
    expect(far.text).toContain("is not in this change. Call guide_read to see the changed files.");
  });

  test("suggestChangedPath: case, leading ./, distance, same name", () => {
    const changed = ["src/webhooks/deliver.ts", "src/webhooks/backoff.ts", "lib/very/deep/path/config.json"];
    expect(suggestChangedPath("SRC/Webhooks/Deliver.ts", changed)).toBe("src/webhooks/deliver.ts");
    expect(suggestChangedPath("./src/webhooks/backoff.ts", changed)).toBe("src/webhooks/backoff.ts");
    expect(suggestChangedPath("config.json", changed)).toBe("lib/very/deep/path/config.json");
    expect(suggestChangedPath("unrelated/thing.rs", changed)).toBeUndefined();
  });

  test("a file already in another chapter must be moved; placing again in its own chapter updates the summary", async () => {
    let d = await twoChapters();
    d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.test.ts", chapter: "c2", summary: "A test." }, hooks));
    const twice = await guidePlaceFile(d, { file: "src/webhooks/deliver.test.ts", chapter: "c1", summary: "x" });
    expect(twice.ok).toBe(false);
    expect(twice.text).toContain("`src/webhooks/deliver.test.ts` is already in chapter 2 (c2). Use guide_move_file to move it.");
    const again = await guidePlaceFile(d, { file: "src/webhooks/deliver.test.ts", chapter: "c2", summary: "The backoff test." }, hooks);
    expect(again.ok).toBe(true);
    expect(again.draft.chapters[1].files).toEqual([{ file: "src/webhooks/deliver.test.ts", summary: "The backoff test." }]);
  });

  test("empty summary is refused; placing reports what is left", async () => {
    const d = await twoChapters();
    expect((await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "" })).text).toContain("The summary is empty.");
    const a = await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "Removed." }, hooks);
    expect(a.text).toContain("3 files are still not placed.");
  });

  test("focus: line ranges must touch changed head lines; hunks must exist", async () => {
    const d = await twoChapters();
    const place = (focus: Array<{ start?: number; end?: number; hunk?: number }>) =>
      guidePlaceFile(d, { file: "src/webhooks/deliver.ts", chapter: "c1", summary: "x", focus }, hooks);
    const good = await place([{ start: 2, end: 4 }, { hunk: 2 }, { start: 44 }]);
    expect(good.ok).toBe(true);
    expect(good.draft.chapters[0].files[0].focus).toEqual([{ start: 2, end: 4 }, { hunk: 2 }, { start: 44, end: 44 }]);
    expect((await place([{ start: 20, end: 30 }])).text).toContain("Lines 20-30 of `src/webhooks/deliver.ts` are outside its changed lines (1-6, 42-45).");
    expect((await place([{ hunk: 3 }])).text).toContain("has 2 hunks; hunk 3 is not one of them.");
    expect((await place([{ start: 5, end: 2 }])).text).toContain("not a range on the head");
    expect((await place([{ start: 2, hunk: 1 }])).text).toContain("not both");
    const deleted = await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "x", focus: [{ hunk: 1 }] });
    expect(deleted.text).toContain("is deleted in this change, so it has no lines to focus on.");
  });

  test("move says from which chapter; unplaced files must be placed, not moved", async () => {
    let d = await twoChapters();
    d = ok(await guidePlaceFile(d, { file: "src/webhooks/backoff.ts", chapter: "c2", summary: "Curve.", focus: [{ hunk: 1 }] }, hooks));
    const a = await guideMoveFile(d, { file: "src/webhooks/backoff.ts", chapter: "c1" }, hooks);
    expect(a.text).toContain("Moved `src/webhooks/backoff.ts` from chapter 2 (c2) to chapter 1 (c1).");
    expect(a.draft.chapters[0].files).toEqual([{ file: "src/webhooks/backoff.ts", summary: "Curve.", focus: [{ hunk: 1 }] }]);
    expect(a.draft.chapters[1].files).toEqual([]);
    const notPlaced = await guideMoveFile(d, { file: "src/old.ts", chapter: "c1" });
    expect(notPlaced.text).toContain("`src/old.ts` is not in a chapter yet. Use guide_place_file to place it.");
  });

  test("unplacing again without a reason keeps the earlier reason", async () => {
    let d = await twoChapters();
    d = ok(await guideUnplaceFile(d, { file: "src/old.ts", reason: "dead code" }, hooks));
    const again = await guideUnplaceFile(d, { file: "src/old.ts" }, hooks);
    expect(again.draft.unplaced).toEqual([{ file: "src/old.ts", reason: "dead code" }]);
    const replaced = await guideUnplaceFile(d, { file: "src/old.ts", reason: "generated" }, hooks);
    expect(replaced.draft.unplaced).toEqual([{ file: "src/old.ts", reason: "generated" }]);
  });

  test("unplace takes a file out of its chapter; placing it later brings it back", async () => {
    let d = await twoChapters();
    d = ok(await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "Removed." }, hooks));
    const a = await guideUnplaceFile(d, { file: "src/old.ts", reason: "dead code" }, hooks);
    expect(a.text).toContain('Took `src/old.ts` out of chapter 1 (c1); it goes to "Not in a chapter".');
    expect(a.draft.unplaced).toEqual([{ file: "src/old.ts", reason: "dead code" }]);
    const back = await guidePlaceFile(a.draft, { file: "src/old.ts", chapter: "c2", summary: "Removed." }, hooks);
    expect(back.text).toContain("It was marked not in a chapter; it is in this chapter now.");
    expect(back.draft.unplaced).toEqual([]);
  });
});

describe("guide_set_overview", () => {
  test("accepts prose with resolving links and a Mermaid diagram", async () => {
    const d = await twoChapters();
    const a = await guideSetOverview(
      d,
      {
        text: "Delivery asks [`computeBackoff`](symbol:computeBackoff) for a budget ([here](code:src/webhooks/deliver.ts#L2-L3)); see [the tests](chapter:2).",
        diagram: { kind: "mermaid", source: 'flowchart LR\n  d[deliver] --> b[backoff]\n  click d "code:src/webhooks/deliver.ts#L1"' },
      },
      hooks,
    );
    expect(a.ok).toBe(true);
    expect(a.text).toContain("Set the overview with a Mermaid diagram.");
    expect(a.text).toContain("4 links checked.");
    expect(a.draft.overview?.diagram?.kind).toBe("mermaid");
  });

  test("links that do not resolve are refused, all at once", async () => {
    const d = await twoChapters();
    const a = await guideSetOverview(d, {
      text: "[a](code:src/webhook/deliver.ts) [b](code:src/webhooks/backoff.ts#L9) [c](code:src/old.ts#L1) [d](chapter:0) [e](code:/abs.ts)",
    });
    expect(a.ok).toBe(false);
    expect(a.text).toContain("`code:src/webhook/deliver.ts`: `src/webhook/deliver.ts` is not in this change. Did you mean `src/webhooks/deliver.ts`?");
    expect(a.text).toContain("`code:src/webhooks/backoff.ts#L9`: `src/webhooks/backoff.ts` has 3 lines at the head.");
    expect(a.text).toContain("`src/old.ts` is deleted in this change");
    expect(a.text).toContain("`chapter:0`: chapters are numbered from 1");
    expect(a.text).toContain("without a leading /");
    expect(a.draft).toBe(d);
  });

  test("a chapter link past the chapters written so far is a note, checked again at finish", async () => {
    const d = await twoChapters();
    const a = await guideSetOverview(d, { text: "Start at [the end](chapter:5)." }, hooks);
    expect(a.ok).toBe(true);
    expect(a.text).toContain("`chapter:5`: there are 2 chapters so far; guide_finish checks it again.");
  });

  test("symbols: the host decides when it can; otherwise the changed lines are searched", async () => {
    const d = await twoChapters();
    const found = await guideSetOverview(d, { text: "[x](symbol:computeBackoff)" }, hooks);
    expect(found.ok).toBe(true);
    expect(found.text).not.toContain("not checked");
    const unchecked = await guideSetOverview(d, { text: "[x](symbol:somewhereElse)" }, hooks);
    expect(unchecked.ok).toBe(true);
    expect(unchecked.text).toContain("`symbol:somewhereElse` is not in the changed lines and was not checked.");
    const lsp: GuideBuilderHooks = {
      ...hooks,
      resolveSymbol: ({ name }) =>
        name === "send"
          ? { status: "ambiguous", candidates: ["src/a.ts#send", "src/b.ts#send"] }
          : name === "computeBackof"
            ? { status: "missing", suggestions: ["computeBackoff"] }
            : { status: "found" },
    };
    const amb = await guideSetOverview(d, { text: "[x](symbol:send)" }, lsp);
    expect(amb.ok).toBe(false);
    expect(amb.text).toContain("more than one `send`. Name the file: `src/a.ts#send`, `src/b.ts#send`.");
    const missing = await guideSetOverview(d, { text: "[x](symbol:computeBackof)" }, lsp);
    expect(missing.text).toContain("no symbol `computeBackof` was found. Did you mean `computeBackoff`?");
    expect((await guideSetOverview(d, { text: "[x](symbol:src/webhooks/backoff.ts#computeBackoff)" }, lsp)).ok).toBe(true);
  });

  test("lines in a modified file are checked against its length at the head when the host knows it", async () => {
    const d = await twoChapters();
    expect((await guideSetOverview(d, { text: "[x](code:src/webhooks/deliver.ts#L90)" }, hooks)).ok).toBe(true);
    const fs: GuideBuilderHooks = { ...hooks, resolveFile: ({ path }) => (path === "src/webhooks/deliver.ts" ? { exists: true, lineCount: 50 } : { exists: false }) };
    const past = await guideSetOverview(d, { text: "[x](code:src/webhooks/deliver.ts#L40-L90)" }, fs);
    expect(past.ok).toBe(false);
    expect(past.text).toContain("`code:src/webhooks/deliver.ts#L40-L90`: `src/webhooks/deliver.ts` has 50 lines at the head.");
    expect((await guideSetOverview(d, { text: "[x](code:src/webhooks/deliver.ts#L50)" }, fs)).ok).toBe(true);
  });

  test("code links outside the change: checked by the host, or noted", async () => {
    const d = await twoChapters();
    const noted = await guideSetOverview(d, { text: "[cfg](code:config/app.yml#L3)" }, hooks);
    expect(noted.ok).toBe(true);
    expect(noted.text).toContain("`code:config/app.yml#L3` is outside this change and was not checked.");
    const fs: GuideBuilderHooks = { ...hooks, resolveFile: ({ path }) => (path === "config/app.yml" ? { exists: true, lineCount: 2 } : { exists: false }) };
    expect((await guideSetOverview(d, { text: "[cfg](code:config/app.yml#L3)" }, fs)).text).toContain("`config/app.yml` has 2 lines.");
    expect((await guideSetOverview(d, { text: "[n](code:nope.ts)" }, fs)).text).toContain("`nope.ts` does not exist at the head.");
  });

  test("Mermaid: structure always, rendering when the host can", async () => {
    const d = await twoChapters();
    const bad = await guideSetOverview(d, { text: "x", diagram: { kind: "mermaid", source: "a --> b" } });
    expect(bad.text).toContain("A Mermaid diagram starts with its type");
    const render: GuideBuilderHooks = { ...hooks, checkMermaid: () => ({ ok: false, error: "Parse error on line 2: unexpected '-->'" }) };
    const failed = await guideSetOverview(d, { text: "x", diagram: { kind: "mermaid", source: "flowchart TD\n -->" } }, render);
    expect(failed.text).toContain("The Mermaid diagram does not render: Parse error on line 2");
    const big = await guideSetOverview(d, { text: "x", diagram: { kind: "mermaid", source: `flowchart TD\n${"a-->b\n".repeat(12_000)}` } });
    expect(big.text).toMatch(/The diagram is \d+ KB; keep it under 64 KB\./);
  });

  test("checkMermaidStructure skips front matter and comments", () => {
    expect(checkMermaidStructure("---\ntitle: x\n---\n%% note\nsequenceDiagram\n  A->>B: hi")).toBeNull();
    expect(checkMermaidStructure("stateDiagram-v2\n  [*] --> A")).toBeNull();
    expect(checkMermaidStructure("  \n")).toBe("The Mermaid diagram is empty.");
  });

  test("HTML: refused without a sanitizer; sanitized and reported with one", async () => {
    const d = await twoChapters();
    const none = await guideSetOverview(d, { text: "x", diagram: { kind: "html", source: "<svg></svg>" } });
    expect(none.text).toContain("HTML diagrams cannot be checked here");
    const sanitize: GuideBuilderHooks = {
      ...hooks,
      sanitizeHtml: (source) => ({ html: source.replace(/<script[\s\S]*?<\/script>/g, ""), removed: ["a <script> element"] }),
    };
    const a = await guideSetOverview(d, { text: "x", diagram: { kind: "html", source: '<svg><a href="code:src/webhooks/deliver.ts"><rect/></a></svg><script>alert(1)</script>' } }, sanitize);
    expect(a.ok).toBe(true);
    expect(a.text).toContain("Removed from the HTML: a <script> element.");
    expect(a.draft.overview?.diagram?.source).not.toContain("<script>");
    const growing: GuideBuilderHooks = { ...hooks, sanitizeHtml: () => ({ html: `<svg>${"x".repeat(70 * 1024)}</svg>`, removed: [] }) };
    const grown = await guideSetOverview(d, { text: "x", diagram: { kind: "html", source: "<svg>small</svg>" } }, growing);
    expect(grown.ok).toBe(false);
    expect(grown.text).toMatch(/The sanitized HTML is \d+ KB; keep it under 64 KB\./);
    const broken = await guideSetOverview(d, { text: "x", diagram: { kind: "html", source: '<a href="code:missing/file.tsx">x</a>' } }, sanitize);
    expect(broken.ok).toBe(true);
    expect(broken.text).toContain("not checked");
  });

  test("replacing and clearing", async () => {
    let d = await twoChapters();
    d = ok(await guideSetOverview(d, { text: "first" }, hooks));
    const again = await guideSetOverview(d, { text: "second" }, hooks);
    expect(again.text).toContain("Replaced the overview.");
    const cleared = guideClearOverview(again.draft, hooks);
    expect(cleared.draft.overview).toBeUndefined();
  });

  test("links in chapter overviews are checked the same way", async () => {
    const d = await twoChapters();
    const a = await guideAddChapter(d, { title: "Glue", overview: "See [x](code:src/webhook/deliver.ts)." });
    expect(a.ok).toBe(false);
    expect(a.text).toContain("Did you mean `src/webhooks/deliver.ts`?");
  });
});

describe("guide_read", () => {
  test("shows the draft in order with ids, summaries, focus, and what is left", async () => {
    let d = await twoChapters();
    d = ok(await guideSetOverview(d, { text: "How it fits.", diagram: { kind: "mermaid", source: "flowchart LR\n  a --> b" } }, hooks));
    d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.ts", chapter: "c1", summary: "Asks for a budget.", focus: [{ start: 2, end: 3 }, { hunk: 2 }] }, hooks));
    d = ok(await guideUnplaceFile(d, { file: "src/old.ts", reason: "dead code" }, hooks));
    const a = await guideRead(d);
    expect(a.ok).toBe(true);
    expect(a.changed).toBe(false);
    expect(a.text).toContain("Title: Webhook backoff");
    expect(a.text).toContain("Diagram (mermaid):");
    expect(a.text).toContain("1. c1 · Retry budget");
    expect(a.text).toContain("   - src/webhooks/deliver.ts: Asks for a budget. [focus: L2-L3, hunk 2]");
    expect(a.text).toContain("2. c2 · Tests");
    expect(a.text).toContain("   Files: none yet.");
    expect(a.text).toContain("Not placed yet (2):\n- src/webhooks/backoff.ts (+3 -0, added)\n- src/webhooks/deliver.test.ts (+1 -0)");
    expect(a.text).toContain("Not in a chapter, on purpose (1):\n- src/old.ts: dead code");
    expect(lastLine(a.text)).toBe("2 chapters · 1 of 4 files placed · 1 not in a chapter · 2 left");
  });

  test("an empty draft lists every changed file", async () => {
    const a = await guideRead(newDraft());
    expect(a.text).toContain("Title: (not set)");
    expect(a.text).toContain("Chapters: none yet.");
    expect(a.text).toContain("Not placed yet (4):");
    expect(a.text).toContain("- src/old.ts (+0 -2, deleted)");
  });
});

async function completeDraft(): Promise<GuideDraft> {
  let d = await twoChapters();
  d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.ts", chapter: "c1", summary: "Asks for a budget.", focus: [{ hunk: 1 }] }, hooks));
  d = ok(await guidePlaceFile(d, { file: "src/webhooks/backoff.ts", chapter: "c1", summary: "The curve." }, hooks));
  d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.test.ts", chapter: "c2", summary: "A test." }, hooks));
  d = ok(await guideUnplaceFile(d, { file: "src/old.ts" }, hooks));
  return d;
}

describe("guide_finish", () => {
  test("refuses, naming every problem, while the draft is incomplete", async () => {
    const a = await guideFinish(newDraft(), hooks);
    expect(a.ok).toBe(false);
    expect(a.snapshot).toBeUndefined();
    expect(a.text).toContain("The guide has no title.");
    expect(a.text).toContain("The guide has no intent.");
    expect(a.text).toContain("The guide has no chapters.");
    expect(a.text).toContain("4 changed files are neither placed nor marked not in a chapter: `src/webhooks/deliver.ts`, `src/webhooks/backoff.ts`, `src/webhooks/deliver.test.ts`, `src/old.ts`.");
    const d = await twoChapters();
    const empty = await guideFinish(ok(await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "x" }, hooks)), hooks);
    expect(empty.text).toContain('chapter 2 (c2) "Tests" has no files. Place files in it or remove it.');
  });

  test("a chapter link past the last chapter fails at finish", async () => {
    let d = await completeDraft();
    d = ok(await guideSetOverview(d, { text: "See [x](chapter:3)." }, hooks));
    const a = await guideFinish(d, hooks);
    expect(a.ok).toBe(false);
    expect(a.text).toContain("The overview links to `chapter:3`, but the guide has 2 chapters.");
  });

  test("without an overview: a version-1 snapshot that the strict parser accepts", async () => {
    const d = await completeDraft();
    const a = await guideFinish(d, hooks);
    expect(a.ok).toBe(true);
    expect(a.text).toContain('Saved "Webhook backoff": 2 chapters.');
    const s = a.snapshot!;
    expect(s.version).toBe(1);
    expect("overview" in s.guide).toBe(false);
    expect(s.guide.sections).toEqual([
      { title: "Retry budget", overview: "The delivery loop asks for a budget before it sends.", diffs: [{ file: "src/webhooks/deliver.ts", summary: "Asks for a budget." }, { file: "src/webhooks/backoff.ts", summary: "The curve." }] },
      { title: "Tests", overview: "One new test for the backoff.", diffs: [{ file: "src/webhooks/deliver.test.ts", summary: "A test." }] },
    ]);
    expect(s.guide.unplacedFiles).toEqual(["src/old.ts"]);
    expect(s.guide.reviewed).toEqual([false, false]);
    expect(s.review).toEqual({ rawPatch: PATCH, gitRef: "origin/main..HEAD", diffType: "merge-base", base: "origin/main" });
    expect(s.generator).toEqual({ generatedAt: NOW, engine: "claude-code", model: "sonnet" });
    expect(s.exportedAt).toBe(NOW);
    expect(parseGuideSnapshot(JSON.parse(JSON.stringify(s))).ok).toBe(true);
  });

  test("with an overview: a version-2 snapshot carrying it", async () => {
    let d = await completeDraft();
    d = ok(await guideSetOverview(d, { text: "How it fits: [tests](chapter:2).", diagram: { kind: "mermaid", source: "flowchart LR\n  a --> b" } }, hooks));
    const a = await guideFinish(d, hooks);
    expect(a.ok).toBe(true);
    expect(a.snapshot!.version).toBe(2);
    expect(a.snapshot!.guide.overview).toEqual({ text: "How it fits: [tests](chapter:2).", diagram: { kind: "mermaid", source: "flowchart LR\n  a --> b" } });
    expect(parseGuideSnapshot(JSON.parse(JSON.stringify(a.snapshot))).ok).toBe(true);
  });
});

describe("save as is", () => {
  test("remaining files go to Not in a chapter, empty chapters drop, dangling chapter links become text", async () => {
    let d = newDraft();
    d = ok(await guideAddChapter(d, { title: "Core", overview: "The core. Then [tests](chapter:2)." }, hooks));
    d = ok(await guideAddChapter(d, { title: "Tests", overview: "Nothing yet." }, hooks));
    d = ok(await guideSetOverview(d, { text: "Read [core](chapter:1), then [tests](chapter:2).", diagram: { kind: "mermaid", source: 'flowchart LR\n  a --> b\n  click b "chapter:2"\n  click a "chapter:1"' } }, hooks));
    d = ok(await guidePlaceFile(d, { file: "src/webhooks/deliver.ts", chapter: "c1", summary: "Budget." }, hooks));
    const a = await guideSaveAsIs(d, hooks);
    expect(a.ok).toBe(true);
    expect(a.text).toContain('3 files went to "Not in a chapter".');
    expect(a.text).toContain("Dropped 1 empty chapter.");
    const s = a.snapshot!;
    expect(s.guide.title).toBe("Guided review");
    expect(s.guide.intent).toBe("");
    expect(s.guide.sections.map((x) => x.title)).toEqual(["Core"]);
    expect(s.guide.sections[0].overview).toBe("The core. Then tests.");
    expect(s.guide.overview?.text).toBe("Read [core](chapter:1), then tests.");
    expect(s.guide.overview?.diagram?.source).toBe('flowchart LR\n  a --> b\n  click a "chapter:1"');
    expect(s.guide.unplacedFiles?.sort()).toEqual(["src/old.ts", "src/webhooks/backoff.ts", "src/webhooks/deliver.test.ts"]);
  });

  test("HTML links to dropped chapters lose their href, quoted or not", async () => {
    const html: GuideBuilderHooks = { ...hooks, sanitizeHtml: (source) => ({ html: source, removed: [] }) };
    let d = newDraft();
    d = ok(await guideAddChapter(d, { title: "Core", overview: "The core." }, hooks));
    d = ok(await guideAddChapter(d, { title: "Later", overview: "Empty." }, hooks));
    d = ok(await guideSetOverview(d, { text: "Picture.", diagram: { kind: "html", source: '<svg><a href=chapter:2><rect/></a><a href="chapter:1"><rect/></a><a xlink:href=\'chapter:2\'><rect/></a></svg>' } }, html));
    d = ok(await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "Gone." }, hooks));
    const a = await guideSaveAsIs(d, html);
    expect(a.ok).toBe(true);
    expect(a.snapshot!.guide.overview?.diagram?.source).toBe('<svg><a><rect/></a><a href="chapter:1"><rect/></a><a><rect/></a></svg>');
  });

  test("a refused save leaves the caller's draft exactly as it was", async () => {
    let d = newDraft();
    d = ok(await guideAddChapter(d, { title: "Empty", overview: "Nothing placed." }, hooks));
    const a = await guideSaveAsIs(d, hooks);
    expect(a.ok).toBe(false);
    expect(a.changed).toBe(false);
    expect(a.draft).toBe(d);
    expect(a.draft.chapters.map((c) => c.id)).toEqual(["c1"]);
    expect(a.text).toContain("The guide has no chapters.");
    expect(lastLine(a.text)).toBe(guideDraftProgress(d).line);
  });
});

describe("drafts serialize and resume", () => {
  test("round trip through JSON, then keep building", async () => {
    const d = await completeDraft();
    const parsed = parseGuideDraft(serializeGuideDraft(d));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft).toEqual(d);
    const finished = await guideFinish(parsed.draft, hooks);
    expect(finished.ok).toBe(true);
  });

  test("malformed drafts are refused with a reason", () => {
    expect(parseGuideDraft("{nope")).toEqual({ ok: false, error: "The draft is not valid JSON." });
    expect(parseGuideDraft({ kind: "other" })).toMatchObject({ ok: false });
    const d = JSON.parse(serializeGuideDraft(newDraft()));
    expect(parseGuideDraft({ ...d, version: 9 })).toMatchObject({ ok: false, error: "Unsupported draft version: 9." });
    expect(parseGuideDraft({ ...d, chapters: [{ id: "c1" }] })).toMatchObject({ ok: false, error: "A chapter in the draft is malformed." });
    expect(parseGuideDraft({ ...d, review: { gitRef: "x" } })).toMatchObject({ ok: false });
  });

  test("operations never mutate their input", async () => {
    const d = await twoChapters();
    const before = serializeGuideDraft(d);
    await guidePlaceFile(d, { file: "src/old.ts", chapter: "c1", summary: "x" }, hooks);
    await guideMoveChapter(d, { chapter: "c2", position: 1 }, hooks);
    await guideRemoveChapter(d, { chapter: "c1" }, hooks);
    expect(serializeGuideDraft(d)).toBe(before);
  });
});

describe("runGuideBuilderTool", () => {
  test("dispatches by name with raw arguments", async () => {
    let d = newDraft();
    d = ok(await runGuideBuilderTool(d, "guide_set_header", { title: "T", intent: "I" }, hooks));
    const added = await runGuideBuilderTool(d, "guide_add_chapter", { title: "A", overview: "a" }, hooks);
    expect(added.chapterId).toBe("c1");
    d = added.draft;
    d = ok(await runGuideBuilderTool(d, "guide_place_file", { file: "src/old.ts", chapter: "c1", summary: "Gone.", focus: [] }, hooks));
    const numeric = await runGuideBuilderTool(d, "guide_move_file", { file: "src/old.ts", chapter: 1 }, hooks);
    expect(numeric.text).toContain("chapter 1 in reading order is c1");
    const read = await runGuideBuilderTool(d, "guide_read", undefined, hooks);
    expect(read.ok).toBe(true);
  });

  test("argument problems are plain answers", async () => {
    const d = newDraft();
    expect((await runGuideBuilderTool(d, "guide_nope", {})).text).toContain("There is no tool `guide_nope`.");
    expect((await runGuideBuilderTool(d, "guide_add_chapter", { title: "A" })).text).toContain("guide_add_chapter needs `overview`. It takes: title, overview, diagram, position.");
    expect((await runGuideBuilderTool(d, "guide_read", { verbose: true })).text).toContain("`verbose` is not an argument of guide_read. It takes no arguments.");
    expect((await runGuideBuilderTool(d, "guide_add_chapter", { title: 3, overview: "a" })).text).toContain("`title` is text.");
    expect((await runGuideBuilderTool(d, "guide_add_chapter", { title: "a", overview: "a", position: 1.5 })).text).toContain("`position` is a whole number.");
    expect((await runGuideBuilderTool(d, "guide_set_overview", { text: "a", diagram: { kind: "svg", source: "x" } })).text).toContain("`diagram.kind` is `mermaid` or `html`.");
    expect((await runGuideBuilderTool(d, "guide_set_overview", { text: "a", diagram: { kind: "mermaid", source: "x", alt: "y" } })).text).toContain("`diagram` takes only `kind` and `source`");
    expect((await runGuideBuilderTool(d, "guide_place_file", { file: "a", chapter: "c1", summary: "s", focus: [{ line: 3 }] })).text).toContain("not `line`");
    expect((await runGuideBuilderTool(d, "guide_set_header", "nope")).text).toContain("The arguments of guide_set_header are an object.");
    expect(lastLine((await runGuideBuilderTool(d, "guide_finish", {})).text)).toBe("0 chapters · 0 of 4 files placed");
  });
});

describe("chapter diagrams", () => {
  const FLOW = 'flowchart LR\n  d[deliver] --> b[backoff]\n  click b "symbol:computeBackoff"';

  test("add with a diagram: checked like the overview's, stored on the chapter", async () => {
    const d = await twoChapters();
    const a = await guideAddChapter(d, { title: "Picture", overview: "How it flows.", diagram: { kind: "mermaid", source: `  ${FLOW}\n` } }, hooks);
    expect(a.ok).toBe(true);
    expect(a.text).toContain('Added chapter c3 "Picture" at position 3 with a Mermaid diagram.');
    expect(a.draft.chapters[2].diagram).toEqual({ kind: "mermaid", source: FLOW });
    expect("diagram" in a.draft.chapters[0]).toBe(false);
  });

  test("add refuses a bad kind, an empty source, an unrendered diagram and an unresolved link, leaving the draft as it was", async () => {
    const d = await twoChapters();
    const add = (diagram: { kind: any; source: string }, h: GuideBuilderHooks = hooks) => guideAddChapter(d, { title: "P", overview: "o", diagram }, h);
    const kind = await add({ kind: "svg", source: "<svg/>" });
    expect(kind.ok).toBe(false);
    expect(kind.text).toContain("The diagram's `kind` is `mermaid` or `html`.");
    expect((await add({ kind: "mermaid", source: "  " })).text).toContain("The diagram's `source` is empty.");
    expect((await add({ kind: "mermaid", source: "a --> b" })).text).toContain("A Mermaid diagram starts with its type");
    const render: GuideBuilderHooks = { ...hooks, checkMermaid: () => ({ ok: false, error: "Parse error on line 2" }) };
    const unrendered = await add({ kind: "mermaid", source: "flowchart TD\n -->" }, render);
    expect(unrendered.ok).toBe(false);
    expect(unrendered.text).toContain("The Mermaid diagram does not render: Parse error on line 2");
    const link = await add({ kind: "mermaid", source: 'flowchart LR\n  a --> b\n  click a "code:src/webhook/deliver.ts"' });
    expect(link.ok).toBe(false);
    expect(link.text).toContain("Did you mean `src/webhooks/deliver.ts`?");
    expect((await add({ kind: "html", source: "<svg></svg>" })).text).toContain("HTML diagrams cannot be checked here");
    for (const a of [kind, unrendered, link]) {
      expect(a.changed).toBe(false);
      expect(a.draft).toBe(d);
    }
  });

  test("update sets, replaces and removes a chapter's diagram, keeping its text", async () => {
    let d = await twoChapters();
    const set = await guideUpdateChapter(d, { chapter: "c2", diagram: { kind: "mermaid", source: FLOW } }, hooks);
    expect(set.text).toContain("Added a Mermaid diagram.");
    d = ok(set);
    expect(d.chapters[1]).toMatchObject({ title: "Tests", overview: "One new test for the backoff.", diagram: { kind: "mermaid", source: FLOW } });
    const sanitize: GuideBuilderHooks = { ...hooks, sanitizeHtml: (source) => ({ html: source.replace(/<script[\s\S]*?<\/script>/g, ""), removed: ["a <script> element"] }) };
    const replaced = await guideUpdateChapter(d, { chapter: "c2", diagram: { kind: "html", source: "<svg><rect/></svg><script>x()</script>" } }, sanitize);
    expect(replaced.text).toContain("Replaced its diagram with an HTML diagram.");
    expect(replaced.text).toContain("Removed from the HTML: a <script> element.");
    expect(replaced.draft.chapters[1].diagram).toEqual({ kind: "html", source: "<svg><rect/></svg>" });
    d = ok(await guideUpdateChapter(d, { chapter: "c2", title: "Tests, renamed", diagram: null }, hooks));
    expect(d.chapters[1].title).toBe("Tests, renamed");
    expect("diagram" in d.chapters[1]).toBe(false);
    const none = await guideUpdateChapter(d, { chapter: "c2", diagram: null }, hooks);
    expect(none.ok).toBe(true);
    expect(none.changed).toBe(false);
    expect(none.draft).toBe(d);
  });

  test("update refuses a diagram that does not render, and keeps the old one", async () => {
    let d = await twoChapters();
    d = ok(await guideUpdateChapter(d, { chapter: "c1", diagram: { kind: "mermaid", source: FLOW } }, hooks));
    const render: GuideBuilderHooks = { ...hooks, checkMermaid: () => ({ ok: false, error: "boom" }) };
    const a = await guideUpdateChapter(d, { chapter: "c1", diagram: { kind: "mermaid", source: "flowchart TD\n  x" } }, render);
    expect(a.ok).toBe(false);
    expect(a.draft.chapters[0].diagram?.source).toBe(FLOW);
  });

  test("the tool dispatcher passes a chapter diagram, and null on update removes it", async () => {
    let d = await twoChapters();
    d = ok(await runGuideBuilderTool(d, "guide_add_chapter", { title: "P", overview: "o", diagram: { kind: "mermaid", source: FLOW } }, hooks));
    expect(d.chapters[2].diagram?.kind).toBe("mermaid");
    expect((await runGuideBuilderTool(d, "guide_add_chapter", { title: "P", overview: "o", diagram: { kind: "svg", source: "x" } }, hooks)).text).toContain("`diagram.kind` is `mermaid` or `html`.");
    expect((await runGuideBuilderTool(d, "guide_update_chapter", { chapter: "c3", diagram: { kind: "mermaid", source: FLOW, alt: "y" } }, hooks)).text).toContain("`diagram` takes only `kind` and `source`");
    d = ok(await runGuideBuilderTool(d, "guide_update_chapter", { chapter: "c3", diagram: null }, hooks));
    expect(d.chapters[2].diagram).toBeUndefined();
    const overview = await runGuideBuilderTool(d, "guide_set_overview", { text: "x", diagram: { kind: "mermaid", source: FLOW } }, hooks);
    expect(overview.draft.overview?.diagram?.source).toBe(FLOW);
    expect((await runGuideBuilderTool(d, "guide_set_overview", {})).text).toContain("It takes: text.");
  });

  test("guide_read shows a chapter's diagram under its overview", async () => {
    let d = await twoChapters();
    d = ok(await guideUpdateChapter(d, { chapter: "c1", diagram: { kind: "mermaid", source: "flowchart LR\n  a --> b" } }, hooks));
    const a = await guideRead(d);
    expect(a.text).toContain("1. c1 · Retry budget\n   The delivery loop asks for a budget before it sends.\n   Diagram (mermaid):\n     flowchart LR\n       a --> b\n");
    expect(a.text).not.toContain("2. c2 · Tests\n   One new test for the backoff.\n   Diagram");
  });

  test("moving or removing chapters names the chapter: links of a chapter diagram it re-points", async () => {
    let d = await twoChapters();
    d = ok(await guideAddChapter(d, { title: "Glue", overview: "Wiring.", diagram: { kind: "mermaid", source: 'flowchart LR\n  a --> b\n  click b "chapter:2"' } }, hooks));
    const moved = await guideMoveChapter(d, { chapter: "c2", position: 1 }, hooks);
    expect(moved.text).toContain('`chapter:2` in the diagram of c3 now points at c1 "Retry budget" (was c2 "Tests").');
    const removed = await guideRemoveChapter(d, { chapter: "c2" }, hooks);
    expect(removed.text).toContain('`chapter:2` in the diagram of c3 now points at c3 "Glue" (was c2 "Tests").');
  });

  test("finish refuses a chapter diagram linking past the last chapter; save as is drops that link", async () => {
    let d = await completeDraft();
    d = ok(await guideUpdateChapter(d, { chapter: "c2", diagram: { kind: "mermaid", source: 'flowchart LR\n  a --> b\n  click a "chapter:1"\n  click b "chapter:3"' } }, hooks));
    const a = await guideFinish(d, hooks);
    expect(a.ok).toBe(false);
    expect(a.text).toContain("The diagram of chapter 2 (c2) links to `chapter:3`, but the guide has 2 chapters.");
    const saved = await guideSaveAsIs(d, hooks);
    expect(saved.ok).toBe(true);
    expect(saved.snapshot!.guide.sections[1].diagram?.source).toBe('flowchart LR\n  a --> b\n  click a "chapter:1"');
  });

  test("a chapter diagram makes the snapshot version 5, carried on its section", async () => {
    let d = await completeDraft();
    d = ok(await guideUpdateChapter(d, { chapter: "c2", diagram: { kind: "mermaid", source: FLOW } }, hooks));
    const out = guideDraftToOutput(d);
    expect(out.sections[1].diagram).toEqual({ kind: "mermaid", source: FLOW });
    expect("diagram" in out.sections[0]).toBe(false);
    const a = await guideFinish(d, hooks);
    expect(a.ok).toBe(true);
    const s = a.snapshot!;
    expect(s.version).toBe(5);
    expect(s.guide.sections[1].diagram).toEqual({ kind: "mermaid", source: FLOW });
    expect("diagram" in s.guide.sections[0]).toBe(false);
    expect(parseGuideSnapshot(JSON.parse(JSON.stringify(s))).ok).toBe(true);
  });

  test("drafts keep a chapter diagram through JSON; a malformed one is refused", async () => {
    let d = await completeDraft();
    d = ok(await guideUpdateChapter(d, { chapter: "c1", diagram: { kind: "mermaid", source: FLOW } }, hooks));
    const parsed = parseGuideDraft(serializeGuideDraft(d));
    expect(parsed.ok && parsed.draft.chapters[0].diagram).toEqual({ kind: "mermaid", source: FLOW });
    const raw = JSON.parse(serializeGuideDraft(d));
    raw.chapters[0].diagram = { kind: "svg", source: "x" };
    expect(parseGuideDraft(raw)).toEqual({ ok: false, error: "The diagram of chapter c1 is malformed." });
  });

  test("an older draft with an overview diagram still parses and finishes with it", async () => {
    const raw = JSON.parse(serializeGuideDraft(await completeDraft()));
    raw.overview = { text: "How it fits.", diagram: { kind: "mermaid", source: "flowchart LR\n  a --> b" } };
    const parsed = parseGuideDraft(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const a = await guideFinish(parsed.draft, hooks);
    expect(a.ok).toBe(true);
    expect(a.snapshot!.version).toBe(2);
    expect(a.snapshot!.guide.overview?.diagram).toEqual({ kind: "mermaid", source: "flowchart LR\n  a --> b" });
  });
});

import { describe, expect, it, setSystemTime } from "bun:test";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { ReaderModel } from "./reader-model";
import { buildFinishedGuide, guideStorePaths, loadSavedGuide, readSidecar, saveFinishedGuide, setChapterReviewed, snapshotOfGuide, writeSidecar } from "./store";

const patch = [
  "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,3 @@", " x", "+y", " z",
  "@@ -10,1 +11,2 @@", " p", "+q",
  "diff --git a/b.ts b/b.ts", "new file mode 100644", "--- /dev/null", "+++ b/b.ts", "@@ -0,0 +1,1 @@", "+b",
  "diff --git a/c.ts b/c.ts", "--- a/c.ts", "+++ b/c.ts", "@@ -1 +1 @@", "-c", "+C",
  "diff --git a/gen.lock b/gen.lock", "--- a/gen.lock", "+++ b/gen.lock", "@@ -1 +1 @@", "-1", "+2", "",
].join("\n");

function saved(repoKey: string) {
  const snapshot = buildGuideSnapshot({
    guide: {
      title: "T",
      intent: "I",
      overview: { text: "See [b](code:b.ts#L1)." },
      sections: [
        { title: "One", overview: "o1", diffs: [{ file: "a.ts", summary: "A" }, { file: "b.ts", summary: "B" }] },
        { title: "Two", overview: "o2", diffs: [{ file: "c.ts" }] },
      ],
      unplacedFiles: ["gen.lock"],
    },
    reviewed: [],
    review: { rawPatch: patch, gitRef: "main..working tree", source: { kind: "local", headSha: "h" } },
  });
  const id = saveFinishedGuide({
    repoKey,
    snapshot,
    source: { kind: "local", repoRoot: "/r", headRoot: "/r", repoName: "r", label: "Local changes", headSha: "h", baseSha: "b", baseLabel: "main" },
    agent: { id: "claude-code", label: "Claude Code" },
    focus: { "a.ts": [{ hunk: 2 }, { start: 1, end: 2 }] },
  });
  return loadSavedGuide(repoKey, id)!;
}

describe("reader model and store", () => {
  it("round-trips a guide: overview, chapters, patch and sidecar", () => {
    const g = saved("test__reader-1");
    expect((g.envelope.guide as { overview?: { text: string } }).overview?.text).toBe("See [b](code:b.ts#L1).");
    expect(g.rawPatch).toBe(patch);
    expect(g.sidecar.source?.baseSha).toBe("b");
    const m = new ReaderModel(g);
    expect(m.chapters.map((c) => c.files.map((f) => f.path))).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
    expect(m.unplaced).toEqual(["gen.lock"]);
    expect(m.overview?.text).toContain("code:b.ts");
    expect(m.files.get("a.ts")?.hunks).toEqual([{ start: 1, end: 3 }, { start: 11, end: 12 }]);
    expect(m.focusRanges("a.ts")).toEqual([{ start: 11, end: 12 }, { start: 1, end: 2 }]);
  });

  it("ticks a chapter when all its files are ticked, and unticks it when one is unticked", () => {
    const m = new ReaderModel(saved("test__reader-2"));
    expect(m.setFileReviewed("a.ts", true)).toEqual([]);
    expect(m.reviewed).toEqual([false, false]);
    expect(m.setFileReviewed("b.ts", true)).toEqual([0]);
    expect(m.reviewed).toEqual([true, false]);
    expect(m.setFileReviewed("a.ts", false)).toEqual([0]);
    expect(m.reviewed).toEqual([false, false]);
    m.setChapterReviewed(1, true);
    expect(m.fileTicks.has("c.ts")).toBe(true);
    expect(m.filesReviewedCount()).toBe(2);
  });

  it("steps through files in reading order", () => {
    const m = new ReaderModel(saved("test__reader-3"));
    expect(m.nextFile(null)).toEqual({ chapter: 0, path: "a.ts" });
    expect(m.nextFile("b.ts")).toEqual({ chapter: 1, path: "c.ts" });
    expect(m.nextFile("c.ts")).toBeNull();
    m.setFileReviewed("a.ts", true);
    expect(m.nextUnreviewedFile("c.ts")).toEqual({ chapter: 0, path: "b.ts" });
  });

  it("persists ticks where the web app reads them (reviewed[]) and file ticks in the sidecar", () => {
    const g = saved("test__reader-4");
    setChapterReviewed(g.repoKey, g.id, [true, false]);
    writeSidecar(g.repoKey, g.id, { ...g.sidecar, fileTicks: ["a.ts", "b.ts"] });
    const again = loadSavedGuide(g.repoKey, g.id)!;
    expect(again.envelope.reviewed).toEqual([true, false]);
    expect(readSidecar(g.repoKey, g.id).fileTicks).toEqual(["a.ts", "b.ts"]);
    expect(new ReaderModel(again).fileTicks.has("b.ts")).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSavedGuideSnapshot, saveGuide, saveGuidePatch } from "@plannotator/shared/guide-store";
import { createGuideHtml, parseGuideSnapshot, resolveGuideViewerAssets } from "@plannotator/core/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/core/guide-viewer-manifest";
import { resolveReaderSides } from "./reader-model";
import { defaultRunner } from "./sources/runner";

describe("guides cross between the web app and VS Code", () => {
  it("a guide made in VS Code exports like any saved guide (plannotator guide export's path)", () => {
    const g = saved("test__export-1");
    const snapshot = buildSavedGuideSnapshot(g.repoKey, g.envelope)!;
    expect(parseGuideSnapshot(snapshot).ok).toBe(true);
    expect(snapshot.guide.overview?.text).toBe("See [b](code:b.ts#L1).");
    const html = createGuideHtml(snapshot, { viewer: resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST) });
    expect(html).toContain("plannotator-guided-review");
  });

  it("exports a guide kept in memory (guide history off) exactly as the same guide saved", () => {
    const g = saved("test__export-mem");
    // Each snapshot is stamped with `exportedAt: now`: freeze the clock so the two compare equal.
    setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    let fromDisk;
    try {
      fromDisk = buildSavedGuideSnapshot(g.repoKey, g.envelope)!;
      expect(snapshotOfGuide(g)).toEqual(fromDisk);
    } finally {
      setSystemTime();
    }
    const memory = buildFinishedGuide({ repoKey: "test__never-written", snapshot: fromDisk, source: g.sidecar.source!, agent: { id: "claude-code", label: "Claude Code" }, focus: {} });
    expect(guideStorePaths("test__never-written").exists).toBe(false);
    expect(parseGuideSnapshot(snapshotOfGuide(memory)!).ok).toBe(true);
  });

  it("a guide made in the web app (no VS Code sidecar) opens: base at the merge base, head in the working tree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pn-web-guide-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "x\nz\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "feat");
    writeFileSync(join(repo, "a.ts"), "x\ny\nz\n");
    git("commit", "-qam", "change");
    const head = git("rev-parse", "HEAD");
    const repoKey = "test__web-1";
    const rawPatch = git("diff", base, head);
    saveGuidePatch(repoKey, "1-web", rawPatch);
    saveGuide(repoKey, "1-web", {
      version: 1, savedAt: 1, label: "feat", title: "Web guide", engine: "claude", headSha: head,
      review: { gitRef: "main..HEAD", diffType: "since-base", base: "main", source: { kind: "local", headSha: head }, patchFile: "1-web.patch" },
      guide: { title: "Web guide", intent: "i", sections: [{ title: "s", overview: "o", diffs: [{ file: "a.ts" }] }] },
      reviewed: [false],
    });
    const loaded = loadSavedGuide(repoKey, "1-web")!;
    expect(loaded.sidecar.source).toBeUndefined();
    const sides = await resolveReaderSides(defaultRunner, loaded, { repoRoot: repo, storageDir: tmpdir() });
    expect(sides).toEqual({ gitRoot: repo, baseRev: base, head: { kind: "fs", root: repo }, moved: false });
    expect(new ReaderModel(loaded).chapters[0].files[0].path).toBe("a.ts");
  });
});

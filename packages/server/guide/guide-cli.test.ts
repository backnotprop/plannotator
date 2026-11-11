import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuideStoreSession, loadGuide, saveGuide, saveGuidePatch, type SavedGuideEnvelope } from "@plannotator/shared/guide-store";
import { decompress } from "@plannotator/shared/compress";
import { decrypt } from "@plannotator/shared/crypto";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshot, parseGuideSnapshotJson } from "@plannotator/shared/guide-format";
import { FIXTURE_V1_LOCAL, FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import { parseGuideShareTtl, runGuideCli } from "./guide-cli";

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const envelope = (overrides: Partial<SavedGuideEnvelope> = {}): SavedGuideEnvelope => ({
  version: 1,
  savedAt: 1000,
  label: "feature/x",
  title: "CLI guide",
  guide: { title: "CLI guide", intent: "i", sections: [{ title: "S", overview: "o", diffs: [{ file: "a.ts" }] }] },
  reviewed: [false],
  ...overrides,
});

let dataDir = "";
let workDir = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-cli-data-"));
  workDir = mkdtempSync(join(tmpdir(), "plannotator-guide-cli-work-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const embeddedSnapshot = (html: string) => {
  const m = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  const parsed = parseGuideSnapshotJson(m![1]);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("plannotator guide", () => {
  test("usage errors exit 2 and print usage", async () => {
    expect((await runGuideCli([])).code).toBe(2);
    expect((await runGuideCli(["export"])).code).toBe(2);
    expect((await runGuideCli(["export", "--id", "x", "--snapshot", "y"])).code).toBe(2);
    expect((await runGuideCli(["export", "--id"])).stderr).toContain("--id requires a value");
    expect((await runGuideCli(["list", "--bogus"])).code).toBe(2);
    expect((await runGuideCli(["nope"])).stderr).toContain("Usage:");
  });

  test("list shows every shelf and whether a guide is exportable", async () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: "1000-exportable.patch" } }));
    saveGuide("shelf-b", "2000-legacy", envelope({ title: "Legacy", savedAt: 2000 }));
    const res = await runGuideCli(["list"]);
    expect(res.code).toBe(0);
    const lines = res.stdout!.split("\n");
    expect(lines[1]).toContain("2000-legacy");
    expect(lines[1]).toContain("no ");
    expect(lines[2]).toContain("1000-exportable");
    expect(lines[2]).toContain("yes");
    rmSync(dataDir, { recursive: true, force: true });
    expect((await runGuideCli(["list"])).stdout).toBe("No saved guides.\n");
  });

  test("export --id writes the portable HTML next to cwd by default and pins the viewer", async () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ engine: "claude", review: { gitRef: "origin/main..HEAD", diffType: "since-base", source: { kind: "local", repo: "acme/x" }, patchFile: "1000-exportable.patch" } }));
    const res = await runGuideCli(["export", "--id", "1000-exportable"], {}, workDir);
    expect(res.code).toBe(0);
    const out = join(workDir, "guided-review-cli-guide.html");
    expect(res.stdout).toBe(`${out}\n`);
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf-8");
    expect(html).toMatch(/src="https:\/\/guides\.show\/v1\/viewer\.[A-Za-z0-9_-]+\.js" integrity="sha384-/);
    const snap = embeddedSnapshot(html);
    expect(snap.review.rawPatch).toBe(PATCH);
    expect(snap.generator?.engine).toBe("claude");
    expect(snap.source).toEqual({ kind: "local", repo: "acme/x" });
  });

  test("export --id honours --out, --out - (stdout) and a viewer URL override", async () => {
    saveGuidePatch("shelf-a", "1000-exportable", PATCH);
    saveGuide("shelf-a", "1000-exportable", envelope({ review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: "1000-exportable.patch" } }));
    const toStdout = await runGuideCli(["export", "--id", "1000-exportable", "--out", "-", "--viewer-url", "http://localhost:8787/v1/"], {}, workDir);
    expect(toStdout.code).toBe(0);
    expect(toStdout.stdout).toContain('src="http://localhost:8787/v1/viewer.');
    const env = { PLANNOTATOR_GUIDE_VIEWER_URL: "https://cdn.example.test/guides/" } as NodeJS.ProcessEnv;
    const toFile = await runGuideCli(["export", "--id", "1000-exportable", "--out", "sub/out.html"], env, workDir);
    expect(toFile.code).toBe(1);
    expect(toFile.stderr).toContain("Could not write");
    const ok = await runGuideCli(["export", "--id", "1000-exportable", "--out", "out.html"], env, workDir);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(workDir, "out.html"), "utf-8")).toContain('src="https://cdn.example.test/guides/viewer.');
    const bad = await runGuideCli(["export", "--id", "1000-exportable", "--out", "-", "--viewer-url", "javascript:alert(1)"], {}, workDir);
    expect(bad.stdout).toContain('src="https://guides.show/v1/viewer.');
  });

  test("export --id reports not-found and not-exportable distinctly (exit 1)", async () => {
    saveGuide("shelf-b", "2000-legacy", envelope({ title: "Legacy" }));
    const missing = await runGuideCli(["export", "--id", "3000-none"], {}, workDir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No saved guide");
    const legacy = await runGuideCli(["export", "--id", "2000-legacy"], {}, workDir);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain("not retained");
  });

  test("export --snapshot wraps an authored snapshot document, and rejects an invalid one", async () => {
    const file = join(workDir, "snap.json");
    writeFileSync(file, JSON.stringify(FIXTURE_V1_PR));
    const res = await runGuideCli(["export", "--snapshot", "snap.json", "--out", "-"], {}, workDir);
    expect(res.code).toBe(0);
    expect(embeddedSnapshot(res.stdout!).source.pr?.number).toBe(42);
    writeFileSync(file, JSON.stringify({ ...FIXTURE_V1_PR, extra: 1 }));
    const bad = await runGuideCli(["export", "--snapshot", "snap.json"], {}, workDir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid guide snapshot ($)");
    expect((await runGuideCli(["export", "--snapshot", "missing.json"], {}, workDir)).code).toBe(1);
  });

  const TWO_FILE_PATCH =
    "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n" +
    "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{ }\n";
  const AUTHORED = {
    title: "Token refresh",
    intent: "Refresh tokens before they expire.",
    sections: [{ title: "The guard", overview: "Where the refresh happens.", diffs: [{ file: "src/auth.ts", summary: "Adds the refresh guard." }] }],
    review: { gitRef: "origin/main...HEAD", base: "origin/main" },
    generator: { engine: "claude-code", model: "claude-opus-5" },
  };

  test("export --guide/--patch validates the guide against the patch, infers provenance from git, and wraps it", async () => {
    execFileSync("git", ["init", "-q", "-b", "feature/refresh"], { cwd: workDir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: workDir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: workDir });
    writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
    writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
    const res = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { now: "2026-08-15T00:00:00.000Z" });
    expect(res.code).toBe(0);
    const out = join(workDir, "guided-review-token-refresh.html");
    expect(res.stdout).toBe(`${out}\n`);
    const snap = embeddedSnapshot(readFileSync(out, "utf-8"));
    expect(snap.review).toEqual({ rawPatch: TWO_FILE_PATCH, gitRef: "origin/main...HEAD", base: "origin/main" });
    expect(snap.source.kind).toBe("local");
    expect(snap.source.repo).toBe("acme/widgets");
    expect(snap.source.branch).toBe("feature/refresh");
    expect(snap.source.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.generator).toEqual({ engine: "claude-code", model: "claude-opus-5", generatedAt: "2026-08-15T00:00:00.000Z" });
    expect(snap.guide.unplacedFiles).toEqual(["package.json"]);
    expect(snap.guide.sections[0].diffs[0]).toEqual({ file: "src/auth.ts", summary: "Adds the refresh guard." });
  });

  test("export --guide reads the patch from stdin with --patch -, and a caller-supplied source wins over inference", async () => {
    writeFileSync(join(workDir, "guide.json"), JSON.stringify({ ...AUTHORED, source: { kind: "pr", repo: "acme/widgets", pr: { url: "https://github.com/acme/widgets/pull/7", number: 7, title: "Refresh", platform: "github" } } }));
    const res = await runGuideCli(["export", "--guide", "guide.json", "--patch", "-", "--out", "-"], {}, workDir, { stdin: () => TWO_FILE_PATCH });
    expect(res.code).toBe(0);
    const snap = embeddedSnapshot(res.stdout!);
    expect(snap.source.kind).toBe("pr");
    expect(snap.source.pr?.number).toBe(7);
  });

  test("export --guide keeps a chapter's Mermaid diagram (format version 5) and refuses any other kind", async () => {
    writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
    const diagram = { kind: "mermaid", source: "flowchart LR\n  a --> b" };
    writeFileSync(join(workDir, "guide.json"), JSON.stringify({ ...AUTHORED, sections: [{ ...AUTHORED.sections[0], diagram }] }));
    const res = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch", "--out", "-"], {}, workDir);
    expect(res.code).toBe(0);
    const snap = embeddedSnapshot(res.stdout!);
    expect(snap.version).toBe(5);
    expect(snap.guide.sections[0].diagram).toEqual(diagram);
    writeFileSync(join(workDir, "guide.json"), JSON.stringify({ ...AUTHORED, sections: [{ ...AUTHORED.sections[0], diagram: { kind: "html", source: "<b>x</b>" } }] }));
    const html = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir);
    expect(html.code).toBe(1);
    expect(html.stderr).toContain("sections[0].diagram");
  });

  test("export --guide fails with actionable errors: unknown files (listing the patch's files), duplicates, bad shape, empty patch, usage", async () => {
    writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
    const write = (g: unknown) => writeFileSync(join(workDir, "guide.json"), JSON.stringify(g));

    write({ ...AUTHORED, sections: [{ title: "S", overview: "o", diffs: [{ file: "src/nope.ts", summary: "?" }] }] });
    const unknown = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not in the patch: src/nope.ts");
    expect(unknown.stderr).toContain("src/auth.ts");
    expect(unknown.stderr).toContain("package.json");

    write({ ...AUTHORED, sections: [...AUTHORED.sections, { title: "Again", overview: "dup", diffs: [{ file: "src/auth.ts", summary: "again" }] }] });
    const dup = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("placed twice");

    write({ intent: "no title", sections: [] });
    const shape = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir);
    expect(shape.code).toBe(1);
    expect(shape.stderr).toContain("`title`");
    expect(shape.stderr).toContain("`sections`");

    write({ ...AUTHORED, source: { kind: "spaceship" } });
    const badSource = await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir);
    expect(badSource.code).toBe(1);
    expect(badSource.stderr).toContain("$.source.kind");

    write(AUTHORED);
    writeFileSync(join(workDir, "empty.patch"), "");
    expect((await runGuideCli(["export", "--guide", "guide.json", "--patch", "empty.patch"], {}, workDir)).stderr).toContain("no file diffs");
    expect((await runGuideCli(["export", "--guide", "guide.json"], {}, workDir)).code).toBe(2);
    expect((await runGuideCli(["export", "--guide", "guide.json", "--patch", "guide.patch", "--id", "x"], {}, workDir)).code).toBe(2);
    expect((await runGuideCli(["export", "--guide", "missing.json", "--patch", "guide.patch"], {}, workDir)).code).toBe(1);
  });

  // What regresses: an imported guide lands on a shelf the review session
  // never reads, so it silently never shows up under Guides.
  describe("import", () => {
    const session = (
      pr: { url: string; headSha: string; label: string } | null = null,
      dirs: { gitCwd?: string; fallbackDir?: string } = { gitCwd: workDir },
    ) =>
      createGuideStoreSession({
        runGit: async (args, cwd) => {
          try {
            return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
          } catch {
            return null;
          }
        },
        getGitCwd: () => (pr ? undefined : dirs.gitCwd),
        getPRInfo: () => pr,
        getBranchLabel: () => undefined,
        getFallbackDir: () => dirs.fallbackDir ?? workDir,
        writesEnabled: () => true,
      });
    const initRepo = (remote?: string) => {
      execFileSync("git", ["init", "-q", "-b", "feature/refresh"], { cwd: workDir });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: workDir });
      if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: workDir });
    };
    const guideFiles = () => (existsSync(join(dataDir, "guides")) ? (readdirSync(join(dataDir, "guides"), { recursive: true }) as string[]).sort() : []);

    test("import --guide/--patch is listed by a review of the same repository, and exports like a generated guide", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);

      const res = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { now: "2026-08-15T00:00:00.000Z" });
      expect(res.code).toBe(0);
      const id = res.stdout!.trim();

      const rows = await session().listSaved();
      expect(rows.map((r) => ({ id: r.id, label: r.label, title: r.title, moved: r.moved }))).toEqual([
        { id, label: "feature/refresh", title: "Token refresh", moved: false },
      ]);
      const exported = await runGuideCli(["export", "--id", id, "--out", "-"], {}, workDir);
      expect(embeddedSnapshot(exported.stdout!).review.rawPatch).toBe(TWO_FILE_PATCH);
    });

    test("import --pr is shelved with that PR's repository and labelled with the PR", async () => {
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const url = "https://github.com/acme/widgets/pull/7";
      const res = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", url], {}, workDir);
      expect(res.code).toBe(0);

      const rows = await session({ url, headSha: "", label: "PR #7" }).listSaved();
      expect(rows.map((r) => r.label)).toEqual(["PR #7"]);
      expect(loadGuide("github.com__acme__widgets", res.stdout!.trim())?.prUrl).toBe(url);
    });

    test("import refuses --id (exit 2), an unknown PR URL and an invalid guide (exit 1), and saves nothing", async () => {
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      expect((await runGuideCli(["import", "--id", "x"], {}, workDir)).code).toBe(2);
      const badPr = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", "https://example.com/x"], {}, workDir);
      expect(badPr.code).toBe(1);
      expect(badPr.stderr).toContain("https://example.com/x");
      writeFileSync(join(workDir, "bad.json"), JSON.stringify({ ...AUTHORED, sections: [{ title: "S", overview: "o", diffs: [{ file: "src/nope.ts", summary: "" }] }] }));
      const badGuide = await runGuideCli(["import", "--guide", "bad.json", "--patch", "guide.patch"], {}, workDir);
      expect(badGuide.code).toBe(1);
      expect(badGuide.stderr).toContain("These files are not in the patch: src/nope.ts");
      writeFileSync(join(workDir, "snap.json"), JSON.stringify({ ...FIXTURE_V1_PR, extra: 1 }));
      expect((await runGuideCli(["import", "--snapshot", "snap.json"], {}, workDir)).code).toBe(1);
      writeFileSync(join(workDir, "snap.json"), JSON.stringify({ ...FIXTURE_V1_PR, source: { ...FIXTURE_V1_PR.source, pr: { ...FIXTURE_V1_PR.source.pr!, url: "https://example.com/x" } } }));
      expect((await runGuideCli(["import", "--snapshot", "snap.json"], {}, workDir)).code).toBe(1);
      expect(existsSync(join(dataDir, "guides"))).toBe(false);
    });

    test("import --patch - reads the diff from stdin", async () => {
      initRepo("https://github.com/acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      const res = await runGuideCli(["import", "--guide", "guide.json", "--patch", "-"], {}, workDir, { stdin: () => TWO_FILE_PATCH });
      expect(res.code).toBe(0);
      expect((await session().listSaved()).map((r) => r.id)).toEqual([res.stdout!.trim()]);
      expect(readFileSync(join(dataDir, "guides", "github.com__acme__widgets", `${res.stdout!.trim()}.patch`), "utf-8")).toBe(TWO_FILE_PATCH);
    });

    test("import --snapshot takes the snapshot's own PR for the shelf and label", async () => {
      writeFileSync(join(workDir, "snap.json"), JSON.stringify(FIXTURE_V1_PR));
      const res = await runGuideCli(["import", "--snapshot", "snap.json"], {}, workDir);
      expect(res.code).toBe(0);
      const pr = FIXTURE_V1_PR.source.pr!;
      const rows = await session({ url: pr.url, headSha: "", label: `PR #${pr.number}` }).listSaved();
      expect(rows.map((r) => ({ id: r.id, label: r.label }))).toEqual([{ id: res.stdout!.trim(), label: `PR #${pr.number}` }]);
    });

    // What regresses: the CLI keys a repository without an origin remote
    // differently from the session (cwd vs top-level), so the guide vanishes.
    test("without a remote, a review lists a guide imported from a subdirectory, and from outside git", async () => {
      initRepo();
      mkdirSync(join(workDir, "src", "deep"), { recursive: true });
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const fromSub = await runGuideCli(["import", "--guide", "../../guide.json", "--patch", "../../guide.patch"], {}, join(workDir, "src", "deep"));
      expect(fromSub.code).toBe(0);
      expect((await session().listSaved()).map((r) => r.id)).toEqual([fromSub.stdout!.trim()]);

      const plain = mkdtempSync(join(tmpdir(), "plannotator-guide-cli-plain-"));
      try {
        writeFileSync(join(plain, "guide.json"), JSON.stringify(AUTHORED));
        writeFileSync(join(plain, "guide.patch"), TWO_FILE_PATCH);
        const outside = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, plain);
        expect(outside.code).toBe(0);
        expect((await session(null, { fallbackDir: plain }).listSaved()).map((r) => r.id)).toEqual([outside.stdout!.trim()]);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    // What regresses: a second import (or a generated guide saved the same
    // millisecond) with the same title silently replaces the first.
    test("import never replaces a saved guide with the same id", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const now = "2026-08-15T00:00:00.000Z";
      const takenId = `${Date.parse(now)}-token-refresh`;
      saveGuidePatch("github.com__acme__widgets", takenId, PATCH);
      saveGuide("github.com__acme__widgets", takenId, envelope({ title: "Token refresh", review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: `${takenId}.patch` } }));
      const before = readFileSync(join(dataDir, "guides", "github.com__acme__widgets", `${takenId}.json`), "utf-8");

      const first = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { now });
      const second = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { now });
      expect([first.code, second.code]).toEqual([0, 0]);
      const ids = [first.stdout!.trim(), second.stdout!.trim()];
      expect(new Set([takenId, ...ids]).size).toBe(3);
      expect(readFileSync(join(dataDir, "guides", "github.com__acme__widgets", `${takenId}.json`), "utf-8")).toBe(before);
      expect(readFileSync(join(dataDir, "guides", "github.com__acme__widgets", `${takenId}.patch`), "utf-8")).toBe(PATCH);
      expect((await session().listSaved()).map((r) => r.id).sort()).toEqual([takenId, ...ids].sort());
    });

    test("a failed envelope write leaves no patch behind", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const now = "2026-08-15T00:00:00.000Z";
      const shelf = join(dataDir, "guides", "github.com__acme__widgets");
      // A directory where the envelope's temp file goes makes that one write fail.
      mkdirSync(join(shelf, `${Date.parse(now)}-token-refresh.json.tmp`), { recursive: true });
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { now });
        expect(res.code).toBe(1);
        expect(res.stderr).toContain("Could not save the guide");
        expect(res.stderr).toContain("EISDIR");
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
      expect(guideFiles()).toEqual(["github.com__acme__widgets", `github.com__acme__widgets/${Date.parse(now)}-token-refresh.json.tmp`]);
    });

    // What regresses: an authored guide imported with --pr keeps the local
    // HEAD, so the PR's review shows it as moved (stale) at once, and its
    // export and share links carry a local-branch header instead of the PR.
    test("import --pr of an authored guide describes the PR: not moved in the PR review, PR header in export and share", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const url = "https://github.com/acme/widgets/pull/7";
      const res = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", url], {}, workDir);
      expect(res.code).toBe(0);
      const id = res.stdout!.trim();

      const rows = await session({ url, headSha: "f".repeat(40), label: "PR #7" }).listSaved();
      expect(rows.map((r) => ({ id: r.id, label: r.label, moved: r.moved }))).toEqual([{ id, label: "PR #7", moved: false }]);

      const expectedSource = { kind: "pr", repo: "acme/widgets", pr: { url, number: 7, platform: "github" } };
      const exported = embeddedSnapshot((await runGuideCli(["export", "--id", id, "--out", "-"], {}, workDir)).stdout!);
      expect(exported.source).toEqual(expectedSource);

      let body: { data: string } | undefined;
      const host = (async (_input: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ id: "PrShare0123456789abcd", url: "https://guides.show/g/PrShare0123456789abcd", deleteToken: "tok" }, { status: 201 });
      }) as unknown as typeof fetch;
      const shared = await runGuideCli(["share", "--id", id], {}, workDir, { fetch: host });
      expect(shared.code).toBe(0);
      const key = new URLSearchParams(new URL(shared.stdout!.trim()).hash.slice(1)).get("key")!;
      const uploaded = parseGuideSnapshot(await decompress(await decrypt(body!.data, key)));
      expect(uploaded.ok && uploaded.value.source).toEqual(expectedSource);
    });

    test("import --pr of a snapshot without a PR stores no head, so the PR review does not show it as moved", async () => {
      writeFileSync(join(workDir, "snap.json"), JSON.stringify(FIXTURE_V1_LOCAL));
      const url = "https://github.com/acme/demo/pull/3";
      const res = await runGuideCli(["import", "--snapshot", "snap.json", "--pr", url], {}, workDir);
      expect(res.code).toBe(0);
      expect(loadGuide("github.com__acme__demo", res.stdout!.trim())?.headSha).toBeUndefined();
      expect((await session({ url, headSha: "f".repeat(40), label: "PR #3" }).listSaved()).map((r) => r.moved)).toEqual([false]);
    });

    // What regresses: a www. or /files variant of the PR URL lands on a shelf
    // the review (keyed by the platform's canonical URL) never reads.
    test("import --pr keys a www. or /files PR URL like the canonical one, and warns on a case-only mismatch with origin", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const canonical = "https://github.com/acme/widgets/pull/7";
      const variant = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", "https://WWW.GitHub.com/acme/widgets/pull/7/files?w=1"], {}, workDir);
      expect(variant.code).toBe(0);
      expect(variant.stderr).not.toContain("Warning");
      expect(loadGuide("github.com__acme__widgets", variant.stdout!.trim())?.prUrl).toBe(canonical);
      expect((await session({ url: canonical, headSha: "", label: "PR #7" }).listSaved()).map((r) => r.id)).toEqual([variant.stdout!.trim()]);

      const cased = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", "https://github.com/Acme/Widgets/pull/7"], {}, workDir);
      expect(cased.code).toBe(0);
      expect(cased.stderr).toContain("Warning: the PR URL spells the repository differently from origin (github.com__Acme__Widgets vs github.com__acme__widgets)");
      expect(loadGuide("github.com__Acme__Widgets", cased.stdout!.trim())).not.toBeNull();
    });

    test("import refuses a --pr that names a different PR from the guide's own source.pr, and saves nothing", async () => {
      writeFileSync(join(workDir, "snap.json"), JSON.stringify(FIXTURE_V1_PR));
      const other = "https://github.com/acme/widgets/pull/999";
      const fromSnapshot = await runGuideCli(["import", "--snapshot", "snap.json", "--pr", other], {}, workDir);
      expect(fromSnapshot.code).toBe(1);
      expect(fromSnapshot.stderr).toBe(`--pr ${other} is not the PR the guide names (source.pr.url ${FIXTURE_V1_PR.source.pr!.url}). Drop --pr, or fix source.pr in the guide.\n`);

      writeFileSync(join(workDir, "guide.json"), JSON.stringify({ ...AUTHORED, source: { pr: { url: "https://github.com/acme/widgets/pull/7" } } }));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const fromGuide = await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch", "--pr", other], {}, workDir);
      expect(fromGuide.code).toBe(1);
      expect(fromGuide.stderr).toContain("is not the PR the guide names");
      expect(existsSync(join(dataDir, "guides"))).toBe(false);

      const same = await runGuideCli(["import", "--snapshot", "snap.json", "--pr", FIXTURE_V1_PR.source.pr!.url.replace("https://", "https://www.")], {}, workDir);
      expect(same.code).toBe(0);
    });

    test("share --id works on an imported guide and records the link on it", async () => {
      initRepo("git@github.com:acme/widgets.git");
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const id = (await runGuideCli(["import", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir)).stdout!.trim();
      const host = (async () => Response.json({ id: "ImportedShare0123456789", url: "https://guides.show/g/ImportedShare0123456789", deleteToken: "tok" }, { status: 201 })) as unknown as typeof fetch;
      const shared = await runGuideCli(["share", "--id", id, "--public"], {}, workDir, { fetch: host });
      expect(shared.code).toBe(0);
      expect(loadGuide("github.com__acme__widgets", id)?.share?.id).toBe("ImportedShare0123456789");
    });
  });

  describe("share / unshare", () => {
    interface Call { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }
    const fakeService = (respond?: (call: Call) => Response) => {
      const calls: Call[] = [];
      const doFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const call: Call = { url: String(input), method: init?.method ?? "GET", headers, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) };
        calls.push(call);
        if (respond) return respond(call);
        if (call.method === "POST") return Response.json({ id: "SharedId0123456789abcd", url: "https://guides.show/g/SharedId0123456789abcd", deleteToken: "del-tok" }, { status: 201 });
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      return { calls, fetch: doFetch };
    };
    const seedExportable = () => {
      saveGuidePatch("shelf-a", "1000-exportable", PATCH);
      saveGuide("shelf-a", "1000-exportable", envelope({ review: { gitRef: "HEAD", source: { kind: "local" }, patchFile: "1000-exportable.patch" } }));
    };

    test("--ttl accepts seconds and s/m/h/d suffixes, rejects everything else", () => {
      expect(parseGuideShareTtl("3600")).toBe(3600);
      expect(parseGuideShareTtl("30m")).toBe(1800);
      expect(parseGuideShareTtl("24h")).toBe(86_400);
      expect(parseGuideShareTtl("7d")).toBe(604_800);
      expect(parseGuideShareTtl(" 90s ")).toBe(90);
      for (const bad of ["0", "-5", "1.5h", "7w", "abc", "", "1e3"]) expect(parseGuideShareTtl(bad)).toBeNull();
    });

    test("share --id uploads encrypted by default, prints the URL with its key, the delete hint on stderr, and records the link on the envelope", async () => {
      seedExportable();
      const svc = fakeService();
      const res = await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: svc.fetch, now: "2026-08-15T00:00:00.000Z" });
      expect(res.code).toBe(0);
      expect(svc.calls.length).toBe(1);
      expect(svc.calls[0].url).toBe("https://guides.show/api/g");
      const body = svc.calls[0].body as { mode: string; data: string; viewer: unknown; ttlSeconds?: number };
      expect(body.mode).toBe("encrypted");
      expect(body.ttlSeconds).toBeUndefined();
      expect(body.viewer).toEqual(GUIDE_VIEWER_MANIFEST as unknown);
      const url = res.stdout!.trim();
      expect(url.startsWith("https://guides.show/g/SharedId0123456789abcd#key=")).toBe(true);
      const key = new URLSearchParams(new URL(url).hash.slice(1)).get("key")!;
      const restored = parseGuideSnapshot(await decompress(await decrypt(body.data, key)));
      expect(restored.ok).toBe(true);
      if (restored.ok) expect(restored.value.review.rawPatch).toBe(PATCH);
      expect(res.stderr).toContain("plannotator guide unshare SharedId0123456789abcd --token del-tok");
      expect(res.stderr).toContain("encrypted");
      expect(loadGuide("shelf-a", "1000-exportable")!.share).toEqual({
        id: "SharedId0123456789abcd",
        url,
        createdAt: "2026-08-15T00:00:00.000Z",
        deleteToken: "del-tok",
        serviceUrl: "https://guides.show",
      });
    });

    test("share --id refuses (exit 1, no upload) while the saved guide already has a link, and says how to remove it", async () => {
      seedExportable();
      const svc = fakeService();
      expect((await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: svc.fetch })).code).toBe(0);
      const again = await runGuideCli(["share", "--id", "1000-exportable", "--public"], {}, workDir, { fetch: svc.fetch });
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("already has a share link");
      expect(again.stderr).toContain("plannotator guide unshare SharedId0123456789abcd --token del-tok");
      expect(svc.calls.length).toBe(1);
      expect(loadGuide("shelf-a", "1000-exportable")!.share?.deleteToken).toBe("del-tok");
    });

    test("unshare removes a remembered link from the host it was created on, not the configured one", async () => {
      seedExportable();
      const svc = fakeService((call) => call.method === "POST"
        ? Response.json({ id: "SelfId", url: "https://self.example/g/SelfId", deleteToken: "t-self" }, { status: 201 })
        : new Response(null, { status: 204 }));
      expect((await runGuideCli(["share", "--id", "1000-exportable"], { PLANNOTATOR_GUIDE_SHARE_URL: "https://self.example" }, workDir, { fetch: svc.fetch })).code).toBe(0);
      expect(loadGuide("shelf-a", "1000-exportable")!.share?.serviceUrl).toBe("https://self.example");
      const res = await runGuideCli(["unshare", "SelfId", "--token", "t-self"], { PLANNOTATOR_GUIDE_SHARE_URL: "https://guides.show" }, workDir, { fetch: svc.fetch });
      expect(res.code).toBe(0);
      expect(svc.calls[1].url).toBe("https://self.example/api/g/SelfId");
      expect(loadGuide("shelf-a", "1000-exportable")!.share).toBeUndefined();
      const configured = fakeService();
      await runGuideCli(["unshare", "SelfId", "--token", "t-self"], { PLANNOTATOR_GUIDE_SHARE_URL: "https://other.example" }, workDir, { fetch: configured.fetch });
      expect(configured.calls[0].url).toBe("https://other.example/api/g/SelfId");
    });

    test("share --public --ttl --json: plain upload with ttlSeconds to the configured host, JSON record on stdout", async () => {
      const file = join(workDir, "snap.json");
      writeFileSync(file, JSON.stringify(FIXTURE_V1_PR));
      const svc = fakeService(() => Response.json({ id: "PubId", url: "http://localhost:8788/g/PubId", deleteToken: "t2", expiresAt: "2026-08-22T00:00:00.000Z" }, { status: 201 }));
      const res = await runGuideCli(["share", "--snapshot", "snap.json", "--public", "--ttl", "7d", "--json"], { PLANNOTATOR_GUIDE_SHARE_URL: "http://localhost:8788/" }, workDir, { fetch: svc.fetch });
      expect(res.code).toBe(0);
      expect(svc.calls[0].url).toBe("http://localhost:8788/api/g");
      const body = svc.calls[0].body as { mode: string; data: string; ttlSeconds?: number };
      expect(body.mode).toBe("plain");
      expect(body.ttlSeconds).toBe(604_800);
      expect(JSON.parse(body.data)).toEqual(FIXTURE_V1_PR);
      expect(JSON.parse(res.stdout!)).toEqual({ id: "PubId", url: "http://localhost:8788/g/PubId", deleteToken: "t2", expiresAt: "2026-08-22T00:00:00.000Z" });
      expect(res.stderr).toContain("expires 2026-08-22T00:00:00.000Z");
      const viaEnv = fakeService();
      await runGuideCli(["share", "--snapshot", "snap.json"], { PLANNOTATOR_GUIDE_SHARE_URL: "https://guides.example.test/sub/" }, workDir, { fetch: viaEnv.fetch });
      expect(viaEnv.calls[0].url).toBe("https://guides.example.test/sub/api/g");
    });

    test("share --guide/--patch works without a saved guide and records nothing", async () => {
      writeFileSync(join(workDir, "guide.json"), JSON.stringify(AUTHORED));
      writeFileSync(join(workDir, "guide.patch"), TWO_FILE_PATCH);
      const svc = fakeService();
      const res = await runGuideCli(["share", "--guide", "guide.json", "--patch", "guide.patch"], {}, workDir, { fetch: svc.fetch, now: "2026-08-15T00:00:00.000Z" });
      expect(res.code).toBe(0);
      expect(svc.calls.length).toBe(1);
      expect(res.stdout).toContain("#key=");
    });

    test("share refuses (exit 1, no upload) when sharing is disabled by env or config", async () => {
      seedExportable();
      const svc = fakeService();
      const viaEnv = await runGuideCli(["share", "--id", "1000-exportable"], { PLANNOTATOR_SHARE: "disabled" }, workDir, { fetch: svc.fetch });
      expect(viaEnv.code).toBe(1);
      expect(viaEnv.stderr).toContain("Sharing is disabled");
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ share: "disabled" }));
      const viaConfig = await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: svc.fetch });
      expect(viaConfig.code).toBe(1);
      expect(svc.calls.length).toBe(0);
      const reenabled = await runGuideCli(["share", "--id", "1000-exportable"], { PLANNOTATOR_SHARE: "enabled" }, workDir, { fetch: svc.fetch });
      expect(reenabled.code).toBe(0);
      expect(svc.calls.length).toBe(1);
    });

    test("share exit codes: usage 2 (bad ttl, unknown arg, no source), 1 for missing guide and service errors", async () => {
      seedExportable();
      const svc = fakeService(() => Response.json({ error: "too large", maxBytes: 25 * 1024 * 1024 }, { status: 413 }));
      expect((await runGuideCli(["share", "--id", "1000-exportable", "--ttl", "soon"], {}, workDir, { fetch: svc.fetch })).code).toBe(2);
      expect((await runGuideCli(["share", "--id", "1000-exportable", "--bogus"], {}, workDir, { fetch: svc.fetch })).code).toBe(2);
      expect((await runGuideCli(["share"], {}, workDir, { fetch: svc.fetch })).code).toBe(2);
      expect(svc.calls.length).toBe(0);
      const missing = await runGuideCli(["share", "--id", "9999-none"], {}, workDir, { fetch: svc.fetch });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("No saved guide");
      const tooLarge = await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: svc.fetch });
      expect(tooLarge.code).toBe(1);
      expect(tooLarge.stderr).toContain("too large");
      expect(loadGuide("shelf-a", "1000-exportable")!.share).toBeUndefined();
      const down = await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
      expect(down.code).toBe(1);
      expect(down.stderr).toContain("unreachable");
    });

    test("unshare DELETEs with the token, prints Removed, and forgets the link on the saved envelope", async () => {
      seedExportable();
      const svc = fakeService();
      await runGuideCli(["share", "--id", "1000-exportable"], {}, workDir, { fetch: svc.fetch });
      expect(loadGuide("shelf-a", "1000-exportable")!.share?.id).toBe("SharedId0123456789abcd");
      const res = await runGuideCli(["unshare", "SharedId0123456789abcd", "--token", "del-tok"], {}, workDir, { fetch: svc.fetch });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe("Removed\n");
      const del = svc.calls[1];
      expect(del.method).toBe("DELETE");
      expect(del.url).toBe("https://guides.show/api/g/SharedId0123456789abcd");
      expect(del.headers.authorization).toBe("Bearer del-tok");
      expect(loadGuide("shelf-a", "1000-exportable")!.share).toBeUndefined();
    });

    test("unshare exit codes: usage 2 without id or token, 1 when the host says 404 or 401", async () => {
      expect((await runGuideCli(["unshare"], {}, workDir)).code).toBe(2);
      expect((await runGuideCli(["unshare", "abc"], {}, workDir)).code).toBe(2);
      expect((await runGuideCli(["unshare", "abc", "--token", "t", "extra"], {}, workDir)).code).toBe(2);
      const gone = await runGuideCli(["unshare", "abc", "--token", "t"], {}, workDir, { fetch: fakeService(() => Response.json({ error: "not found" }, { status: 404 })).fetch });
      expect(gone.code).toBe(1);
      expect(gone.stderr).toContain("already removed or expired");
      const denied = await runGuideCli(["unshare", "abc", "--token", "t"], {}, workDir, { fetch: fakeService(() => new Response(null, { status: 401 })).fetch });
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain("token");
    });
  });
});

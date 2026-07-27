import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGuideOutput } from "./guide";
import {
  createGuideStoreSession,
  deleteGuide,
  deriveGuideRepoKeyFallback,
  deriveGuideRepoKeyFromPRUrl,
  deriveGuideRepoKeyFromRemote,
  isValidGuideId,
  listGuides,
  loadGuide,
  makeGuideId,
  saveGuide,
  updateGuideReviewed,
  type SavedGuideEnvelope,
} from "./guide-store";

const REPO_KEY = "github.com__acme__widgets";

const GUIDE: CodeGuideOutput = {
  title: "Add payment localization",
  intent: "Localizes checkout for three new markets.",
  sections: [
    { title: "Locale module", overview: "The core change.", diffs: [{ file: "src/locale.ts" }] },
    { title: "Wiring", overview: "Glue.", diffs: [{ file: "src/index.ts" }] },
  ],
};

function envelope(overrides: Partial<SavedGuideEnvelope> = {}): SavedGuideEnvelope {
  return {
    version: 1,
    savedAt: 1000,
    label: "feature/locales",
    title: GUIDE.title,
    engine: "claude",
    headSha: "abc1234",
    guide: GUIDE,
    reviewed: [false, false],
    ...overrides,
  };
}

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-store-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("repo key derivation", () => {
  test("SSH, HTTPS, and ssh:// remotes land on the same host__owner__repo key", () => {
    const expected = "github.com__acme__widgets";
    expect(deriveGuideRepoKeyFromRemote("git@github.com:acme/widgets.git")).toBe(expected);
    expect(deriveGuideRepoKeyFromRemote("https://github.com/acme/widgets.git")).toBe(expected);
    expect(deriveGuideRepoKeyFromRemote("https://github.com/acme/widgets")).toBe(expected);
    expect(deriveGuideRepoKeyFromRemote("ssh://git@github.com:22/acme/widgets.git")).toBe(expected);
  });

  test("GitLab subgroup paths keep every segment", () => {
    expect(deriveGuideRepoKeyFromRemote("git@gitlab.com:group/sub/proj.git")).toBe(
      "gitlab.com__group__sub__proj",
    );
  });

  test("PR urls land on the same key as the matching origin remote", () => {
    expect(deriveGuideRepoKeyFromPRUrl("https://github.com/acme/widgets/pull/12")).toBe(
      deriveGuideRepoKeyFromRemote("git@github.com:acme/widgets.git"),
    );
    expect(deriveGuideRepoKeyFromPRUrl("https://gitlab.com/group/sub/proj/-/merge_requests/3")).toBe(
      deriveGuideRepoKeyFromRemote("git@gitlab.com:group/sub/proj.git"),
    );
  });

  test("unparseable remotes return null", () => {
    expect(deriveGuideRepoKeyFromRemote("")).toBeNull();
    expect(deriveGuideRepoKeyFromRemote("not a url")).toBeNull();
    expect(deriveGuideRepoKeyFromPRUrl("https://example.com/not-a-pr")).toBeNull();
  });

  test("no-remote fallback is dir name + path hash, stable per path, distinct across paths", () => {
    const a = deriveGuideRepoKeyFallback("/tmp/projects/widgets");
    const b = deriveGuideRepoKeyFallback("/tmp/elsewhere/widgets");
    expect(a).toMatch(/^widgets-[0-9a-f]{8}$/);
    expect(a).toBe(deriveGuideRepoKeyFallback("/tmp/projects/widgets"));
    expect(a).not.toBe(b);
  });
});

describe("guide ids", () => {
  test("makeGuideId is timestamp + title slug", () => {
    expect(makeGuideId("Add payment localization", 1234)).toBe("1234-add-payment-localization");
    expect(makeGuideId("###", 1234)).toBe("1234-guide");
  });

  test("isValidGuideId rejects traversal and separator characters", () => {
    expect(isValidGuideId("1234-add-payment")).toBe(true);
    expect(isValidGuideId("../escape")).toBe(false);
    expect(isValidGuideId("a/b")).toBe(false);
    expect(isValidGuideId("a\\b")).toBe(false);
    expect(isValidGuideId(".hidden")).toBe(false);
    expect(isValidGuideId("")).toBe(false);
  });
});

describe("save / load / list / delete", () => {
  test("round-trips an envelope", () => {
    expect(saveGuide(REPO_KEY, "1000-test", envelope())).toBe(true);
    const loaded = loadGuide(REPO_KEY, "1000-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe(GUIDE.title);
    expect(loaded!.guide.sections.length).toBe(2);
    expect(loaded!.reviewed).toEqual([false, false]);
  });

  test("atomic write leaves no .tmp file behind", () => {
    saveGuide(REPO_KEY, "1000-test", envelope());
    const files = readdirSync(join(dataDir, "guides", REPO_KEY));
    expect(files).toEqual(["1000-test.json"]);
  });

  test("atomic replace: updateGuideReviewed rewrites the whole file consistently", () => {
    saveGuide(REPO_KEY, "1000-test", envelope());
    expect(updateGuideReviewed(REPO_KEY, "1000-test", [true, false])).toBe(true);
    const loaded = loadGuide(REPO_KEY, "1000-test");
    expect(loaded!.reviewed).toEqual([true, false]);
    // Untouched fields survive the rewrite.
    expect(loaded!.headSha).toBe("abc1234");
    expect(loaded!.label).toBe("feature/locales");
    // Still exactly one file on disk — no stray tmp artifacts.
    expect(readdirSync(join(dataDir, "guides", REPO_KEY))).toEqual(["1000-test.json"]);
  });

  test("reviewed arrays are clamped to the section count", () => {
    saveGuide(REPO_KEY, "1000-test", envelope());
    updateGuideReviewed(REPO_KEY, "1000-test", [true, true, true, true]);
    expect(loadGuide(REPO_KEY, "1000-test")!.reviewed).toEqual([true, true]);
  });

  test("corrupt or invalid files load as no saved guide and are skipped by list", () => {
    const dir = join(dataDir, "guides", REPO_KEY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-corrupt.json"), "{ not json", "utf-8");
    writeFileSync(join(dir, "2-wrong-version.json"), JSON.stringify({ version: 2, guide: GUIDE }), "utf-8");
    writeFileSync(join(dir, "3-no-sections.json"), JSON.stringify(envelope({ guide: { ...GUIDE, sections: [] } })), "utf-8");
    saveGuide(REPO_KEY, "4-good", envelope());

    expect(loadGuide(REPO_KEY, "1-corrupt")).toBeNull();
    expect(loadGuide(REPO_KEY, "2-wrong-version")).toBeNull();
    expect(loadGuide(REPO_KEY, "3-no-sections")).toBeNull();
    expect(listGuides(REPO_KEY).map((g) => g.id)).toEqual(["4-good"]);
  });

  test("list sorts newest first and delete removes exactly one guide", () => {
    saveGuide(REPO_KEY, "1-old", envelope({ savedAt: 1 }));
    saveGuide(REPO_KEY, "2-new", envelope({ savedAt: 2 }));
    expect(listGuides(REPO_KEY).map((g) => g.id)).toEqual(["2-new", "1-old"]);

    expect(deleteGuide(REPO_KEY, "2-new")).toBe(true);
    expect(deleteGuide(REPO_KEY, "2-new")).toBe(false); // already gone
    expect(listGuides(REPO_KEY).map((g) => g.id)).toEqual(["1-old"]);
  });

  test("guides are scoped per repo key", () => {
    saveGuide("github.com__acme__widgets", "1-a", envelope());
    saveGuide("github.com__acme__gadgets", "1-b", envelope());
    expect(listGuides("github.com__acme__widgets").map((g) => g.id)).toEqual(["1-a"]);
    expect(listGuides("github.com__acme__gadgets").map((g) => g.id)).toEqual(["1-b"]);
  });

  test("invalid ids are rejected without touching the disk", () => {
    expect(saveGuide(REPO_KEY, "../escape", envelope())).toBe(false);
    expect(loadGuide(REPO_KEY, "../escape")).toBeNull();
    expect(deleteGuide(REPO_KEY, "../escape")).toBe(false);
  });
});

describe("createGuideStoreSession", () => {
  const branchSession = (overrides: Partial<Parameters<typeof createGuideStoreSession>[0]> = {}) =>
    createGuideStoreSession({
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:acme/widgets.git\n";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc1234\n";
        return null;
      },
      getGitCwd: () => "/repo",
      getPRInfo: () => null,
      getBranchLabel: () => "feature/locales",
      getFallbackDir: () => "/repo",
      writesEnabled: () => true,
      ...overrides,
    });

  test("saveForJob persists under the remote-derived repo key and lists back", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1", engine: "claude", model: "sonnet" }, { ...GUIDE, reviewed: [] });

    expect(session.isJobSaved("job-1")).toBe(true);
    const entries = listGuides(REPO_KEY);
    expect(entries.length).toBe(1);
    expect(entries[0].envelope.label).toBe("feature/locales");
    expect(entries[0].envelope.headSha).toBe("abc1234");
    expect(entries[0].envelope.engine).toBe("claude");

    const listed = await session.listSaved();
    expect(listed.length).toBe(1);
    expect(listed[0].progress).toEqual({ reviewed: 0, total: 2 });
    expect(listed[0].moved).toBe(false); // head still matches
  });

  test("moved flags a guide whose stored head differs from the current head", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });

    let head = "abc1234";
    const later = branchSession({
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:acme/widgets.git\n";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
        return null;
      },
    });
    expect((await later.listSaved())[0].moved).toBe(false);

    head = "def4567";
    const moved = branchSession({
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:acme/widgets.git\n";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
        return null;
      },
    });
    const rows = await moved.listSaved();
    expect(rows[0].moved).toBe(true);
    const data = await moved.getSavedGuideData(rows[0].id);
    expect(data!.moved).toBe(true);
    expect(data!.saved).toBe(true);
  });

  test("reviewed write-through updates a live job's saved file", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });
    await session.writeThroughReviewed("job-1", [true, false]);

    const rows = await session.listSaved();
    expect(rows[0].progress).toEqual({ reviewed: 1, total: 2 });

    // A fresh session (server restart) still sees the persisted state.
    const restarted = branchSession();
    const restartedRows = await restarted.listSaved();
    expect(restartedRows[0].progress).toEqual({ reviewed: 1, total: 2 });
  });

  test("updateSavedReviewed persists and getSavedGuideData reflects it", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });
    const [row] = await session.listSaved();
    expect(await session.updateSavedReviewed(row.id, [true, true])).toBe(true);
    expect((await session.getSavedGuideData(row.id))!.reviewed).toEqual([true, true]);
    expect(await session.updateSavedReviewed("missing-id", [true])).toBe(false);
  });

  test("opt-out blocks autosave writes while reads keep working", async () => {
    // Seed a guide while enabled.
    const enabled = branchSession();
    await enabled.saveForJob({ id: "job-1" }, { ...GUIDE });

    const disabled = branchSession({ writesEnabled: () => false });
    await disabled.saveForJob({ id: "job-2" }, { ...GUIDE, title: "Should not persist" });

    expect(disabled.isJobSaved("job-2")).toBe(false);
    const rows = await disabled.listSaved();
    expect(rows.length).toBe(1); // only the pre-existing guide
    expect(rows[0].title).toBe(GUIDE.title);
    expect((await disabled.getSavedGuideData(rows[0].id))!.title).toBe(GUIDE.title);
  });

  test("PR mode derives the key from the PR url and stamps prUrl + PR head", async () => {
    const session = createGuideStoreSession({
      getGitCwd: () => undefined,
      getPRInfo: () => ({ url: "https://github.com/acme/widgets/pull/7", headSha: "pr-head-1", label: "PR #7" }),
      getBranchLabel: () => undefined,
      getFallbackDir: () => "/unused",
      writesEnabled: () => true,
    });
    await session.saveForJob({ id: "job-1", engine: "codex" }, { ...GUIDE });

    // Same shelf as the branch-mode key for the matching origin remote.
    const entries = listGuides(REPO_KEY);
    expect(entries.length).toBe(1);
    expect(entries[0].envelope.prUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(entries[0].envelope.headSha).toBe("pr-head-1");
    expect(entries[0].envelope.label).toBe("PR #7");
  });

  test("no-remote session falls back to the fallback-dir key", async () => {
    const session = createGuideStoreSession({
      runGit: async () => null, // no origin, not a repo
      getGitCwd: () => "/some/where",
      getPRInfo: () => null,
      getBranchLabel: () => undefined,
      getFallbackDir: () => "/some/where",
      writesEnabled: () => true,
    });
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });

    const key = deriveGuideRepoKeyFallback("/some/where");
    expect(listGuides(key).length).toBe(1);
    // Label falls back to "local" when no branch is known.
    expect(listGuides(key)[0].envelope.label).toBe("local");
  });

  test("a job launched under PR A completing after a switch to PR B keeps A's label, url, headSha, and shelf", async () => {
    // Mutable live state: what the session getters return at any moment —
    // exactly what the servers wire in. The launch snapshot is captured while
    // PR A is active; the "user" then switches to PR B before the multi-minute
    // job completes and saveForJob runs against the live-getters-say-B state.
    let livePR: { url: string; headSha: string; label: string } | null = {
      url: "https://github.com/acme/widgets/pull/1",
      headSha: "aaaaaaa1",
      label: "PR #1",
    };
    const session = createGuideStoreSession({
      getGitCwd: () => undefined,
      getPRInfo: () => livePR,
      getBranchLabel: () => undefined,
      getFallbackDir: () => "/unused",
      writesEnabled: () => true,
    });

    const launchContext = await session.captureLaunchContext();
    expect(launchContext.pr?.url).toBe("https://github.com/acme/widgets/pull/1");

    // Simulate /api/pr-switch to a DIFFERENT PR (different repo, even) while
    // the job runs.
    livePR = { url: "https://github.com/other/gadgets/pull/9", headSha: "bbbbbbb2", label: "PR #9" };

    await session.saveForJob({ id: "job-1", engine: "claude" }, { ...GUIDE }, launchContext);

    // The envelope is labeled with PR A — the context the guide was GENERATED
    // against — and filed under A's repository shelf, not B's.
    const entries = listGuides(REPO_KEY);
    expect(entries.length).toBe(1);
    expect(entries[0].envelope.label).toBe("PR #1");
    expect(entries[0].envelope.prUrl).toBe("https://github.com/acme/widgets/pull/1");
    expect(entries[0].envelope.headSha).toBe("aaaaaaa1");
    expect(listGuides("github.com__other__gadgets")).toEqual([]);

    // Reviewed write-through follows the launch-time shelf too, even though
    // the live session is still pointed at PR B.
    await session.writeThroughReviewed("job-1", [true, false]);
    expect(listGuides(REPO_KEY)[0].envelope.reviewed).toEqual([true, false]);
  });

  test("branch-mode launch context survives a mid-run branch/head change", async () => {
    let head = "abc1234";
    let branch = "feature/locales";
    const session = branchSession({
      runGit: async (args) => {
        if (args[0] === "remote") return "git@github.com:acme/widgets.git\n";
        if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
        return null;
      },
      getBranchLabel: () => branch,
    });

    const launchContext = await session.captureLaunchContext();
    head = "def4567";
    branch = "hotfix/other";

    await session.saveForJob({ id: "job-1" }, { ...GUIDE }, launchContext);
    const [entry] = listGuides(REPO_KEY);
    expect(entry.envelope.label).toBe("feature/locales");
    expect(entry.envelope.headSha).toBe("abc1234");
    // The moved flag now reflects that the branch has advanced past the
    // launch-time head the guide was generated on.
    expect((await session.listSaved())[0].moved).toBe(true);
  });

  test("saveForJob without a launch snapshot falls back to the live getters", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });
    const [entry] = listGuides(REPO_KEY);
    expect(entry.envelope.label).toBe("feature/locales");
    expect(entry.envelope.headSha).toBe("abc1234");
  });

  test("saving twice for the same job overwrites the same file", async () => {
    const session = branchSession();
    await session.saveForJob({ id: "job-1" }, { ...GUIDE });
    await session.saveForJob({ id: "job-1" }, { ...GUIDE, intent: "Updated intent" });

    const entries = listGuides(REPO_KEY);
    expect(entries.length).toBe(1);
    expect(entries[0].envelope.guide.intent).toBe("Updated intent");
  });
});

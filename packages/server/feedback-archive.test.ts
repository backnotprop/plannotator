/**
 * Durable feedback archive — server wiring (Bun runtime).
 *
 * Regressions guarded here:
 *  - "review feedback lost": /api/feedback used to delete the draft, settle the
 *    decision promise, and persist nothing, so a submission made after the
 *    invoking agent timed out existed nowhere (the pre-#678 failure mode,
 *    recurring on code review).
 *  - "archive failure loses the review": a failed archive write must keep the
 *    draft as the recovery copy and must never fail the reviewer's submit.
 *  - "opt-out ignored": PLANNOTATOR_FEEDBACK_HISTORY / feedbackHistory must
 *    stop every write.
 *  - "stateless annotate broken": PLANNOTATOR_ANNOTATE_HISTORY=0 must still
 *    mean "annotate sessions write nothing to the data dir".
 *  - "plan record cannot be joined to its plan": the record names a history
 *    version file instead of copying the plan text, so that path must resolve.
 *  - dismissals are recorded as decision-only lines.
 *
 * Every test sandboxes the archive under a temp PLANNOTATOR_DATA_DIR set
 * inside the test body. Plan version history is written by storage.ts, which
 * captures its data dir at import time, so the one plan test uses a unique
 * heading (unique slug) and removes only that slug directory afterwards.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";
import { startAnnotateServer } from "./annotate";
import { getPlanVersionPath } from "./storage";
import { detectProjectName } from "./project";
import { parseFeedbackIndex, type FeedbackRecord } from "@plannotator/shared/feedback-archive";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

// Annotate version history goes through storage.ts, whose data dir is fixed at
// import time, so these sessions snapshot into the REAL data dir no matter what
// PLANNOTATOR_DATA_DIR says here. Distinctive, test-owned project names keep
// that out of any real project's bucket and let afterAll remove it whole.
const FILE_ANNOTATE_PROJECT = "_feedback_archive_test_file";
const STATELESS_ANNOTATE_PROJECT = "_feedback_archive_test_stateless";
const URL_ANNOTATE_PROJECT = "_feedback_archive_test_url";

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_FEEDBACK_HISTORY",
  "PLANNOTATOR_ANNOTATE_HISTORY",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
] as const;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Point the archive (and drafts) at a fresh temp data dir for this test. */
function useTempDataDir(): string {
  const dir = makeTempDir("plannotator-feedback-wiring-");
  process.env.PLANNOTATOR_DATA_DIR = dir;
  return dir;
}

function feedbackDir(dataDir: string): string {
  return join(dataDir, "feedback");
}

/** The archive holds exactly one project dir per test; read its index. */
function readOnlyIndex(dataDir: string): FeedbackRecord[] {
  const projects = readdirSync(feedbackDir(dataDir));
  expect(projects.length).toBe(1);
  const indexPath = join(feedbackDir(dataDir), projects[0], "index.jsonl");
  return parseFeedbackIndex(readFileSync(indexPath, "utf-8"));
}

/** The single project bucket the archive created in this test. */
function archivedProject(dataDir: string): string {
  const projects = readdirSync(feedbackDir(dataDir));
  expect(projects.length).toBe(1);
  return projects[0];
}

function sidecarBody(dataDir: string, record: FeedbackRecord): string {
  const projects = readdirSync(feedbackDir(dataDir));
  return readFileSync(join(feedbackDir(dataDir), projects[0], record.recordFile!), "utf-8");
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  // A real ~/.plannotator/config.json must never decide these tests.
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
  process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  // Remove the annotate history these tests deposited in the real data dir.
  // Runs with the env already restored, so this resolves the same directory
  // storage.ts wrote to.
  const historyDir = join(getPlannotatorDataDir(), "history");
  for (const project of [FILE_ANNOTATE_PROJECT, STATELESS_ANNOTATE_PROJECT, URL_ANNOTATE_PROJECT]) {
    rmSync(join(historyDir, project), { recursive: true, force: true });
  }
});

describe("code review submissions are archived", () => {
  async function startReview(options: Parameters<typeof startReviewServer>[0] extends infer T ? Partial<T> : never = {}) {
    return startReviewServer({
      rawPatch: "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n",
      gitRef: "HEAD",
      htmlContent: MINIMAL_HTML,
      origin: "claude-code",
      ...options,
    } as Parameters<typeof startReviewServer>[0]);
  }

  test("feedback submit appends one parseable record with a sidecar, then deletes the draft", async () => {
    const dataDir = useTempDataDir();
    const server = await startReview();
    try {
      // The draft is the reviewer's other copy before submit.
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approved: false,
          feedback: "## Review\n\nparse() still drops the null case.",
          annotations: [
            { id: "a1", type: "comment", text: "null case", filePath: "src/parse.ts", lineStart: 1, lineEnd: 1, side: "new" },
          ],
        }),
      });
      expect(response.status).toBe(200);

      const records = readOnlyIndex(dataDir);
      expect(records.length).toBe(1);
      expect(records[0].surface).toBe("review");
      expect(records[0].decision).toBe("feedback");
      expect(records[0].origin).toBe("claude-code");
      expect(records[0].feedback).toContain("parse() still drops the null case.");
      expect(records[0].annotations?.[0].file).toBe("src/parse.ts");
      // Diff identity travels with the record; the patch bytes do not.
      expect(records[0].target?.review?.gitRef).toBe("HEAD");
      expect(records[0].target?.review?.changedFiles).toBe(1);
      expect(sidecarBody(dataDir, records[0])).toContain("parse() still drops the null case.");

      // The record exists, so the draft may go.
      expect((await fetch(`${server.url}/api/draft`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("a bare approval is recorded as an lgtm decision-only line", async () => {
    const dataDir = useTempDataDir();
    const server = await startReview();
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, feedback: "", annotations: [] }),
      });
      expect(response.status).toBe(200);
      const records = readOnlyIndex(dataDir);
      expect(records.length).toBe(1);
      expect(records[0].decision).toBe("lgtm");
      expect(records[0].recordFile).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("closing a review without feedback records a dismissal", async () => {
    const dataDir = useTempDataDir();
    const server = await startReview();
    try {
      expect((await fetch(`${server.url}/api/exit`, { method: "POST" })).status).toBe(200);
      const records = readOnlyIndex(dataDir);
      expect(records.length).toBe(1);
      expect(records[0].decision).toBe("dismissed");
      expect(records[0].recordFile).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("a PR-mode session buckets under the project, not the pool checkout", async () => {
    // Regression: PR mode never sets gitContext, and `--local` points agentCwd
    // at <sessionDir>/pool/pr-<n>, so deriving the project from the cwd filed
    // every PR review under `pr-123`. The caller's detected project wins.
    const dataDir = useTempDataDir();
    const poolCwd = join(makeTempDir("plannotator-feedback-pool-"), "pool", "pr-123");
    mkdirSync(poolCwd, { recursive: true });
    const server = await startReview({ project: "plannotator", agentCwd: poolCwd });
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Rebase before merging.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(archivedProject(dataDir)).toBe("plannotator");
      // The pool path is still recorded as provenance on the record itself.
      expect(readOnlyIndex(dataDir)[0].target?.review?.cwd).toBe(poolCwd);
    } finally {
      server.stop();
    }
  });

  test("changedFiles counts a rename once", async () => {
    // Regression: extractChangedFiles unions the a/ and b/ sides (it exists to
    // resolve any path a reader mentions), so reusing it here reported a
    // two-file review for a one-file rename.
    const dataDir = useTempDataDir();
    const server = await startReview({
      rawPatch:
        "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 92%\nrename from src/old.ts\nrename to src/new.ts\n",
    });
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Rename looks right.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(readOnlyIndex(dataDir)[0].target?.review?.changedFiles).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("a malformed feedback body degrades to legacy behavior, never a 500", async () => {
    // /api/feedback does not type-validate its body; the archive hook must not
    // turn a junk value into a 500 the reviewer cannot recover from.
    const dataDir = useTempDataDir();
    const server = await startReview();
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: 42, annotations: "nope" }),
      });
      expect(response.status).toBe(200);
      const records = readOnlyIndex(dataDir);
      expect(records.length).toBe(1);
      expect(records[0].feedback).toBeUndefined();
      expect(records[0].counts.annotations).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a failed archive write keeps the draft and still answers the reviewer with 200", async () => {
    const dataDir = useTempDataDir();
    // The review project is derived from the review cwd; block exactly that
    // archive directory by planting a FILE where the directory must go.
    const repoDir = join(makeTempDir("plannotator-feedback-repo-"), "widgets");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(feedbackDir(dataDir), { recursive: true });
    writeFileSync(join(feedbackDir(dataDir), "widgets"), "blocked", "utf-8");

    const server = await startReview({ agentCwd: repoDir });
    try {
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Do not lose this.", annotations: [{ id: "a1" }] }),
      });
      // The submit succeeds for the user...
      expect(response.status).toBe(200);
      // ...and the draft survives as the recovery copy.
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(200);
      expect(JSON.stringify(await draft.json())).toContain("a1");
    } finally {
      server.stop();
    }
  });

  test("PLANNOTATOR_FEEDBACK_HISTORY=0 writes nothing and keeps the legacy draft behavior", async () => {
    const dataDir = useTempDataDir();
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    const server = await startReview();
    try {
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "secret", annotations: [{ id: "a1" }] }),
      });
      expect(response.status).toBe(200);
      expect(existsSync(feedbackDir(dataDir))).toBe(false);
      expect((await fetch(`${server.url}/api/draft`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("{ feedbackHistory: false } in config.json writes nothing", async () => {
    const dataDir = useTempDataDir();
    delete process.env.PLANNOTATOR_FEEDBACK_HISTORY; // config must decide
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ feedbackHistory: false }), "utf-8");
    const server = await startReview();
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "secret", annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(existsSync(feedbackDir(dataDir))).toBe(false);
    } finally {
      server.stop();
    }
  });
});

describe("annotate submissions are archived", () => {
  test("a URL session — which writes no history — still records the submission", async () => {
    // Behavior change by design: URL / annotate-last / live-app / folder
    // submissions leave a durable record for the first time.
    const dataDir = useTempDataDir();
    const server = await startAnnotateServer({
      markdown: "# Fetched page\n\nBody\n",
      filePath: "https://example.com/some/page",
      htmlContent: MINIMAL_HTML,
      project: URL_ANNOTATE_PROJECT,
    });
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "The fetched page says Z.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      const records = readOnlyIndex(dataDir);
      expect(records[0].surface).toBe("annotate-url");
      expect(records[0].target?.url).toBe("https://example.com/some/page");
      // The archive stores the submission, never a copy of the fetched page.
      expect(existsSync(join(dataDir, "history"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("PLANNOTATOR_ANNOTATE_HISTORY=0 keeps annotate sessions fully stateless", async () => {
    // The documented stateless-annotate promise: the opt-out means "no
    // annotate writes to the data dir", and submitted feedback quotes the
    // annotated content, so the archive must honor it too.
    const dataDir = useTempDataDir();
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
    const dir = makeTempDir("plannotator-feedback-annotate-");
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\nBody\n", "utf-8");
    const server = await startAnnotateServer({
      markdown: "# Doc\n\nBody\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      project: STATELESS_ANNOTATE_PROJECT,
    });
    try {
      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Secret excerpt", annotations: [{ id: "a1" }] }),
      });
      expect(response.status).toBe(200);
      expect(existsSync(feedbackDir(dataDir))).toBe(false);
      expect(existsSync(join(dataDir, "history"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a single local file session records the submission and its file path", async () => {
    const dataDir = useTempDataDir();
    const dir = makeTempDir("plannotator-feedback-annotate-file-");
    const docPath = join(dir, "notes.md");
    writeFileSync(docPath, "# Notes\n\nBody\n", "utf-8");
    const server = await startAnnotateServer({
      markdown: "# Notes\n\nBody\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      project: FILE_ANNOTATE_PROJECT,
    });
    try {
      const response = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM, but rename the helper.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      const records = readOnlyIndex(dataDir);
      expect(records[0].surface).toBe("annotate");
      expect(records[0].decision).toBe("approved-with-notes");
      expect(records[0].target?.filePath).toBe(resolve(docPath));
      expect(sidecarBody(dataDir, records[0])).toContain("rename the helper");
    } finally {
      server.stop();
    }
  });
});

describe("plan decisions are archived", () => {
  const createdSlugs: Array<{ project: string; slug: string }> = [];

  afterAll(() => {
    // Plan version history is written by storage.ts, whose data dir is fixed
    // at import time — remove only the unique slug dirs these tests created.
    for (const { project, slug } of createdSlugs) {
      const versionPath = getPlanVersionPath(project, slug, 1);
      if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
    }
  });

  test("the record names the history version file the decision was made on", async () => {
    const dataDir = useTempDataDir();
    const heading = `Feedback archive plan ${Math.random().toString(36).slice(2, 10)}`;
    const plan = `# ${heading}\n\nStep one.\n`;
    const server = await startPlannotatorServer({
      plan,
      htmlContent: MINIMAL_HTML,
      origin: "claude-code",
    });
    try {
      const response = await fetch(`${server.url}/api/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // planSave off: the archive must not depend on the legacy setting.
        body: JSON.stringify({ feedback: "Split step one in two.", planSave: { enabled: false } }),
      });
      expect(response.status).toBe(200);

      const records = readOnlyIndex(dataDir);
      expect(records.length).toBe(1);
      expect(records[0].surface).toBe("plan");
      expect(records[0].decision).toBe("denied");
      expect(records[0].feedback).toContain("Split step one in two.");

      const slug = records[0].target!.slug!;
      const project = (await detectProjectName()) ?? "_unknown";
      createdSlugs.push({ project, slug });

      expect(records[0].target?.planVersion).toBe(1);
      const versionFile = records[0].target!.planVersionFile!;
      expect(versionFile).toBe(getPlanVersionPath(project, slug, 1));
      // The record is joinable to the plan text that was reviewed.
      expect(readFileSync(versionFile, "utf-8")).toContain(heading);
    } finally {
      await server.stop();
    }
  });

  test("repeat decisions on one plan append rather than overwrite", async () => {
    // The legacy plans/ snapshot keys by slug and status, so approve → deny →
    // approve keeps one file per status. The archive is a timeline.
    const dataDir = useTempDataDir();
    const heading = `Feedback archive repeat ${Math.random().toString(36).slice(2, 10)}`;
    const plan = `# ${heading}\n\nStep one.\n`;
    const first = await startPlannotatorServer({ plan, htmlContent: MINIMAL_HTML });
    try {
      await fetch(`${first.url}/api/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "no", planSave: { enabled: false } }),
      });
    } finally {
      await first.stop();
    }
    const second = await startPlannotatorServer({ plan, htmlContent: MINIMAL_HTML });
    try {
      await fetch(`${second.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSave: { enabled: false } }),
      });
    } finally {
      await second.stop();
    }

    const records = readOnlyIndex(dataDir);
    expect(records.map((r) => r.decision)).toEqual(["denied", "approved"]);
    const slug = records[0].target!.slug!;
    createdSlugs.push({ project: (await detectProjectName()) ?? "_unknown", slug });
  });
});

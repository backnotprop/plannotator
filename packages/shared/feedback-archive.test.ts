/**
 * Feedback archive module — record shape, append durability, failure policy.
 *
 * Each test names the regression it guards. The archive is the only durable
 * copy of a submitted review, so the failures worth pinning are: an append
 * that damages earlier records, a record that silently grows to the size of
 * the diff it describes, a sidecar that overwrites an earlier one, and a
 * storage failure that escapes into a request handler.
 *
 * All writes are sandboxed under a temp PLANNOTATOR_DATA_DIR set INSIDE the
 * tests (the module resolves the data dir per call precisely so this works
 * under Bun's one-process rule), and the env var is restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFeedbackRecord,
  countChangedFiles,
  deriveFeedbackProject,
  normalizeFeedbackProject,
  parseFeedbackIndex,
  type FeedbackRecord,
} from "./feedback-archive";

const PROJECT = "archive-test";

let savedDataDir: string | undefined;
const tempDirs: string[] = [];

function useTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-feedback-archive-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  return dir;
}

function projectDir(dataDir: string, project = PROJECT): string {
  return join(dataDir, "feedback", project);
}

function readIndex(dataDir: string, project = PROJECT): FeedbackRecord[] {
  return parseFeedbackIndex(readFileSync(join(projectDir(dataDir, project), "index.jsonl"), "utf-8"));
}

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("feedback archive: record shape", () => {
  test("a content record lands as one index line plus one readable sidecar", () => {
    const dataDir = useTempDataDir();
    const indexPath = appendFeedbackRecord({
      project: PROJECT,
      origin: "claude-code",
      surface: "review",
      decision: "feedback",
      target: { review: { diffType: "since-base", base: "origin/main", gitRef: "abc1234" } },
      feedback: "Please handle the null case in parse().",
      annotations: [
        { id: "a1", type: "COMMENT", text: "null case", filePath: "src/parse.ts", lineStart: 12, lineEnd: 12, side: "new" },
      ],
    });
    expect(indexPath).not.toBeNull();

    const records = readIndex(dataDir);
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record.v).toBe(1);
    expect(record.client).toBe("plannotator");
    expect(record.surface).toBe("review");
    expect(record.decision).toBe("feedback");
    expect(record.feedback).toContain("null case in parse()");
    expect(record.counts).toEqual({ annotations: 1, external: 0, images: 0 });
    expect(record.annotations?.[0]).toMatchObject({ file: "src/parse.ts", lineStart: 12, side: "new" });

    // The sidecar the index names must exist and carry the same feedback.
    expect(record.recordFile).toBeTruthy();
    const sidecar = readFileSync(join(projectDir(dataDir), record.recordFile!), "utf-8");
    expect(sidecar).toContain("Please handle the null case in parse().");
    expect(sidecar).toContain("since-base");
  });

  test("provenance is preserved so `source == null` filters the reviewer's own comments", () => {
    // Regression: external/WebMCP/agent findings are archived (the submitted
    // text already embeds them) but must stay distinguishable, or "analyze my
    // own feedback" silently counts a linter's output as the user's.
    const dataDir = useTempDataDir();
    appendFeedbackRecord({
      project: PROJECT,
      surface: "review",
      decision: "feedback",
      feedback: "mixed",
      annotations: [
        { id: "mine", type: "COMMENT", text: "rename this", author: "ramos" },
        { id: "linter", type: "COMMENT", text: "no-unused-vars", source: "eslint" },
        { id: "agent", type: "COMMENT", text: "consider a guard", source: "browser-agent" },
      ],
    });
    const record = readIndex(dataDir)[0];
    expect(record.counts).toEqual({ annotations: 3, external: 2, images: 0 });
    const own = (record.annotations ?? []).filter((a) => a.source === undefined);
    expect(own.map((a) => a.id)).toEqual(["mine"]);
  });

  test("a bare decision is a decision-only line with no sidecar", () => {
    // Approval and dismissal rates are the behavior data the archive exists
    // for; writing an empty markdown file for each would be noise.
    const dataDir = useTempDataDir();
    appendFeedbackRecord({ project: PROJECT, surface: "annotate", decision: "dismissed" });
    const record = readIndex(dataDir)[0];
    expect(record.recordFile).toBeUndefined();
    expect(record.counts.annotations).toBe(0);
    expect(existsSync(join(projectDir(dataDir), "records"))).toBe(false);
  });

  test("a review record carries diff identity and size metadata, never the patch bytes", () => {
    // Disk-growth regression: guide history stores full patches and had to be
    // flagged loudly in the docs. A feedback record must stay text-sized.
    const dataDir = useTempDataDir();
    const patch = "diff --git a/big.ts b/big.ts\n" + "+x\n".repeat(50_000);
    appendFeedbackRecord({
      project: PROJECT,
      surface: "review",
      decision: "feedback",
      target: {
        review: {
          vcsType: "git",
          diffType: "since-base",
          base: "origin/main",
          gitRef: "deadbee",
          snapshotId: "snap-1",
          changedFiles: 1,
          patchBytes: patch.length,
        },
      },
      feedback: "Too big to review in one pass.",
    });
    const raw = readFileSync(join(projectDir(dataDir), "index.jsonl"), "utf-8");
    expect(raw).not.toContain("diff --git");
    expect(raw.length).toBeLessThan(2000);
    const record = readIndex(dataDir)[0];
    expect(record.target?.review?.snapshotId).toBe("snap-1");
    expect(record.target?.review?.patchBytes).toBe(patch.length);
  });
});

describe("feedback archive: append durability", () => {
  test("successive appends never rewrite earlier lines", () => {
    // Index corruption regression: the archive is a timeline, so a second
    // decision on the same session must extend it, never replace it (the
    // legacy plans/ snapshot overwrites by slug; the archive must not).
    const dataDir = useTempDataDir();
    for (const decision of ["denied", "feedback", "approved"] as const) {
      appendFeedbackRecord({ project: PROJECT, surface: "plan", decision, feedback: `note ${decision}` });
    }
    const records = readIndex(dataDir);
    expect(records.map((r) => r.decision)).toEqual(["denied", "feedback", "approved"]);
    expect(readdirSync(join(projectDir(dataDir), "records")).length).toBe(3);
  });

  test("feedback containing newlines still serializes to exactly one line", () => {
    // A record that spanned lines would make every later append unparsable
    // for a line-oriented reader.
    const dataDir = useTempDataDir();
    appendFeedbackRecord({
      project: PROJECT,
      surface: "annotate",
      decision: "feedback",
      feedback: "## Heading\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n",
    });
    appendFeedbackRecord({ project: PROJECT, surface: "annotate", decision: "approved" });
    const raw = readFileSync(join(projectDir(dataDir), "index.jsonl"), "utf-8");
    expect(raw.trimEnd().split("\n").length).toBe(2);
    expect(readIndex(dataDir)[0].feedback).toContain("const a = 1;");
  });

  test("a torn last line is skipped, and the records before it still read", () => {
    const dataDir = useTempDataDir();
    appendFeedbackRecord({ project: PROJECT, surface: "review", decision: "lgtm" });
    const indexPath = join(projectDir(dataDir), "index.jsonl");
    writeFileSync(indexPath, readFileSync(indexPath, "utf-8") + '{"v":1,"ts":"2026', "utf-8");
    const records = parseFeedbackIndex(readFileSync(indexPath, "utf-8"));
    expect(records.length).toBe(1);
    expect(records[0].decision).toBe("lgtm");
  });

  test("sidecars written in the same millisecond never overwrite each other", () => {
    // The stamp is per-millisecond, so two fast submissions collide; losing
    // one would lose a submitted review.
    const dataDir = useTempDataDir();
    const now = new Date("2026-08-31T14:22:07.511Z");
    appendFeedbackRecord({ project: PROJECT, surface: "review", decision: "feedback", feedback: "first", now });
    appendFeedbackRecord({ project: PROJECT, surface: "review", decision: "feedback", feedback: "second", now });
    const recordsDir = join(projectDir(dataDir), "records");
    const files = readdirSync(recordsDir).sort();
    expect(files.length).toBe(2);
    const bodies = files.map((f) => readFileSync(join(recordsDir, f), "utf-8"));
    expect(bodies.some((b) => b.includes("first"))).toBe(true);
    expect(bodies.some((b) => b.includes("second"))).toBe(true);
    // Each index line names its own sidecar.
    const named = readIndex(dataDir).map((r) => r.recordFile);
    expect(new Set(named).size).toBe(2);
  });

  test("an unwritable data dir reports failure instead of throwing", () => {
    // The module is called from inside request handlers; a throw would turn a
    // reviewer's submit into a 500.
    const dir = mkdtempSync(join(tmpdir(), "plannotator-feedback-archive-fail-"));
    tempDirs.push(dir);
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf-8");
    process.env.PLANNOTATOR_DATA_DIR = join(blocker, "nested");
    expect(() =>
      expect(appendFeedbackRecord({ project: PROJECT, surface: "review", decision: "feedback", feedback: "x" })).toBeNull(),
    ).not.toThrow();
  });
});

describe("feedback archive: shared index", () => {
  test("another client's lines survive our reader, unknown fields and all", () => {
    // The index is shared: plannotator-tui appends to the same file. A reader
    // that validated `client` against an enum, rejected unknown fields, or
    // parsed sidecar filenames would silently drop every line another tool
    // wrote. Fields are added and never repurposed, so tolerance is the rule.
    const dataDir = useTempDataDir();
    appendFeedbackRecord({ project: PROJECT, surface: "review", decision: "lgtm" });
    const indexPath = join(projectDir(dataDir), "index.jsonl");
    const foreign = {
      v: 1,
      ts: "2026-09-01T09:00:00.000Z",
      client: "plannotator-tui",
      clientVersion: "0.3.1",
      project: PROJECT,
      surface: "annotate-last",
      decision: "feedback",
      target: { agent: { host: "claude-code", session: "s-1", transcript: "/t/1.jsonl" } },
      feedback: "from the terminal client",
      counts: { annotations: 0, external: 0, images: 0 },
      recordFile: "records/2026-09-01T09-00-00-000Z-annotate-last-feedback-plannotator-tui.md",
      somethingWeHaveNeverHeardOf: { nested: true },
    };
    writeFileSync(indexPath, readFileSync(indexPath, "utf-8") + JSON.stringify(foreign) + "\n", "utf-8");

    const records = readIndex(dataDir);
    expect(records.length).toBe(2);
    expect(records.map((r) => r.client)).toEqual(["plannotator", "plannotator-tui"]);
    // The suffixed sidecar name round-trips untouched: recordFile is a handle,
    // never something to parse.
    expect(records[1].recordFile).toEndWith("-plannotator-tui.md");
    expect(records[1].target?.agent?.host).toBe("claude-code");
    expect(records[1].clientVersion).toBe("0.3.1");
  });
});

describe("feedback archive: changed-file counting", () => {
  test("a rename counts once, a delete counts once, an empty patch counts zero", () => {
    // Regression: extractChangedFiles (code-nav) UNIONS the a/ and b/ sides so
    // a reader can resolve either path, which makes a one-file rename look
    // like a two-file review in the record's size metadata.
    const rename =
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 92%\nrename from src/old.ts\nrename to src/new.ts\n";
    expect(countChangedFiles(rename)).toBe(1);

    const deletion =
      "diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n";
    expect(countChangedFiles(deletion)).toBe(1);

    expect(countChangedFiles(`${rename}${deletion}`)).toBe(2);
    expect(countChangedFiles("")).toBe(0);
    expect(countChangedFiles(null)).toBe(0);
  });
});

describe("feedback archive: project bucketing", () => {
  test("the project segment matches the history/ convention and cannot escape the archive", () => {
    expect(normalizeFeedbackProject("plannotator")).toBe("plannotator");
    expect(normalizeFeedbackProject("_unknown")).toBe("_unknown");
    expect(normalizeFeedbackProject(null)).toBe("_unknown");
    expect(normalizeFeedbackProject("../../etc")).toBe("etc");
    expect(deriveFeedbackProject("/Users/x/code/plannotator")).toBe("plannotator");
    expect(deriveFeedbackProject(undefined)).toBe("_unknown");
  });
});

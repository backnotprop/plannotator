/**
 * The review-level note ("Send with additional feedback") rides the EXISTING
 * /api/feedback payload: one extra `scope: 'general'` entry in the annotations
 * array plus a `## General` section already inside the feedback markdown. That
 * is the whole reason the feature needs no server change.
 *
 * Regression guarded: a future body validator, field whitelist, or
 * CodeAnnotation schema landing on either runtime's /api/feedback handler and
 * silently dropping (or rewriting) an annotation entry it does not recognise —
 * which would deliver the reviewer's note nowhere while still reporting 200.
 * Also guarded: the archive's hasContent computation demoting a note-carrying
 * submission to a decision-only line.
 *
 * Both runtimes are exercised in one file (precedent: api-404-guard.test.ts).
 * Every server here runs under a temp PLANNOTATOR_DATA_DIR set inside the test
 * body; the archive is opted back in per test and restored afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { parseFeedbackIndex } from "@plannotator/shared/feedback-archive";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";

const NOTE_TEXT = "Rebase on main before merging; the migration should be its own PR.";
const FEEDBACK = `# Code Review Feedback\n\n## src/parse.ts\n\n- L1: still drops null\n\n## General\n\n${NOTE_TEXT}\n`;

/** Exactly what the client commits for a review-level note. */
const NOTE = {
  id: "review-note-1",
  type: "comment",
  scope: "general",
  filePath: "",
  lineStart: 0,
  lineEnd: 0,
  side: "new",
  text: NOTE_TEXT,
  createdAt: 1735689600000,
  author: "reviewer",
} as const;

const LINE_COMMENT = {
  id: "c1",
  type: "comment",
  filePath: "src/parse.ts",
  lineStart: 1,
  lineEnd: 1,
  side: "new",
  text: "still drops null",
  createdAt: 1735689500000,
} as const;

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
}

function useTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-review-note-"));
  tempDirs.push(dir);
  saveEnv("PLANNOTATOR_DATA_DIR");
  process.env.PLANNOTATOR_DATA_DIR = dir;
  return dir;
}

function enableArchive() {
  saveEnv("PLANNOTATOR_FEEDBACK_HISTORY");
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunningReview {
  url: string;
  stop(): void;
  waitForDecision(): Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
  }>;
}

const runtimes: Array<{ name: string; start: () => Promise<RunningReview> }> = [
  {
    name: "Bun review",
    start: () =>
      startBunReviewServer({
        rawPatch: PATCH,
        gitRef: "HEAD",
        origin: "claude-code",
        htmlContent: MINIMAL_HTML,
      }) as unknown as Promise<RunningReview>,
  },
  {
    name: "Pi review",
    start: () =>
      startPiReviewServer({
        rawPatch: PATCH,
        gitRef: "HEAD",
        origin: "pi",
        htmlContent: MINIMAL_HTML,
      }) as unknown as Promise<RunningReview>,
  },
];

async function postFeedback(url: string, annotations: readonly unknown[]) {
  return fetch(`${url}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: false, feedback: FEEDBACK, annotations }),
  });
}

for (const runtime of runtimes) {
  describe(`review-level note payload (${runtime.name})`, () => {
    test("the note reaches waitForDecision unmodified, with the feedback byte-identical", async () => {
      useTempDataDir();
      const server = await runtime.start();
      try {
        const decision = server.waitForDecision();
        const response = await postFeedback(server.url, [LINE_COMMENT, NOTE]);
        expect(response.status).toBe(200);

        const result = await decision;
        expect(result.approved).toBe(false);
        // Byte-identical: the ## General section the note lives in is what the
        // agent actually reads.
        expect(result.feedback).toBe(FEEDBACK);
        expect(result.annotations.length).toBe(2);
        // Deep-equal, so a dropped `scope` or a rewritten sentinel path fails.
        expect(result.annotations[1]).toEqual(NOTE);
      } finally {
        server.stop();
      }
    });

    test("a note-carrying submission archives as a feedback decision that counts the note", async () => {
      const dataDir = useTempDataDir();
      enableArchive();
      const server = await runtime.start();
      try {
        const decision = server.waitForDecision();
        expect((await postFeedback(server.url, [LINE_COMMENT, NOTE])).status).toBe(200);
        await decision;

        const projects = readdirSync(join(dataDir, "feedback"));
        expect(projects.length).toBe(1);
        const records = parseFeedbackIndex(
          readFileSync(join(dataDir, "feedback", projects[0], "index.jsonl"), "utf-8"),
        );
        expect(records.length).toBe(1);
        expect(records[0].decision).toBe("feedback");
        expect(records[0].counts.annotations).toBe(2);
        // The sidecar exists and carries the note's text, so a submission whose
        // only content is a review-level note is recoverable from disk.
        expect(records[0].recordFile).toBeTruthy();
        const sidecar = readFileSync(
          join(dataDir, "feedback", projects[0], records[0].recordFile as string),
          "utf-8",
        );
        expect(sidecar).toContain(NOTE_TEXT);
      } finally {
        server.stop();
      }
    });
  });
}

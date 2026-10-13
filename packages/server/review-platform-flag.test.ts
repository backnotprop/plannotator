/**
 * The PR-platform status post is marked explicitly. After a review is posted
 * to GitHub/GitLab/Bitbucket the editor sends one /api/feedback with the
 * status line and `platform: true`; both review servers carry that onto the
 * decision, and only a real boolean `true`.
 *
 * Regression guarded (0.28.0): hosts used to infer "platform post" from an
 * empty `annotations` array, but PR description, PR comment and editor
 * comments ride only in `feedback`, so a review made only of those was read as
 * the status post and the Claude Code mod sent the agent nothing. A server
 * that drops the flag would turn every real status post into feedback; one
 * that invents it would bring the bug back.
 *
 * Both runtimes in one file (precedent: review-note-payload.test.ts); temp
 * PLANNOTATOR_DATA_DIR per test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";

const tempDirs: string[] = [];
let savedDataDir: string | undefined;
let dataDirSaved = false;

function useTempDataDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-review-platform-"));
  tempDirs.push(dir);
  if (!dataDirSaved) {
    savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    dataDirSaved = true;
  }
  process.env.PLANNOTATOR_DATA_DIR = dir;
}

afterEach(() => {
  if (dataDirSaved) {
    if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    dataDirSaved = false;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunningReview {
  url: string;
  stop(): void;
  waitForDecision(): Promise<Record<string, unknown>>;
}

const runtimes: Array<{ name: string; start: () => Promise<RunningReview> }> = [
  {
    name: "Bun review",
    start: () =>
      startBunReviewServer({ rawPatch: PATCH, gitRef: "HEAD", origin: "claude-code", htmlContent: MINIMAL_HTML }) as unknown as Promise<RunningReview>,
  },
  {
    name: "Pi review",
    start: () =>
      startPiReviewServer({ rawPatch: PATCH, gitRef: "HEAD", origin: "pi", htmlContent: MINIMAL_HTML }) as unknown as Promise<RunningReview>,
  },
];

async function decide(runtime: (typeof runtimes)[number], body: Record<string, unknown>) {
  useTempDataDir();
  const server = await runtime.start();
  try {
    const decision = server.waitForDecision();
    const response = await fetch(`${server.url}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return await decision;
  } finally {
    server.stop();
  }
}

for (const runtime of runtimes) {
  describe(`platform status flag (${runtime.name})`, () => {
    test("the status post's platform: true rides onto the decision", async () => {
      const result = await decide(runtime, {
        approved: false,
        feedback: "Pull request reviewed on GitHub: https://github.com/o/r/pull/1",
        annotations: [],
        platform: true,
      });
      expect(result.platform).toBe(true);
    });

    test("zero-annotation feedback without the flag is not a platform post", async () => {
      const result = await decide(runtime, {
        approved: false,
        feedback: "## PR description\n\nExplain the fallback.",
        annotations: [],
      });
      expect("platform" in result).toBe(false);
      expect(result.feedback).toBe("## PR description\n\nExplain the fallback.");
    });

    test.each([["true"], [1], [{}]])("a non-boolean platform value (%p) is not carried", async (value) => {
      const result = await decide(runtime, { approved: false, feedback: "Fix it.", annotations: [], platform: value });
      expect("platform" in result).toBe(false);
    });
  });
}

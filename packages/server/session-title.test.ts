import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";
import { NO_BROWSER } from "../../tests/helpers/no-browser";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const TITLE = "add-refund-flow review";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "PLANNOTATOR_ANNOTATE_HISTORY", "PLANNOTATOR_BROWSER"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "plannotator-session-title-"));
  process.env.PLANNOTATOR_DATA_DIR = join(dir, ".data");
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

async function payload(
  server: { url: string; stop: () => void },
  path: "/api/plan" | "/api/diff",
): Promise<Record<string, unknown>> {
  try {
    return (await (await fetch(`${server.url}${path}`)).json()) as Record<string, unknown>;
  } finally {
    server.stop();
  }
}

describe("annotate: /api/plan carries the title", () => {
  test("one file", async () => {
    const file = join(dir, "proposal.md");
    writeFileSync(file, "# Proposal\n");
    const json = await payload(await startAnnotateServer({ markdown: "# Proposal\n", filePath: file, htmlContent: MINIMAL_HTML, title: TITLE }), "/api/plan");
    expect(json.title).toBe(TITLE);
  });

  test("a folder", async () => {
    const folder = join(dir, "add-refund-flow");
    mkdirSync(folder);
    writeFileSync(join(folder, "proposal.md"), "# Proposal\n");
    const json = await payload(
      await startAnnotateServer({ markdown: "", filePath: folder, folderPath: folder, mode: "annotate-folder", htmlContent: MINIMAL_HTML, title: TITLE }),
      "/api/plan",
    );
    expect(json.title).toBe(TITLE);
  });

  test("the last message", async () => {
    const json = await payload(
      await startAnnotateServer({ markdown: "Done.", filePath: "last-message", mode: "annotate-last", htmlContent: MINIMAL_HTML, title: TITLE }),
      "/api/plan",
    );
    expect(json.title).toBe(TITLE);
  });

  test("without --title there is no title field", async () => {
    const file = join(dir, "proposal.md");
    writeFileSync(file, "# Proposal\n");
    const json = await payload(await startAnnotateServer({ markdown: "# Proposal\n", filePath: file, htmlContent: MINIMAL_HTML }), "/api/plan");
    expect("title" in json).toBe(false);
  });
});

describe("code review: /api/diff carries the title", () => {
  test("with --title", async () => {
    const json = await payload(await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, title: TITLE }), "/api/diff");
    expect(json.title).toBe(TITLE);
  });

  test("without --title there is no title field", async () => {
    const json = await payload(await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }), "/api/diff");
    expect("title" in json).toBe(false);
  });
});

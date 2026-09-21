/**
 * PR5 approve-with-notes delivery — server half, dual-runtime (Bun + Pi).
 * Decision-control spec §6.4.
 *
 * Guards three regressions:
 *  1. Advert honesty: a server booted WITHOUT `approvalNotesSupported`
 *     advertises `false` on /api/diff — an old caller (a consumer whose
 *     approved branch still discards feedback) must never read as capable,
 *     or the client renders approve-carrying items whose notes are dropped.
 *  2. Advert survival: the advert rides /api/diff/switch too. If a switch
 *     response stopped carrying it, a client that re-derives state from the
 *     payload would silently lose the approve-carrying menu items after a
 *     diff switch — the exact failure the spec names.
 *  3. Delivery + archive: an approval carrying feedback reaches
 *     waitForDecision unmodified and archives as `approved-with-notes`;
 *     a bare approval (`feedback: ''`, no annotations — the post-placeholder
 *     client shape) archives as `lgtm` with NO sidecar. The `lgtm` decision
 *     was unreachable while the client sent the LGTM placeholder (spec §6.2
 *     fact 1); this pins that it stays reachable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext } from "./vcs";
import { parseFeedbackIndex } from "@plannotator/shared/feedback-archive";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";

const NOTE_TEXT = "Approved — consider extracting the parser helper in a follow-up.";
const APPROVAL_FEEDBACK = `# Code Review Feedback\n\n## General\n\n${NOTE_TEXT}\n`;
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
} as const;

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function useTempDataDir(): string {
  const dir = makeTempDir("plannotator-approval-notes-");
  saveEnv("PLANNOTATOR_DATA_DIR");
  process.env.PLANNOTATOR_DATA_DIR = dir;
  return dir;
}

function enableArchive() {
  saveEnv("PLANNOTATOR_FEEDBACK_HISTORY");
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
}

async function reservePiPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  saveEnv("PLANNOTATOR_PORT");
  process.env.PLANNOTATOR_PORT = String(port);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function initRepo(): string {
  const repoDir = makeTempDir("plannotator-approval-repo-");
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  return repoDir;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const [runtime, startServer] of [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const) {
  describe(`review approval-notes advert (${runtime})`, () => {
    test("absent option advertises false; passed option advertises true and survives /api/diff/switch", async () => {
      useTempDataDir();

      // Old-caller compatibility: no option = not capable.
      if (runtime === "Pi") await reservePiPort();
      const legacy = await startServer({
        rawPatch: PATCH,
        gitRef: "HEAD",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const data = (await fetch(`${legacy.url}/api/diff`).then((r) => r.json())) as {
          approvalNotesSupported?: boolean;
        };
        expect(data.approvalNotesSupported).toBe(false);
      } finally {
        legacy.stop();
      }

      // Capable session: true on /api/diff AND on the switch payload, so the
      // advert cannot silently disappear after a diff switch.
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, "git");
      if (runtime === "Pi") await reservePiPort();
      const capable = await startServer({
        rawPatch: PATCH,
        gitRef: "Working tree",
        diffType: "uncommitted",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        approvalNotesSupported: true,
        htmlContent: MINIMAL_HTML,
      });
      try {
        const initial = (await fetch(`${capable.url}/api/diff`).then((r) => r.json())) as {
          approvalNotesSupported?: boolean;
        };
        expect(initial.approvalNotesSupported).toBe(true);

        const switched = (await fetch(`${capable.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "uncommitted" }),
        }).then((r) => r.json())) as { approvalNotesSupported?: boolean; error?: string };
        expect(switched.error).toBeUndefined();
        expect(switched.approvalNotesSupported).toBe(true);
      } finally {
        capable.stop();
      }
    });
  });

  describe(`approve-with-notes delivery (${runtime})`, () => {
    test("approve-time feedback reaches waitForDecision unmodified and archives as approved-with-notes", async () => {
      const dataDir = useTempDataDir();
      enableArchive();
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: PATCH,
        gitRef: "HEAD",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        approvalNotesSupported: true,
        htmlContent: MINIMAL_HTML,
      });
      try {
        const decision = server.waitForDecision();
        const response = await fetch(`${server.url}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true, feedback: APPROVAL_FEEDBACK, annotations: [NOTE] }),
        });
        expect(response.status).toBe(200);

        const result = await decision;
        expect(result.approved).toBe(true);
        // Byte-identical: this string is what the consumer prints after the
        // approved prompt — a rewrite here corrupts what the agent reads.
        expect(result.feedback).toBe(APPROVAL_FEEDBACK);
        expect(result.annotations).toEqual([NOTE]);

        const projects = readdirSync(join(dataDir, "feedback"));
        expect(projects.length).toBe(1);
        const records = parseFeedbackIndex(
          readFileSync(join(dataDir, "feedback", projects[0], "index.jsonl"), "utf-8"),
        );
        expect(records.length).toBe(1);
        expect(records[0].decision).toBe("approved-with-notes");
        expect(records[0].counts.annotations).toBe(1);
      } finally {
        server.stop();
      }
    });

    test("a bare approval (post-placeholder client shape) archives as lgtm with no sidecar", async () => {
      const dataDir = useTempDataDir();
      enableArchive();
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: PATCH,
        gitRef: "HEAD",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        approvalNotesSupported: true,
        htmlContent: MINIMAL_HTML,
      });
      try {
        const decision = server.waitForDecision();
        const response = await fetch(`${server.url}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true, feedback: "", annotations: [] }),
        });
        expect(response.status).toBe(200);
        const result = await decision;
        expect(result.approved).toBe(true);
        expect(result.feedback).toBe("");

        const projects = readdirSync(join(dataDir, "feedback"));
        expect(projects.length).toBe(1);
        const records = parseFeedbackIndex(
          readFileSync(join(dataDir, "feedback", projects[0], "index.jsonl"), "utf-8"),
        );
        expect(records.length).toBe(1);
        // Reachable at last: the pre-PR5 client's LGTM placeholder made
        // hasContent always true, so every bare approval archived as
        // approved-with-notes plus a sidecar file.
        expect(records[0].decision).toBe("lgtm");
        expect(records[0].recordFile).toBeUndefined();
      } finally {
        server.stop();
      }
    });
  });
}

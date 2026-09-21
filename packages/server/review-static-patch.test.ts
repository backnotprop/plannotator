/**
 * `plannotator review --patch-file` — server half, dual-runtime (Bun + Pi).
 *
 * A static patch review has no repository, no working tree and no VCS behind
 * it, so the server has to say so and act like it. Three regressions:
 *
 *  1. The client cannot tell patch mode from a repo-less VCS session unless
 *     the server advertises it. Without `sourceKind: "patch"` the browser
 *     falls back to its `uncommitted` default and renders Git Add buttons,
 *     hunk-expansion arrows and "No uncommitted changes" — all lies.
 *  2. `diffType` must ride the payload in patch mode. It used to be withheld
 *     (it is gated on local access), which is what left the client on its
 *     `uncommitted` default in the first place.
 *  3. The endpoints that read a working tree must answer 400 rather than
 *     resolving the patch's paths against whatever cwd the server runs in —
 *     `/api/git-add`, `/api/file-content` and `/api/open-in` would otherwise
 *     stage, read, or OPEN an unrelated same-named file.
 *
 * A VCS session is checked alongside each case: the advert is absent there
 * (absent reads as "vcs"), so nothing about an ordinary review changed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext } from "./vcs";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";

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

function useTempDataDir(): void {
  saveEnv("PLANNOTATOR_DATA_DIR");
  process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-static-patch-");
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
  const repoDir = makeTempDir("plannotator-static-patch-repo-");
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
  describe(`static patch review server (${runtime})`, () => {
    test("advertises sourceKind + diffType and 400s every working-tree endpoint", async () => {
      useTempDataDir();
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: PATCH,
        gitRef: "reading.diff",
        diffType: "static-patch",
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const diff = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          sourceKind?: string;
          diffType?: string;
          gitContext?: unknown;
          repoInfo?: unknown;
          rawPatch?: string;
        };
        expect(diff.sourceKind).toBe("patch");
        expect(diff.diffType).toBe("static-patch");
        expect(diff.gitContext).toBeUndefined();
        // Whatever repo the server process sits in is not the patch's origin:
        // advertising it would put an unrelated repo and branch in the header.
        expect(diff.repoInfo).toBeUndefined();
        expect(diff.rawPatch).toBe(PATCH);

        const gitAdd = await fetch(`${server.url}/api/git-add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: "src/parse.ts" }),
        });
        expect(gitAdd.status).toBe(400);

        const fileContent = await fetch(
          `${server.url}/api/file-content?path=src/parse.ts`,
        );
        expect(fileContent.status).toBe(400);

        // The path in the patch may well exist under the server's cwd by
        // coincidence; opening it would show a file from an unrelated tree.
        const openIn = await fetch(`${server.url}/api/open-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: "src/parse.ts", base: null, appId: "reveal" }),
        });
        expect(openIn.status).toBe(400);

        const apps = (await fetch(`${server.url}/api/open-in/apps`).then((r) =>
          r.json(),
        )) as { available?: boolean; apps?: unknown[] };
        expect(apps.available).toBe(false);
        expect(apps.apps).toEqual([]);
      } finally {
        server.stop();
      }
    });

    test("an ordinary VCS review carries no advert and keeps file access", async () => {
      useTempDataDir();
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, "git");
      if (runtime === "Pi") await reservePiPort();
      const server = await startServer({
        rawPatch: PATCH,
        gitRef: "Working tree",
        diffType: "uncommitted",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: MINIMAL_HTML,
      });
      try {
        const diff = (await fetch(`${server.url}/api/diff`).then((r) => r.json())) as {
          sourceKind?: string;
        };
        // Absent, not "vcs": the advert is add-only, so an old client that
        // never reads the field sees a byte-identical payload.
        expect(diff.sourceKind).toBeUndefined();

        // The guards above must be keyed on patch mode, not merely present:
        // a real repo still resolves file content (README.md is committed).
        const fileContent = await fetch(`${server.url}/api/file-content?path=README.md`);
        expect(fileContent.status).toBe(200);
      } finally {
        server.stop();
      }
    });
  });
}

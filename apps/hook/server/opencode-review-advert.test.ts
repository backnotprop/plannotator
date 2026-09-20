/**
 * Fail-closed approval-notes handshake for the OpenCode CLI bridge (PR5).
 *
 * The advert lives in this binary's review server while DELIVERY lives in the
 * independently-versioned OpenCode plugin (`buildReviewPromptFromBridgeOutcome`).
 * Without the handshake, a new binary + old plugin advertises "Approve with
 * notes", the reviewer uses it, and the old bridge silently drops the notes —
 * the exact silent-drop class the decision-control stack exists to kill.
 *
 * Pinned end to end through the real entrypoint: `opencode-review` stdin
 * WITHOUT the plugin's `supportsApprovalNotes` declaration must serve
 * `approvalNotesSupported: false` on /api/diff; WITH it, true.
 *
 * Follows the cli.test.ts entrypoint precedent: the entrypoint imports the
 * built app HTML at module load, so missing dist files are stood in with
 * placeholders and removed again afterwards; a real build is left alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
let stubbedDist: string[] = [];
const tempDirs: string[] = [];

beforeAll(() => {
  stubbedDist = ["index.html", "review.html"]
    .map((name) => join(distDir, name))
    .filter((path) => !existsSync(path));
  if (stubbedDist.length > 0) {
    mkdirSync(distDir, { recursive: true });
    for (const path of stubbedDist) writeFileSync(path, "<!doctype html><title>test stub</title>");
  }
});

afterAll(() => {
  for (const path of stubbedDist) rmSync(path, { force: true });
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function initRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "plannotator-oc-advert-repo-"));
  tempDirs.push(repoDir);
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "app.ts"), "export const a = 1;\n");
  git(repoDir, ["add", "app.ts"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  // An uncommitted change so the default diff is non-empty.
  writeFileSync(join(repoDir, "app.ts"), "export const a = 2;\n");
  return repoDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePort) => server.close(() => resolvePort()));
  return port;
}

/** Spawn `plannotator opencode-review` with the given stdin, read the advert
 *  off /api/diff, dismiss the session, and return the served advert plus the
 *  CLI's final decision record. */
async function runBridgeReview(stdinJson: object): Promise<{
  advert: boolean | undefined;
  decision: string;
}> {
  const repoDir = initRepo();
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-oc-advert-data-"));
  tempDirs.push(dataDir);
  const port = await reservePort();
  const env = {
    ...process.env,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_PORT: String(port),
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
  };
  const proc = Bun.spawn(["bun", "run", entry, "opencode-review"], {
    cwd: repoDir,
    env,
    stdin: new TextEncoder().encode(JSON.stringify(stdinJson)),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let advert: boolean | undefined;
    let up = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const res = await fetch(`${base}/api/diff`);
        if (res.ok) {
          const data = (await res.json()) as { approvalNotesSupported?: boolean };
          advert = data.approvalNotesSupported;
          up = true;
          break;
        }
      } catch {
        // Server not listening yet.
      }
      await Bun.sleep(100);
    }
    if (!up) throw new Error("review server did not come up");
    await fetch(`${base}/api/exit`, { method: "POST" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
    const record = JSON.parse(lines[lines.length - 1]!) as { decision: string };
    return { advert, decision: record.decision };
  } finally {
    proc.kill();
  }
}

describe("opencode-review approval-notes handshake", () => {
  test("stdin without the plugin declaration serves approvalNotesSupported: false", async () => {
    // The old-plugin shape: no supportsApprovalNotes field at all. Fail
    // closed — the client then renders no approve-carrying items, so an old
    // bridge can never be handed a note it would discard.
    const result = await runBridgeReview({ arguments: "" });
    expect(result.advert).toBe(false);
    expect(result.decision).toBe("dismissed");
  }, 30_000);

  test("the plugin's supportsApprovalNotes: true declaration flips the advert on", async () => {
    const result = await runBridgeReview({ arguments: "", supportsApprovalNotes: true });
    expect(result.advert).toBe(true);
    expect(result.decision).toBe("dismissed");
  }, 30_000);
});

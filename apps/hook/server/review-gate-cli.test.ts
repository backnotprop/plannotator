import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { deliveryFor } from "../hooks/mod/delivery";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

const PATCH = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
  "",
].join("\n");

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function start(flags: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-review-gate-")));
  roots.push(root);
  writeFileSync(join(root, "change.patch"), PATCH);
  const dataDir = join(root, "data");
  const launch = join(dataDir, "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const files = { ready: join(launch, "ready"), result: join(launch, "result.json") };
  const proc = Bun.spawn([process.execPath, "run", entry, "review", ...flags, "--patch-file", "change.patch"], {
    cwd: root,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_PORT: "0",
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_READY_FILE: files.ready,
      PLANNOTATOR_HOST_RESULT_FILE: files.result,
      PLANNOTATOR_AI: "disabled",
      PLANNOTATOR_SHARE: "disabled",
      PLANNOTATOR_FEEDBACK_HISTORY: "0",
      PLANNOTATOR_REVIEW_PROGRESS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = async () => {
    const line = await waitFor(() => {
      if (proc.exitCode !== null) throw new Error(`review exited ${proc.exitCode}`);
      return existsSync(files.ready) ? readFileSync(files.ready, "utf8").split("\n")[0] : null;
    });
    return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  };
  const finish = async () => {
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code, stdout, stderr, record: existsSync(files.result) ? JSON.parse(readFileSync(files.result, "utf8")) : null };
  };
  return { base, finish, proc };
}

describe("review --gate", () => {
  test("is accepted, and a bare Approve is a noop record carrying the approved prompt, delivered for a gated launch", async () => {
    const run = start(["--gate"]);
    let base: string;
    try {
      base = await run.base();
    } catch (error) {
      run.proc.kill();
      const { stderr } = await run.finish();
      throw new Error(`${(error as Error).message}: ${stderr}`);
    }
    const response = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true, feedback: "", annotations: [] }),
    });
    expect(response.status).toBe(200);
    const { code, stdout, record } = await run.finish();
    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");
    expect(record).toMatchObject({ v: 1, surface: "review", decision: "approved", noop: true, message: stdout.trim() });

    const context = { subject: "change.patch", sessionId: "pn-abc123", overflowPath: "/unused/feedback.md" };
    expect(deliveryFor(record, context).action).toBe("log");
    const gated = deliveryFor(record, { ...context, deliverApproval: true });
    expect(gated.action).toBe("submit");
    expect(gated.action === "submit" && gated.text).toStartWith("Plannotator: change.patch (pn-abc123) — Approved.");
    expect(gated.action === "submit" && gated.text).toContain(stdout.trim());
  }, 30_000);
});

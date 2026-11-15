/**
 * Pi's review server's command runner ends a command given up on (`CommandOptions.signal`), with everything it started: a
 * Bitbucket token command that hangs on a prompt is killed when Plannotator stops waiting, never left running. What
 * regresses: the abort ignored, or only the command itself ended while a child it started lives on. Real processes
 * (`sh`, `sleep`), no network.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prCommandRuntime } from "./pr.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test.skipIf(process.platform === "win32")("an aborted command is ended with the child it started", async () => {
  dir = mkdtempSync(join(tmpdir(), "plannotator-abort-"));
  const pidFile = join(dir, "child.pid");
  const giveUp = new AbortController();
  const run = prCommandRuntime.runCommand("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], { signal: giveUp.signal });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the child's pid");
  const child = Number(readFileSync(pidFile, "utf8").trim());
  expect(alive(child)).toBe(true);
  giveUp.abort();
  const result = await run;
  expect(result.exitCode).not.toBe(0);
  await until(() => !alive(child), "the child to end");
});

test("a command with a signal that never aborts runs as before", async () => {
  const result = await prCommandRuntime.runCommand("sh", ["-c", "echo ok"], { signal: new AbortController().signal });
  expect(result).toMatchObject({ stdout: "ok\n", exitCode: 0 });
});

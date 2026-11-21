/**
 * The start trace (inbox-start-trace.ts) is how a leftover `inbox --no-open` is told apart next time: with the debug
 * log on, its pid's last line in inbox.log says what it waits for, and a process that ended says so with its code.
 * Off, nothing is written. Each case runs in a child process, because the exit line is written as the process ends.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runChild(debug: boolean, steps: string, exitCode: number): { dataDir: string; pid: number } {
  const root = mkdtempSync(join(tmpdir(), "inbox-start-trace-"));
  const dataDir = join(root, "data");
  const script = join(root, "child.ts");
  writeFileSync(
    script,
    [
      `import { inboxStartTrace } from ${JSON.stringify(join(import.meta.dir, "inbox-start-trace.ts"))};`,
      `const trace = inboxStartTrace(process.env.PLANNOTATOR_DATA_DIR!, "detached");`,
      steps,
      `console.log(process.pid);`,
      `process.exit(${exitCode});`,
    ].join("\n"),
  );
  const env: Record<string, string | undefined> = { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, HOME: join(root, "home") };
  delete env.PLANNOTATOR_INBOX_DEBUG;
  if (debug) env.PLANNOTATOR_INBOX_DEBUG = "1";
  const run = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 20_000 });
  expect(run.status).toBe(exitCode);
  return { dataDir, pid: Number(run.stdout.trim()) };
}

test("with the debug log on, each step and the exit land in inbox.log under the process's pid, with no other values", () => {
  const { dataDir, pid } = runChild(true, `trace.step("lock_joined"); trace.step("busy_wait", { inbox: 4242 });`, 3);
  const lines = readFileSync(join(dataDir, "inbox", "inbox.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => [line.ev, line.pid, line.role, line.step])).toEqual([
    ["inbox_start", pid, "detached", "lock_joined"],
    ["inbox_start", pid, "detached", "busy_wait"],
    ["inbox_start", pid, "detached", "exit"],
  ]);
  expect(lines[1].inbox).toBe(4242);
  expect(lines[2].code).toBe(3);
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) {
      if (key === "ev" || key === "role" || key === "step") expect(typeof value).toBe("string");
      else expect(typeof value).toBe("number");
    }
  }
});

test("with the debug log on, a starter that found the Inbox running (no step) writes no exit line either", () => {
  const { dataDir } = runChild(true, "", 0);
  expect(existsSync(join(dataDir, "inbox", "inbox.log"))).toBe(false);
});

test("with the debug log off, a start writes nothing", () => {
  const { dataDir } = runChild(false, `trace.step("lock_joined"); trace.step("serving", { port: 1234 });`, 0);
  expect(existsSync(join(dataDir, "inbox", "inbox.log"))).toBe(false);
});

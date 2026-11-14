/**
 * `inboxOutOfReach` (packages/shared/inbox/registry.ts): whether a record whose port did not answer names an Inbox
 * that runs but that this process cannot reach (no start), or one that is gone (start one). The pid is this test's
 * own `sleep` child or a pid that has exited; `ps` and loopback are stood in for, except in the last two tests,
 * which check the real loopback check, with and without a macOS sandbox that blocks it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { inboxEnsureFailedWords, inboxOutOfReach, InboxUnreachableError, loopbackReachable } from "./registry";
import type { ProcessInfo } from "./process-proof";

const children: { kill: (signal?: number | NodeJS.Signals) => void }[] = [];

afterEach(() => {
  // inbox-guard: own child (the `sleep` stand-ins this test spawned, never an Inbox)
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const STARTED_AT = "2026-11-14T10:00:00.000Z";
const INBOX: ProcessInfo = { startedAtMs: Date.parse(STARTED_AT) - 5_000, command: "/usr/local/bin/plannotator inbox --no-open" };

function livePid(): number {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child.pid;
}

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const blocked = async () => false;
const reachable = async () => true;

describe("inboxOutOfReach", () => {
  test("a live Inbox this process cannot reach is out of reach: the start is refused with the health request's error", async () => {
    const entry = { pid: livePid(), port: await closedPort(), startedAt: STARTED_AT };
    expect(await inboxOutOfReach(entry, { loopback: blocked, processInfo: () => INBOX })).toEqual(expect.any(String));
    // A sandbox may not run `ps`: a live pid that cannot be read counts as the Inbox.
    expect(await inboxOutOfReach(entry, { loopback: blocked, processInfo: () => null })).toEqual(expect.any(String));
  });

  test("where this process reaches loopback, nothing on the port means it is not running here: the start goes ahead", async () => {
    const entry = { pid: livePid(), port: await closedPort(), startedAt: STARTED_AT };
    expect(await inboxOutOfReach(entry, { loopback: reachable, processInfo: () => INBOX })).toBeNull();
  });

  test("a pid that has exited, or that `ps` shows is not that Inbox, is not out of reach: the start goes ahead", async () => {
    const port = await closedPort();
    expect(await inboxOutOfReach({ pid: await exitedPid(), port, startedAt: STARTED_AT }, { loopback: blocked, processInfo: () => null })).toBeNull();
    const pid = livePid();
    const other: ProcessInfo = { startedAtMs: INBOX.startedAtMs, command: "/usr/bin/python3 server.py" };
    expect(await inboxOutOfReach({ pid, port, startedAt: STARTED_AT }, { loopback: blocked, processInfo: () => other })).toBeNull();
    // An Inbox command line that started after the record was written reused the pid.
    const later: ProcessInfo = { startedAtMs: Date.parse(STARTED_AT) + 60_000, command: INBOX.command };
    expect(await inboxOutOfReach({ pid, port, startedAt: STARTED_AT }, { loopback: blocked, processInfo: () => later })).toBeNull();
  });

  test("this process's own pid (the window's Restart, which stopped listening itself) is not out of reach", async () => {
    expect(await inboxOutOfReach({ pid: process.pid, port: await closedPort(), startedAt: STARTED_AT }, { loopback: blocked, processInfo: () => INBOX })).toBeNull();
  });

  test("a port that answers now is not out of reach", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
    try {
      expect(await inboxOutOfReach({ pid: livePid(), port: server.port as number, startedAt: STARTED_AT }, { loopback: blocked, processInfo: () => INBOX })).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("a command refused this way never tells the agent the Inbox is not running", () => {
    expect(inboxEnsureFailedWords(new InboxUnreachableError("EPERM"))).not.toContain("not running");
    expect(inboxEnsureFailedWords(new Error("did not start"))).toContain("not running");
  });
});

describe("loopbackReachable", () => {
  test("reaches a port it opens itself", async () => {
    expect(await loopbackReachable()).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("under a macOS sandbox that blocks loopback, it does not", () => {
    const registry = resolve(import.meta.dir, "registry.ts");
    const script = `import { loopbackReachable } from ${JSON.stringify(registry)}; console.log(String(await loopbackReachable()));`;
    const profile = '(version 1)(allow default)(deny network-outbound (remote ip "localhost:*"))';
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(result.stdout.trim(), result.stderr).toBe("false");
  });
});

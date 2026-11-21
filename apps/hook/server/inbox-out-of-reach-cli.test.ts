/**
 * `plannotator inbox` as processes: a starter that cannot reach loopback (an agent's sandbox, stood in for by
 * PLANNOTATOR_TEST_LOOPBACK_BLOCKED and a record whose port nothing answers on) never starts a second Inbox on the
 * store of one that runs, so the person's Inbox keeps serving. Once that Inbox is gone it starts one, as before; and
 * a starter that can reach loopback treats a live Inbox with nothing on its port as before. The CLI from source, or
 * the compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one. Temp worlds only; only the pids these tests
 * started are signalled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { INBOX_DATA_CHECK_MS } from "@plannotator/server/inbox";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { type InboxEntry, inboxEntryOf, mustSignalInbox, stopProvenInboxes, waitGone } from "../../../tests/helpers/inbox-process";
import { createInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";

const worlds: InboxWorld[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
let stubs: string[] = [];

afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  removeStubbedHtml(stubs.splice(0));
});

function world(): InboxWorld {
  if (stubs.length === 0) stubs = stubBuiltHtml();
  const w = createInboxWorld("plannotator-inbox-out-of-reach-", "out-of-reach", "out-of-reach");
  worlds.push(w);
  return w;
}

function run(w: InboxWorld, args: string[], blocked: boolean): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", ...args], {
    env: { ...process.env, ...worldEnv(w), PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TEST_LOOPBACK_BLOCKED: blocked ? "1" : "", PLANNOTATOR_INBOX_START_TIMEOUT_MS: "8000" },
    cwd: w.root,
    timeout: 30_000,
  });
  const entry = inboxEntryOf(w.dataDir);
  if (entry) started.push({ entry, root: w.root });
  return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function startFirst(w: InboxWorld): InboxEntry {
  const first = run(w, ["--background"], false);
  expect(first.code, first.stderr).toBe(0);
  return inboxEntryOf(w.dataDir)!;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** What a sandboxed starter sees: the record's Inbox alive, nothing reachable on its port. */
async function hideItsPort(w: InboxWorld): Promise<void> {
  const file = join(w.dataDir, "inbox", "inbox.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), port: await closedPort() }, null, 2));
}

async function answers(entry: InboxEntry): Promise<boolean> {
  try {
    const body = (await (await fetch(`http://127.0.0.1:${entry.port}/api/inbox/health`, { signal: AbortSignal.timeout(2000) })).json()) as { serverSession?: string };
    return body.serverSession === entry.serverSession;
  } catch {
    return false;
  }
}

function readyLines(w: InboxWorld): number {
  return readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8").split("\n").filter((line) => line.startsWith("Plannotator Inbox: http")).length;
}

describe("plannotator inbox: a starter that cannot reach the running Inbox", () => {
  for (const args of [["--background"], ["--no-open"], ["restart"]]) {
    test(`inbox ${args.join(" ")} starts no second Inbox and says it could not reach it; the Inbox keeps serving`, async () => {
      const w = world();
      const first = startFirst(w);
      await hideItsPort(w);

      const starter = run(w, args, true);
      expect(starter.code).toBe(1);
      expect(starter.stderr).toContain("Could not reach the running Inbox: ");
      expect(registry(w).pid).toBe(first.pid);
      expect(readyLines(w)).toBe(1);
      // Past two data-gone checks: nothing took the store from it.
      await Bun.sleep(2 * INBOX_DATA_CHECK_MS + 1000);
      expect(isPidAlive(first.pid)).toBe(true);
      expect(await answers(first)).toBe(true);
    }, 60_000);
  }

  test("with that Inbox gone, the same starter starts one", async () => {
    const w = world();
    const first = startFirst(w);
    await mustSignalInbox(first, w.root, "SIGKILL");
    expect(await waitGone([first.pid], 5000)).toEqual([]);

    const starter = run(w, ["--background"], true);
    expect(starter.code, starter.stderr).toBe(0);
    const second = inboxEntryOf(w.dataDir)!;
    expect(second.pid).not.toBe(first.pid);
    expect(await answers(second)).toBe(true);
  }, 60_000);

  test("a starter that can reach loopback replaces a live Inbox with nothing on its port, as before", async () => {
    const w = world();
    const first = startFirst(w);
    await hideItsPort(w);

    const starter = run(w, ["--background"], false);
    expect(starter.code, starter.stderr).toBe(0);
    expect(inboxEntryOf(w.dataDir)!.pid).not.toBe(first.pid);
  }, 60_000);
});

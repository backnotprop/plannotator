/**
 * `plannotator inbox status | stop | restart` as real processes, each in its
 * own scratch HOME and data dir (never the person's Inbox): what status says
 * and exits with, stop asking first and escalating only on a pid proven to be
 * this data dir's Inbox (never another program that has the pid now),
 * restart replacing the Inbox through the detached start, and an agent
 * session's reply wake carrying on across a restart, each reply delivered
 * once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessageWire } from "@plannotator/core/inbox-types";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { inboxStatus, isPidAlive, readInboxRegistry, writeInboxRegistry } from "@plannotator/shared/inbox/registry";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, mustSignalInbox, signalProvenInbox, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
const children: { kill: (signal?: number | NodeJS.Signals) => void }[] = [];

beforeAll(() => {
  // The CLI imports the built pages; these tests never read them.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  // inbox-guard: own child (the stand-ins below are this test's own sleep processes, never an Inbox)
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  dataDir: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-lifecycle-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const dataDir = join(root, "data");
  return {
    root,
    dataDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      ...(process.env.PLANNOTATOR_TEST_SANDBOX ? { PLANNOTATOR_TEST_SANDBOX: process.env.PLANNOTATOR_TEST_SANDBOX } : {}),
    },
  };
}

/** Remember the Inbox the sandbox's record names now, for the teardown (killed only while still provably it). */
function track(box: Sandbox): void {
  const named = inboxEntryOf(box.dataDir);
  if (named) started.push({ entry: named, root: box.root });
}

async function cli(box: Sandbox, args: string[], options: { version?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // `version`: run as that release (a source run is "dev"), as the build's define does.
  const define = options.version ? ["--define", `__CLI_VERSION__=${JSON.stringify(options.version)}`] : [];
  const proc = Bun.spawn([process.execPath, "run", ...define, entry, ...args], { cwd: box.root, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function background(box: Sandbox) {
  const result = await cli(box, ["inbox", "--background"]);
  expect(result.code).toBe(0);
  track(box);
  return readInboxRegistry(box.dataDir)!;
}

/** A port nothing listens on. */
function deadPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** A long-lived child of this test that is not an Inbox; its command line is `argv`. */
function standIn(argv: string[]): number {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  children.push(proc);
  return proc.pid;
}

describe("plannotator inbox status", () => {
  test("an Inbox that never ran: exit 1, and stop starts nothing and exits 0", async () => {
    const box = sandbox();
    const plain = await cli(box, ["inbox", "status"]);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain(box.dataDir);
    const json = await cli(box, ["inbox", "status", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ state: "never_started", running: false, pid: null, url: null, data_dir: box.dataDir });

    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(readInboxRegistry(box.dataDir)).toBeNull();
  }, 30_000);

  test("a running Inbox: exit 0 with its URL, pid, version and data dir, as text and as JSON", async () => {
    const box = sandbox();
    const live = await background(box);
    const plain = await cli(box, ["inbox", "status"]);
    expect(plain.code).toBe(0);
    for (const fact of [live.url, String(live.pid), live.version, box.dataDir]) expect(plain.stdout).toContain(fact);
    const json = await cli(box, ["inbox", "status", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      state: "running",
      running: true,
      url: live.url,
      port: live.port,
      pid: live.pid,
      version: live.version,
      started_at: live.startedAt,
      data_dir: box.dataDir,
    });
    // Status only reads: the same Inbox still runs, its token unchanged.
    expect(readInboxRegistry(box.dataDir)!.token).toBe(live.token);
  }, 60_000);

  test("a paused Inbox (its port takes the request, no answer) exits 2, not 0 or 1", async () => {
    const box = sandbox();
    const live = await background(box);
    await mustSignalInbox(live, box.root, "SIGSTOP");
    try {
      const json = await cli(box, ["inbox", "status", "--json"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ state: "not_answering", running: false, pid: live.pid });
    } finally {
      await signalProvenInbox(live, box.root, "SIGCONT");
    }
  }, 60_000);

  test("restart is suggested only to a newer plannotator than the Inbox, never as a downgrade", async () => {
    const box = sandbox();
    const session = "v".repeat(32);
    let inboxVersion = "";
    // The Inbox's health answer alone (status only reads it): a stand-in that reports `inboxVersion`.
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/inbox/health"
          ? Response.json({ ok: true, app: "plannotator-inbox", version: inboxVersion, serverSession: session, pid: process.pid, update: null })
          : new Response("", { status: 404 }),
    });
    try {
      writeInboxRegistry(box.dataDir, {
        v: 1,
        pid: process.pid,
        port: stub.port as number,
        url: `http://localhost:${stub.port}/`,
        version: "0.0.0",
        token: "t".repeat(64),
        serverSession: session,
        startedAt: new Date().toISOString(),
      });
      inboxVersion = "0.99.0";
      const older = await cli(box, ["inbox", "status"], { version: "0.20.0" });
      expect(older.code).toBe(0);
      expect(older.stdout).toContain("0.99.0");
      expect(older.stdout).not.toContain("restart");

      inboxVersion = "0.10.0";
      const newer = await cli(box, ["inbox", "status"], { version: "0.20.0" });
      expect(newer.code).toBe(0);
      expect(newer.stdout).toContain("plannotator inbox restart");
    } finally {
      stub.stop(true);
    }
  }, 30_000);

  test("status, stop and restart refuse an unknown option, and stop and restart refuse --json", async () => {
    const box = sandbox();
    for (const args of [["status", "--xml"], ["stop", "--now"], ["restart", "--no-open"], ["stop", "--json"], ["restart", "--json"]]) {
      const result = await cli(box, ["inbox", ...args]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(args[1]!);
    }
    expect(readInboxRegistry(box.dataDir)).toBeNull();
  }, 30_000);
});

describe("plannotator inbox stop", () => {
  test("asks the Inbox to stop; it exits, status then exits 1, and the record stays for agents", async () => {
    const box = sandbox();
    const live = await background(box);
    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain(`pid ${live.pid}`);
    // The clean stop, not a signal: the Inbox took its own stop route.
    expect(stop.stdout).not.toContain("SIG");
    expect(isPidAlive(live.pid)).toBe(false);
    expect(readInboxRegistry(box.dataDir)).toMatchObject({ pid: live.pid, port: live.port });
    const after = await cli(box, ["inbox", "status", "--json"]);
    expect(after.code).toBe(1);
    expect(JSON.parse(after.stdout)).toMatchObject({ state: "stopped", reason: "dead_pid", pid: live.pid });
    // Stopping again finds nothing to stop: still exit 0, and nothing is started.
    const again = await cli(box, ["inbox", "stop"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`pid ${live.pid}`);
    expect((await inboxStatus(box.dataDir)).state).toBe("stopped");
  }, 60_000);

  test("never signals a pid that is not the Inbox: another program that has the record's pid now is left running", async () => {
    const box = sandbox();
    const other = standIn(["sleep", "60"]);
    writeInboxRegistry(box.dataDir, {
      v: 1,
      pid: other,
      port: deadPort(),
      url: "http://localhost:1/",
      version: "dev",
      token: "t".repeat(64),
      serverSession: "s".repeat(32),
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain(`pid ${other}`);
    await Bun.sleep(200);
    expect(isPidAlive(other)).toBe(true);
  }, 30_000);

  test("never signals a reused pid that only looks like an Inbox: it started after the record was written", async () => {
    const box = sandbox();
    // An Inbox-shaped command line (`… index.ts inbox --no-open`), started after the record's time: not the process that wrote it.
    const fake = join(box.root, "fake", "index.ts");
    mkdirSync(join(box.root, "fake"), { recursive: true });
    writeFileSync(fake, "setInterval(() => {}, 1000);\n");
    const other = standIn([process.execPath, fake, "inbox", "--no-open"]);
    writeInboxRegistry(box.dataDir, {
      v: 1,
      pid: other,
      port: deadPort(),
      url: "http://localhost:1/",
      version: "dev",
      token: "t".repeat(64),
      serverSession: "s".repeat(32),
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    await Bun.sleep(200);
    expect(isPidAlive(other)).toBe(true);
  }, 30_000);

  test("a copied data dir's record names the original's Inbox: stop and restart on the copy leave the original running", async () => {
    const original = sandbox();
    const live = await background(original);
    const copy = sandbox();
    mkdirSync(join(copy.dataDir, "inbox"), { recursive: true });
    writeFileSync(join(copy.dataDir, "inbox", "inbox.json"), readFileSync(join(original.dataDir, "inbox", "inbox.json")));

    const stop = await cli(copy, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("another data dir");
    await Bun.sleep(300);
    expect(isPidAlive(live.pid)).toBe(true);
    expect(await inboxStatus(original.dataDir)).toMatchObject({ state: "running", entry: { pid: live.pid, serverSession: live.serverSession } });

    // Restart stops nothing and says it restarted nothing (a start would only find the original through the copied record).
    const restart = await cli(copy, ["inbox", "restart"]);
    expect(restart.code).toBe(1);
    expect(restart.stdout).toBe("");
    expect(restart.stderr).toContain("Nothing was restarted");
    expect(await inboxStatus(original.dataDir)).toMatchObject({ state: "running", entry: { pid: live.pid, serverSession: live.serverSession } });
  }, 60_000);

  test.skipIf(process.platform === "win32")("a hung Inbox that cannot answer is proven by its process and ended with SIGKILL", async () => {
    const box = sandbox();
    const live = await background(box);
    // Paused: it takes neither its stop route nor SIGTERM, only SIGKILL.
    await mustSignalInbox(live, box.root, "SIGSTOP");
    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("SIGKILL");
    expect(isPidAlive(live.pid)).toBe(false);
  }, 60_000);

  test("a stale start lock (a start that died) is removed and reported", async () => {
    const box = sandbox();
    const lock = join(box.dataDir, "inbox", "start.lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const stop = await cli(box, ["inbox", "stop"]);
    expect(stop.code).toBe(0);
    expect(stop.stderr).toContain("stale start lock");
    expect(existsSync(lock)).toBe(false);
  }, 30_000);
});

describe("plannotator inbox restart", () => {
  test("replaces the running Inbox: the old process is gone, a new one runs on the same port, stdout is its URL alone", async () => {
    const box = sandbox();
    const before = await background(box);
    const restart = await cli(box, ["inbox", "restart"]);
    track(box);
    expect(restart.code).toBe(0);
    const after = readInboxRegistry(box.dataDir)!;
    expect(restart.stdout).toBe(`${after.url}\n`);
    expect(after.pid).not.toBe(before.pid);
    expect(after.serverSession).not.toBe(before.serverSession);
    expect(after.port).toBe(before.port);
    expect(isPidAlive(before.pid)).toBe(false);
    expect((await inboxStatus(box.dataDir)).state).toBe("running");
    // Started detached, like --background: its ready line is in the log, once per start.
    const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
    expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toHaveLength(2);
  }, 60_000);

  test("starts one when none runs", async () => {
    const box = sandbox();
    const restart = await cli(box, ["inbox", "restart"]);
    track(box);
    expect(restart.code).toBe(0);
    const status = await inboxStatus(box.dataDir);
    expect(status.state).toBe("running");
    expect(restart.stdout.trim()).toBe(readInboxRegistry(box.dataDir)!.url);
  }, 60_000);

  test("an agent starting the Inbox during a restart gets the new Inbox, never a second one", async () => {
    const box = sandbox();
    const before = await background(box);
    const restarting = cli(box, ["inbox", "restart"]);
    // The agent's on-demand start (what the shim and the connections run) in the gap: the old Inbox
    // is gone and the restart still holds the start lock.
    const lock = join(box.dataDir, "inbox", "start.lock");
    for (let i = 0; i < 200 && !(existsSync(lock) && !isPidAlive(before.pid)); i++) await Bun.sleep(25);
    expect(isPidAlive(before.pid)).toBe(false);
    const agent = await cli(box, ["inbox", "--background"]);
    const restarted = await restarting;
    track(box);
    expect(restarted.code).toBe(0);
    expect(agent.code).toBe(0);
    const now = readInboxRegistry(box.dataDir)!;
    expect(agent.stdout.trim()).toBe(now.url);
    expect(restarted.stdout.trim()).toBe(now.url);
    // One start after the first: never two writers on the store.
    const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
    expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toHaveLength(2);
  }, 60_000);

  test("an agent session's wake carries on across a restart: a held reply and a new one are each delivered once", async () => {
    const box = sandbox();
    const live = await background(box);
    const project = join(box.root, "project");
    mkdirSync(project, { recursive: true });
    const session = "ses-restart";
    const client = new Client({ name: "inbox-restart-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${live.port}/mcp`)));
    const sent = (
      (await client.callTool({
        name: "send_message",
        arguments: { project_path: project, agent_session: session, agent_host: "pi", agent_name: "Pi", body: "Draft is ready; which title?" },
      })) as { structuredContent: { thread_id: string; message_id: string } }
    ).structuredContent;
    await client.close();

    const reply = async (words: string, key: string) => {
      const now = readInboxRegistry(box.dataDir)!;
      const response = await fetch(`http://127.0.0.1:${now.port}/api/inbox/messages/${sent.message_id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: now.serverSession, idempotency_key: key, words }),
      });
      expect(response.status).toBe(200);
    };

    let busy = true;
    const delivered: string[] = [];
    const connection = new InboxAgentConnection({ dataDir: box.dataDir, host: "pi", agentName: "Pi", tools: [] });
    const wake = new InboxWake(connection, session, { isBusy: () => busy, deliver: async (text) => void delivered.push(text), notify: () => {} }, 50);
    wake.start();
    try {
      // Held: the session is busy, so this reply waits in the wake when the Inbox restarts.
      await reply("The first title.", "before");
      await Bun.sleep(500);
      const restart = await cli(box, ["inbox", "restart"]);
      track(box);
      expect(restart.code).toBe(0);
      await reply("Actually, the second one.", "after");
      busy = false;
      for (let i = 0; i < 400 && delivered.length < 2; i++) await Bun.sleep(50);
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toContain("The first title.");
      expect(delivered[1]).toContain("Actually, the second one.");
      // The new Inbox recorded both deliveries, and nothing is delivered again.
      const now = readInboxRegistry(box.dataDir)!;
      let messages: InboxMessageWire[] = [];
      for (let i = 0; i < 100; i++) {
        const model = (await (await fetch(`http://127.0.0.1:${now.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: { messages: InboxMessageWire[] } };
        messages = model.thread.messages.filter((m) => m.id !== sent.message_id);
        if (messages.length === 2 && messages.every((m) => m.delivery)) break;
        await Bun.sleep(50);
      }
      expect(messages.map((m) => m.delivery?.session)).toEqual([session, session]);
      await Bun.sleep(500);
      expect(delivered).toHaveLength(2);
    } finally {
      wake.dispose();
    }
  }, 90_000);
});

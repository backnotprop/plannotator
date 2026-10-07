/**
 * `plannotator inbox` as real processes: `--background` starts a detached
 * Inbox (no browser), the registry tells running from stopped (a dead pid, a
 * port answering for another Inbox, a live pid with no answer), a restart
 * takes the last port and rotates the token, `plannotator inbox mcp` is driven
 * by the official MCP SDK's stdio client and starts a stopped Inbox itself, a
 * person's `plannotator inbox` opens the browser, and uninstall --purge stops
 * a running Inbox before deleting its data. Every process gets a temp HOME and
 * data dir.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxStatus, isPidAlive, readInboxRegistry, writeInboxRegistry } from "@plannotator/shared/inbox/registry";
import { startInboxServer } from "@plannotator/server/inbox";
import { runPlannotatorUninstall } from "@plannotator/server/uninstall";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const roots: string[] = [];
let stubs: string[] = [];
const pids = new Set<number>();
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  dataDir: string;
  browserMarker: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".plannotator");
  mkdirSync(home, { recursive: true });
  const browserMarker = join(root, "browser-opened");
  const browser = join(root, "fake-browser.sh");
  writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${browserMarker}'\n`);
  chmodSync(browser, 0o755);
  return {
    root,
    home,
    dataDir,
    browserMarker,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      // Both are ignored by the Inbox: local only, never 19432.
      PLANNOTATOR_REMOTE: "1",
      PLANNOTATOR_PORT: "19432",
      PLANNOTATOR_BROWSER: browser,
      BROWSER: browser,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}

function gitProject(box: Sandbox): string {
  const dir = join(box.root, "projects", "billing");
  mkdirSync(join(dir, "worker"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: box.env });
  return dir;
}

async function cli(box: Sandbox, args: string[], cwd = box.root): Promise<{ code: number; stdout: string; stderr: string; pid: number }> {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], { cwd, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, pid: proc.pid };
}

async function background(box: Sandbox) {
  const result = await cli(box, ["inbox", "--background"]);
  const registry = readInboxRegistry(box.dataDir);
  if (registry) pids.add(registry.pid);
  return { ...result, registry };
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
}

describe("plannotator inbox --background", () => {
  test("starts a detached, loopback-only Inbox without a browser and without a sessions/ entry", async () => {
    const box = sandbox();
    const first = await background(box);
    expect(first.code).toBe(0);
    const registry = first.registry!;
    expect(first.stdout.trim()).toBe(registry.url);
    expect(registry.port).not.toBe(19432);
    expect(registry.pid).not.toBe(first.pid);
    // The starter has exited; the Inbox it started lives on.
    expect(isPidAlive(registry.pid)).toBe(true);
    expect((await inboxStatus(box.dataDir)).state).toBe("running");
    const health = await (await fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`)).json();
    expect(health).toMatchObject({ app: "plannotator-inbox", pid: registry.pid, serverSession: registry.serverSession });
    expect(existsSync(box.browserMarker)).toBe(false);
    const sessions = join(box.dataDir, "sessions");
    expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);

    // A second start finds it and starts nothing.
    const second = await background(box);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe(registry.url);
    expect(second.registry!.pid).toBe(registry.pid);
    expect(second.registry!.token).toBe(registry.token);
  }, 60_000);

  test("two starters at once make one Inbox", async () => {
    const box = sandbox();
    const [a, b] = await Promise.all([background(box), background(box)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout.trim()).toBe(b.stdout.trim());
    const live = readInboxRegistry(box.dataDir)!;
    expect(isPidAlive(live.pid)).toBe(true);
    // Every detached Inbox writes its ready line to inbox/inbox.log: one start, one line.
    const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
    expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toEqual([`Plannotator Inbox: ${live.url}`]);
  }, 60_000);

  test("a killed Inbox reads as stopped; the next start takes the last port and rotates token and serverSession", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    process.kill(first.pid, "SIGKILL");
    await waitDead(first.pid);
    const stopped = await inboxStatus(box.dataDir);
    expect(stopped).toMatchObject({ state: "stopped", reason: "dead_pid" });
    // The registry stays after exit, so agents still find the Inbox.
    expect(readInboxRegistry(box.dataDir)!.pid).toBe(first.pid);

    const restarted = await background(box);
    expect(restarted.code).toBe(0);
    const second = restarted.registry!;
    expect(second.pid).not.toBe(first.pid);
    expect(second.port).toBe(first.port);
    expect(second.token).not.toBe(first.token);
    expect(second.serverSession).not.toBe(first.serverSession);
  }, 60_000);

  test("a port answering for a different Inbox reads as stopped; the restart moves to a new port", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    process.kill(first.pid, "SIGKILL");
    await waitDead(first.pid);
    // Another Inbox (another data dir) now holds that port.
    const otherDir = join(box.root, "other-data");
    writeInboxRegistry(otherDir, { ...first, pid: 1, serverSession: "x".repeat(32) });
    const other = await startInboxServer({ dataDir: otherDir });
    cleanups.push(() => other.stop());
    expect(other.port).toBe(first.port);
    expect(await inboxStatus(box.dataDir)).toMatchObject({ state: "stopped", reason: "other_session" });

    const restarted = await background(box);
    expect(restarted.code).toBe(0);
    expect(restarted.registry!.port).not.toBe(first.port);
    expect(restarted.registry!.serverSession).not.toBe(other.serverSession);
  }, 60_000);

  test("a busy Inbox (paused: the port takes the request, no answer) is waited for, never replaced by a second writer", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    process.kill(first.pid, "SIGSTOP");
    let resumed = false;
    try {
      expect(await inboxStatus(box.dataDir, 500)).toMatchObject({ state: "busy" });
      const starting = background(box);
      await Bun.sleep(3000);
      process.kill(first.pid, "SIGCONT");
      resumed = true;
      const again = await starting;
      expect(again.code).toBe(0);
      expect(again.stdout.trim()).toBe(first.url);
      expect(again.registry!.pid).toBe(first.pid);
      expect(again.registry!.token).toBe(first.token);
      // One Inbox ever started on this store: one ready line in its log.
      const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
      expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toHaveLength(1);
    } finally {
      if (!resumed) process.kill(first.pid, "SIGCONT");
    }
  }, 60_000);

  test("a live pid with nothing on the port reads as stopped", async () => {
    const box = sandbox();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const deadPort = probe.port as number;
    probe.stop(true);
    writeInboxRegistry(box.dataDir, {
      v: 1,
      pid: process.pid,
      port: deadPort,
      url: `http://localhost:${deadPort}/`,
      version: "dev",
      token: "t".repeat(64),
      serverSession: "s".repeat(32),
      startedAt: new Date().toISOString(),
    });
    expect(await inboxStatus(box.dataDir)).toMatchObject({ state: "stopped", reason: "no_answer" });
    const started = await background(box);
    expect(started.code).toBe(0);
    expect(started.registry!.pid).not.toBe(process.pid);
  }, 60_000);
});

describe("plannotator inbox mcp (the stdio shim)", () => {
  test("starts a stopped Inbox with no browser tab, fills project_path and the session, and carries the answer back", async () => {
    const box = sandbox();
    const project = gitProject(box);
    // An Inbox ran here once and stopped: the registry is stale.
    const old = (await background(box)).registry!;
    process.kill(old.pid, "SIGKILL");
    await waitDead(old.pid);

    const client = new Client({ name: "shim-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", entry, "inbox", "mcp"],
      cwd: join(project, "worker"),
      env: box.env,
      stderr: "pipe",
    });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const registry = readInboxRegistry(box.dataDir)!;
    pids.add(registry.pid);
    expect(registry.pid).not.toBe(old.pid);
    expect((await inboxStatus(box.dataDir)).state).toBe("running");
    expect(existsSync(box.browserMarker)).toBe(false);

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_decisions", "read_thread", "record_decision", "resolve_message", "send_message", "wait_for_reply"]);
    const sent = (
      await client.callTool({
        name: "send_message",
        arguments: { body: ":::question\nShip the worker today?\n\n- [ ] Yes\n- [ ] No\n\nRecommended: Yes\n:::", idempotency_key: "ship-1" },
      })
    ).structuredContent as { message_id: string; thread_id: string; project: { root: string } };
    // The shim filled project_path from its working folder: the repository.
    expect(sent.project.root).toBe(project);

    // The thread is the shim session's own: asked_by "me" finds it.
    const mine = (await client.callTool({ name: "read_thread", arguments: {} })).structuredContent as { threads: { thread_id: string }[] };
    expect(mine.threads.map((t) => t.thread_id)).toEqual([sent.thread_id]);

    // The person answers in the window's API (picked, then Send).
    const base = `http://127.0.0.1:${registry.port}`;
    const { thread } = await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json();
    const question = thread.messages[0].questions[0] as InboxQuestion;
    expect(question.asked_by_agent_id).toMatch(/^ses_[0-9A-Z]{26}$/);
    const waiting = client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, timeout_seconds: 30 } });
    const answer = { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ["Yes"] };
    const pick = await fetch(`${base}/api/inbox/messages/${sent.message_id}/picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [{ key: question.key, revision: 0, answer }] }),
    });
    expect(pick.status).toBe(200);
    const send = await fetch(`${base}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "send-1", questions: [{ key: question.key, revision: 1 }] }),
    });
    expect(send.status).toBe(200);
    const reply = (await waiting).structuredContent as { status: string; reply: { body: string } };
    expect(reply.status).toBe("replied");
    expect(reply.reply.body).toContain("Answer: Yes (your recommendation)");
  }, 90_000);
});

describe("plannotator inbox (a person)", () => {
  test("opens the browser on the Inbox it starts, and on the one already running", async () => {
    const box = sandbox();
    const proc = Bun.spawn([process.execPath, "run", entry, "inbox"], { cwd: box.root, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    pids.add(proc.pid);
    const deadline = Date.now() + 20_000;
    while (!existsSync(box.browserMarker) && Date.now() < deadline) await Bun.sleep(50);
    const registry = readInboxRegistry(box.dataDir)!;
    expect(registry.pid).toBe(proc.pid);
    expect(readFileSync(box.browserMarker, "utf8").trim()).toBe(registry.url);

    rmSync(box.browserMarker);
    const again = await cli(box, ["inbox"]);
    expect(again.code).toBe(0);
    expect(readFileSync(box.browserMarker, "utf8").trim()).toBe(registry.url);
    expect(readInboxRegistry(box.dataDir)!.pid).toBe(proc.pid);

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
  }, 60_000);
});

describe("uninstall --purge and the Inbox", () => {
  test("--dry-run lists the inbox data and the running Inbox it would stop", async () => {
    const box = sandbox();
    const registry = (await background(box)).registry!;
    const result = await cli(box, ["uninstall", "--purge", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(box.dataDir, "inbox"));
    expect(result.stdout).toContain(`Stop the running Plannotator Inbox (pid ${registry.pid})`);
    expect(isPidAlive(registry.pid)).toBe(true);
  }, 60_000);

  test("purge stops the running Inbox first, then removes inbox/", async () => {
    const box = sandbox();
    const registry = (await background(box)).registry!;
    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        platform: process.platform,
        homeDir: box.home,
        tempDir: tmpdir(),
        dataDir: box.dataDir,
        execPath: join(box.root, "not-the-real-plannotator"),
        env: {},
        which: () => null,
        runCommand: async () => ({ exitCode: 0, timedOut: false }),
        scheduleWindowsSelfDelete: async () => true,
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(`Stopped the running Plannotator Inbox (pid ${registry.pid})`);
    await waitDead(registry.pid);
    expect(isPidAlive(registry.pid)).toBe(false);
    expect(existsSync(join(box.dataDir, "inbox"))).toBe(false);
  }, 60_000);
});

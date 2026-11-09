/**
 * `stopInbox` (packages/shared/inbox/registry.ts) against stand-ins this test
 * spawns itself: an Inbox-shaped process that serves the health route and
 * ignores its stop route and SIGTERM, and processes that only hold the pid a
 * record names. Each stand-in is this test's own child in a scratch folder,
 * never an Inbox anyone runs. What is guarded: a stop escalates only on a pid
 * proven to be the record's Inbox, before every signal; anything else is
 * never signalled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive, stopInbox, writeInboxRegistry, type InboxRegistryEntry } from "./registry";
import { isInboxServerCommand, parseElapsed, processMatchesEntry } from "./process-proof";

const roots: string[] = [];
const children: { kill: (signal?: number | NodeJS.Signals) => void }[] = [];

afterEach(() => {
  // inbox-guard: own child (the stand-ins this test spawned, never an Inbox)
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-stop-")));
  roots.push(root);
  return root;
}

/**
 * A stand-in run as `bun <root>/fake/index.ts inbox --no-open` (an Inbox's
 * command line). With `serve`, it answers the health route with `session`
 * and its own pid, takes its stop route without stopping (or with `refuse`
 * refuses it as another data dir's Inbox, 409 not_ours), and ignores SIGTERM.
 */
const STAND_IN = `
const session = process.env.FAKE_SESSION;
if (process.env.FAKE_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
if (process.env.FAKE_SERVE === "1") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/inbox/health") return Response.json({ ok: true, app: "plannotator-inbox", version: "fake", serverSession: session, pid: process.pid, update: null });
      if (path === "/api/inbox/control/stop") {
        return process.env.FAKE_REFUSE === "1" ? Response.json({ code: "not_ours" }, { status: 409 }) : Response.json({ ok: true, stopping: true });
      }
      return new Response("", { status: 404 });
    },
  });
  await Bun.write(process.env.FAKE_PORT_FILE, String(server.port));
}
setInterval(() => {}, 1000);
`;

async function standIn(root: string, options: { serve?: boolean; ignoreTerm?: boolean; refuse?: boolean; session?: string } = {}): Promise<{ pid: number; port: number | null }> {
  const dir = join(root, "fake");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "index.ts");
  writeFileSync(script, STAND_IN);
  const portFile = join(dir, "port");
  const proc = Bun.spawn([process.execPath, script, "inbox", "--no-open"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: {
      ...process.env,
      FAKE_SESSION: options.session ?? "",
      FAKE_SERVE: options.serve ? "1" : "0",
      FAKE_IGNORE_TERM: options.ignoreTerm ? "1" : "0",
      FAKE_REFUSE: options.refuse ? "1" : "0",
      FAKE_PORT_FILE: portFile,
    },
  });
  children.push(proc);
  if (!options.serve) {
    // Let it get past its start, so `ps` reads its command line and its start time.
    await Bun.sleep(300);
    return { pid: proc.pid, port: null };
  }
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await Bun.sleep(25);
  return { pid: proc.pid, port: Number(readFileSync(portFile, "utf8")) };
}

function deadPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function record(dataDir: string, fields: Pick<InboxRegistryEntry, "pid" | "port"> & Partial<InboxRegistryEntry>): InboxRegistryEntry {
  const entry: InboxRegistryEntry = {
    v: 1,
    url: `http://localhost:${fields.port}/`,
    version: "fake",
    token: "t".repeat(64),
    serverSession: "s".repeat(32),
    startedAt: new Date().toISOString(),
    ...fields,
  };
  writeInboxRegistry(dataDir, entry);
  return entry;
}

describe("stopInbox escalates only on a proven Inbox", () => {
  test("an Inbox that ignores its stop route and SIGTERM ends with SIGKILL; uninstall's stop never sends that", async () => {
    const root = scratch();
    const session = "a".repeat(32);
    const fake = await standIn(root, { serve: true, ignoreTerm: true, session });
    const dataDir = join(root, "data");
    record(dataDir, { pid: fake.pid, port: fake.port!, serverSession: session });

    // uninstall --purge (no escalate): SIGTERM only, so it survives and is reported.
    const careful = await stopInbox(dataDir, { timeoutMs: 400 });
    expect(careful).toEqual({ state: "still_running", pid: fake.pid, reason: "survived" });
    expect(isPidAlive(fake.pid)).toBe(true);

    const result = await stopInbox(dataDir, { timeoutMs: 400, escalate: true });
    expect(result).toMatchObject({ state: "stopped", pid: fake.pid, by: "SIGKILL" });
    expect(isPidAlive(fake.pid)).toBe(false);
  }, 30_000);

  test("an Inbox that refuses the stop as another data dir's (a copied record) is never signalled", async () => {
    const root = scratch();
    const session = "c".repeat(32);
    // It would die of SIGTERM: only the refusal keeps it running.
    const original = await standIn(root, { serve: true, refuse: true, session });
    const dataDir = join(root, "data");
    record(dataDir, { pid: original.pid, port: original.port!, serverSession: session });
    for (const escalate of [false, true]) {
      expect(await stopInbox(dataDir, { timeoutMs: 300, escalate })).toEqual({ state: "not_running", stale: { pid: original.pid, reason: "not_ours" } });
    }
    await Bun.sleep(100);
    expect(isPidAlive(original.pid)).toBe(true);
  }, 30_000);

  test("a port answering with the record's serverSession under another pid: the record's pid is never signalled", async () => {
    const root = scratch();
    const session = "b".repeat(32);
    // Something answers the health route as the record's Inbox, but with its own pid; the record names another process.
    const answering = await standIn(join(root, "a"), { serve: true, session });
    const other = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    children.push(other);
    const dataDir = join(root, "data");
    record(dataDir, { pid: other.pid, port: answering.port!, serverSession: session, startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const result = await stopInbox(dataDir, { timeoutMs: 300, escalate: true });
    expect(result).toEqual({ state: "still_running", pid: other.pid, reason: "unproven" });
    await Bun.sleep(100);
    expect(isPidAlive(other.pid)).toBe(true);
  }, 30_000);

  test.skipIf(process.platform === "win32")("by its process: an Inbox command line is signalled only when it started before the record was written", async () => {
    const root = scratch();
    // Started after the record: a pid reused by something that merely looks like an Inbox. Left alone.
    const reused = await standIn(join(root, "reused"));
    const reusedDir = join(root, "reused-data");
    record(reusedDir, { pid: reused.pid, port: deadPort(), startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(await stopInbox(reusedDir, { timeoutMs: 300, escalate: true })).toEqual({ state: "not_running", stale: { pid: reused.pid, reason: "no_answer" } });
    expect(isPidAlive(reused.pid)).toBe(true);

    // Started before the record, its listener gone (hung on the way out): this Inbox. SIGTERM ends it.
    const hung = await standIn(join(root, "hung"));
    const hungDir = join(root, "hung-data");
    record(hungDir, { pid: hung.pid, port: deadPort(), startedAt: new Date().toISOString() });
    expect(await stopInbox(hungDir, { timeoutMs: 300, escalate: true })).toMatchObject({ state: "stopped", pid: hung.pid, by: "SIGTERM" });
    expect(isPidAlive(hung.pid)).toBe(false);
    // uninstall's stop never proves by process: the same case is left as "not ours".
    const again = await standIn(join(root, "again"));
    const againDir = join(root, "again-data");
    record(againDir, { pid: again.pid, port: deadPort(), startedAt: new Date().toISOString() });
    expect(await stopInbox(againDir, { timeoutMs: 300 })).toMatchObject({ state: "not_running" });
    expect(isPidAlive(again.pid)).toBe(true);
  }, 30_000);
});

describe("the process proof", () => {
  test("an Inbox server's command line, never the stdio shim, another subcommand, or a word before plannotator", () => {
    for (const line of [
      "/Users/a b/.local/bin/plannotator inbox",
      "/Users/a/.local/bin/plannotator inbox --no-open --tailscale",
      "plannotator inbox --no-open",
      "/opt/bun run /work/apps/hook/server/index.ts inbox --no-open",
    ]) {
      expect(isInboxServerCommand(line)).toBe(true);
    }
    for (const line of [
      "/Users/a/.local/bin/plannotator inbox mcp",
      "/Users/a/.local/bin/plannotator inbox stop",
      "/Users/a/.local/bin/plannotator inbox --notes codex",
      "/Users/a/.local/bin/plannotator review",
      "grep plannotator inbox",
      "my-plannotator inbox",
      "vim notes/inbox",
      "",
    ]) {
      expect(isInboxServerCommand(line)).toBe(false);
    }
  });

  test("ps's elapsed time reads in every form, and the start bound holds to the second", () => {
    expect(parseElapsed("05:07")).toBe(307_000);
    expect(parseElapsed("2:05:07")).toBe(7_507_000);
    expect(parseElapsed("3-02:05:07")).toBe(266_707_000);
    expect(parseElapsed("soon")).toBeNull();
    const startedAt = "2026-10-27T10:00:00.000Z";
    const at = Date.parse(startedAt);
    const command = "/bin/plannotator inbox --no-open";
    expect(processMatchesEntry({ startedAtMs: at - 1_000, command }, { startedAt })).toBe(true);
    expect(processMatchesEntry({ startedAtMs: at + 60_000, command }, { startedAt })).toBe(false);
    expect(processMatchesEntry({ startedAtMs: at - 1_000, command: "/bin/plannotator inbox mcp" }, { startedAt })).toBe(false);
    expect(processMatchesEntry(null, { startedAt })).toBe(false);
  });
});

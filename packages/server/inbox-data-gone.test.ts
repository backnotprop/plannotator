/**
 * An Inbox whose data folder is gone stops instead of running on headless:
 * its `inbox/` folder removed (a test's temp dir, a hand-deleted
 * ~/.plannotator/inbox), made again at the same path, or `inbox.json` naming
 * another Inbox. And a running Inbox rewrites `inbox.json` only while it is
 * its own, and never makes a removed folder again (`updateOwnInboxRegistry`):
 * a stopping Inbox used to rewrite whatever entry it read, so it dropped its
 * successor's tailnet record, and a SIGTERM after the folder was removed made
 * the folder again. Real servers on loopback, temp data dirs, a scripted
 * `tailscale`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxRegistryPath, readInboxRegistry, writeInboxRegistry, updateOwnInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A temp root holding the data dir, which loadConfig() reads too. */
function world(): { root: string; dataDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-data-gone-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  return { root, dataDir };
}

/** `tailscale` as a script: the owner, serve status, serve on and off. */
const fakeTailscale: TailscaleRunner = (args) => {
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: "box.tail0000.ts.net.", UserID: 1 }, User: { "1": { LoginName: "owner@example.com" } } }));
  if (args[1] === "status") return ok("{}");
  const port = /--https=(\d+)/.exec(args.join(" "))?.[1];
  return ok(args.includes("off") ? "" : `https://box.tail0000.ts.net:${port}/\n`);
};

async function start(dataDir: string, options: Parameters<typeof startInboxServer>[0] = {}): Promise<{ server: InboxServer; gone: Promise<string> }> {
  let report!: (reason: string) => void;
  const gone = new Promise<string>((resolve) => (report = resolve));
  const server = await startInboxServer({ dataDir, version: "dev", binaryPath: null, dataCheckMs: 50, onDataGone: report, ...options });
  servers.push(server);
  return { server, gone };
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what} did not happen within ${ms} ms`)))]);
}

async function listening(server: InboxServer): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

describe("an Inbox whose data folder is gone", () => {
  test("the data folder removed: it stops and reports why, and never makes the folder again", async () => {
    const { root, dataDir } = world();
    const { server, gone } = await start(dataDir, { tailscale: fakeTailscale, publishTailnet: true });
    expect(server.tailscale.state().url).toContain("box.tail0000.ts.net");
    rmSync(root, { recursive: true, force: true });
    expect(await within(gone, 5000, "the stop")).toContain("is gone");
    expect(await listening(server)).toBe(false);
    // The clean stop took the tailnet mapping down and wrote nothing: the removed folder stays removed.
    expect(existsSync(root)).toBe(false);
  });

  test("the inbox folder removed and made again at the same path: it stops", async () => {
    const { dataDir } = world();
    const { server, gone } = await start(dataDir);
    rmSync(join(dataDir, "inbox"), { recursive: true, force: true });
    mkdirSync(join(dataDir, "inbox"));
    expect(await within(gone, 5000, "the stop")).toContain("made again");
    expect(await listening(server)).toBe(false);
  });

  test("inbox.json naming another Inbox: it stops (one writer per store)", async () => {
    const { dataDir } = world();
    const { server, gone } = await start(dataDir);
    writeInboxRegistry(dataDir, { ...readInboxRegistry(dataDir)!, pid: 999_999, serverSession: "another-inbox" });
    expect(await within(gone, 5000, "the stop")).toContain("another Inbox (pid 999999)");
    expect(await listening(server)).toBe(false);
  });

  test("an idle Inbox with its folder in place keeps running", async () => {
    const { dataDir } = world();
    const { server, gone } = await start(dataDir);
    const reported = await Promise.race([gone, Bun.sleep(400).then(() => null)]);
    expect(reported).toBeNull();
    expect(await listening(server)).toBe(true);
  });
});

describe("the Inbox writes only its own registry entry", () => {
  test("a stopping Inbox never rewrites the entry another Inbox wrote since (its tailnet record stays)", async () => {
    const { dataDir } = world();
    // Published, so the stop takes the mapping down and saves inbox.json: the write that clobbered the successor.
    const { server } = await start(dataDir, { tailscale: fakeTailscale, publishTailnet: true, dataCheckMs: 60_000 });
    expect(readInboxRegistry(dataDir)?.tailscale?.https_port).toBe(server.port);
    // The successor published too (its own mapping record), on a port of its own.
    const successor: InboxRegistryEntry = {
      ...readInboxRegistry(dataDir)!,
      pid: 999_998,
      port: server.port + 1,
      serverSession: "the-successor",
      tailscale: { url: null, error: null, https_port: server.port + 1, proxy_port: 4321 },
    };
    writeInboxRegistry(dataDir, successor);
    server.stop();
    expect(readInboxRegistry(dataDir)).toEqual(successor);
  });

  test("updateOwnInboxRegistry: written only while the file names this Inbox's serverSession", () => {
    const { dataDir } = world();
    const entry: InboxRegistryEntry = {
      v: 1,
      pid: process.pid,
      port: 1234,
      url: "http://localhost:1234/",
      version: "dev",
      token: "t".repeat(43),
      serverSession: "mine",
      startedAt: new Date(0).toISOString(),
    };
    const movePort = (e: InboxRegistryEntry) => {
      e.port = 5678;
    };
    // No file (and no folder): nothing is written, nothing is made.
    expect(updateOwnInboxRegistry(dataDir, "mine", movePort)).toBe(false);
    expect(existsSync(join(dataDir, "inbox"))).toBe(false);
    writeInboxRegistry(dataDir, { ...entry, serverSession: "theirs" });
    expect(updateOwnInboxRegistry(dataDir, "mine", movePort)).toBe(false);
    expect(readInboxRegistry(dataDir)).toEqual({ ...entry, serverSession: "theirs" });
    writeInboxRegistry(dataDir, entry);
    expect(updateOwnInboxRegistry(dataDir, "mine", movePort)).toBe(true);
    expect(JSON.parse(readFileSync(inboxRegistryPath(dataDir), "utf8"))).toEqual({ ...entry, port: 5678 });
  });
});

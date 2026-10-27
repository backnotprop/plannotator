/**
 * The Inbox is where a user gets stuck (QA item 30: it runs for days). A real
 * Inbox server with an injected clock and a fake GitHub on loopback (release
 * page and API), never GitHub, never the install script:
 *
 *   - a long-running Inbox started before the release shows Update within
 *     the bound, without a restart or a reload;
 *   - checking that fails for hours says so (the sidebar's row, About's dot,
 *     General's line), with the install command, including when the state
 *     file cannot be written;
 *   - "Updating…" never spins on a lock whose wrapper is gone, or one stamped
 *     by a clock that moved back; the failure shows instead;
 *   - a snooze written while the clock was ahead hides the update a day at most;
 *   - Update now → ready → restart → the new version's "What's new".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import {
  fetchLatestFromPage,
  forgetUnwrittenUpdateStateForTests,
  fetchLatestRelease,
  RELEASE_CHECK_FAILING_AFTER_MS,
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_CHECK_RETRY_MS,
  writeUpdateState,
  type FetchReleaseResult,
} from "@plannotator/shared/update-check";
import { startInboxServer, type InboxServer } from "./inbox";
import { autoUpdatePaths, thisLockMachine, type InstallerLaunch } from "./auto-update";

const T0 = Date.now();
let clock: number;
let dataDir: string;
let savedDataDir: string | undefined;
let savedCheck: string | undefined;
let gh: ReturnType<typeof Bun.serve>;
let page: () => Response;
let api: () => Response;
let pageRequests: number;
let launches: InstallerLaunch[];
const servers: InboxServer[] = [];

beforeEach(() => {
  clock = T0;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-stuck-")));
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  savedCheck = process.env.PLANNOTATOR_UPDATE_CHECK;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
  pageRequests = 0;
  launches = [];
  gh = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname.startsWith("/api/")) return api();
      pageRequests++;
      return page();
    },
  });
  api = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  gh.stop(true);
  forgetUnwrittenUpdateStateForTests(dataDir);
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (savedCheck === undefined) delete process.env.PLANNOTATOR_UPDATE_CHECK;
  else process.env.PLANNOTATOR_UPDATE_CHECK = savedCheck;
  rmSync(dataDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${gh.port}`;
const redirectTo = (version: string) => () =>
  new Response(null, { status: 302, headers: { location: `${base()}/backnotprop/plannotator/releases/tag/v${version}` } });
const captivePortal = () => new Response("<html>Sign in</html>", { status: 200 });

async function start(overrides: Parameters<typeof startInboxServer>[0] = {}, version = "0.28.30"): Promise<InboxServer> {
  const server = await startInboxServer({
    dataDir,
    version,
    binaryPath: null,
    healthTickMs: 30,
    updates: {
      now: () => clock,
      fetchReleasePage: () => fetchLatestFromPage(`${base()}/backnotprop/plannotator/releases/latest`),
      fetchRelease: () => fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`),
      fetchReleaseTag: async (v): Promise<FetchReleaseResult> => ({
        ok: true,
        release: { tag: `v${v}`, body: `## What's New in v${v}\n\nNotes for ${v}.\n\n## Install / Update\n` },
      }),
      isManaged: () => true,
      listSessions: () => [],
      launchInstaller: (launch) => {
        launches.push(launch);
      },
    },
    ...overrides,
  });
  servers.push(server);
  return server;
}

const health = async (server: InboxServer) =>
  ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json()) as { update: InboxUpdate | null }).update;
const list = async (server: InboxServer) =>
  (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json()) as {
    update: InboxUpdate | null;
    updated?: string | null;
    update_check_failing?: { since: string; error: string } | null;
  };
const details = async (server: InboxServer) =>
  (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/update`)).json()) as {
    command: string;
    failure: { exit_code: number; log: string } | null;
    check: { failing?: { since: string; error: string } | null };
  };

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

/** Move the injected clock, then wait for the Inbox's health tick to ask again. */
async function advance(ms: number) {
  const before = pageRequests;
  clock += ms;
  await waitFor(async () => pageRequests, (n) => n > before, 3000);
  await Bun.sleep(60);
}

describe("a long-running Inbox learns of a release on its own", () => {
  test("started before the release, never restarted or reloaded: Update shows within 10 minutes of the release", async () => {
    page = redirectTo("0.28.30");
    const server = await start();
    await waitFor(async () => pageRequests, (n) => n >= 1);
    expect(await health(server)).toBeNull();
    // Days pass (it checks every 10 minutes); then a release is published.
    for (let i = 0; i < 3; i++) await advance(RELEASE_CHECK_INTERVAL_MS);
    page = redirectTo("0.28.31");
    // Five minutes on: the cached answer is still fresh, no request yet.
    clock += 5 * 60_000;
    await Bun.sleep(150);
    expect(await health(server)).toBeNull();
    // At ten minutes the health tick asks, and the sidebar's Update shows (the event stream carries it).
    await advance(5 * 60_000);
    const update = await waitFor(() => health(server), (u) => u?.state === "available");
    expect(update).toMatchObject({ state: "available", version: "0.28.31", current: "0.28.30" });
  });

  test("the API rate-limited all along changes nothing: the page names the release", async () => {
    page = redirectTo("0.28.31");
    const server = await start();
    expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.version).toBe("0.28.31");
  });
});

describe("checking that fails for hours is shown, never silent", () => {
  test("a captive portal and a rate-limited API: after 3 hours the list carries it, and About gives the command", async () => {
    page = captivePortal;
    const server = await start();
    await waitFor(async () => pageRequests, (n) => n >= 1);
    expect((await list(server)).update_check_failing ?? null).toBeNull();
    while (clock - T0 < RELEASE_CHECK_FAILING_AFTER_MS) await advance(RELEASE_CHECK_RETRY_MS);
    const failing = (await waitFor(() => list(server), (l) => !!l.update_check_failing)).update_check_failing!;
    expect(failing.since).toBe(new Date(T0).toISOString());
    expect(failing.error).toBe("release page didn't answer as expected");
    const about = await details(server);
    expect(about.check.failing?.since).toBe(failing.since);
    expect(about.command).toContain("plannotator.ai/install.");
    // GitHub answers again: it goes, and the release shows.
    page = redirectTo("0.28.31");
    await advance(RELEASE_CHECK_RETRY_MS);
    const after = await waitFor(() => list(server), (l) => !l.update_check_failing && l.update?.state === "available");
    expect(after.update?.version).toBe("0.28.31");
  });

  test("a state file that cannot be written: the Inbox still checks (in memory) and shows the release", async () => {
    page = redirectTo("0.28.31");
    // update-state.json is a folder: every write of it fails.
    mkdirSync(join(dataDir, "update-state.json"));
    const server = await start();
    expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.version).toBe("0.28.31");
  });

  test("…and when GitHub fails too, it says checking fails after 3 hours, from memory", async () => {
    page = captivePortal;
    mkdirSync(join(dataDir, "update-state.json"));
    const server = await start();
    await waitFor(async () => pageRequests, (n) => n >= 1);
    while (clock - T0 < RELEASE_CHECK_FAILING_AFTER_MS) await advance(RELEASE_CHECK_RETRY_MS);
    const failing = (await waitFor(() => list(server), (l) => !!l.update_check_failing)).update_check_failing!;
    expect(failing.error).toBe("release page didn't answer as expected");
  });

  test("a failing run from before the machine slept is not shown before the next check runs", async () => {
    page = redirectTo("0.28.30");
    writeUpdateState(
      { releaseCheck: { attemptedAt: T0 - 15 * 60 * 60_000, failedAt: T0 - 15 * 60 * 60_000, failingSince: T0 - 20 * 60 * 60_000, error: "offline" } },
      dataDir,
    );
    const server = await start();
    expect((await list(server)).update_check_failing ?? null).toBeNull();
    await waitFor(async () => pageRequests, (n) => n >= 1);
    expect((await list(server)).update_check_failing ?? null).toBeNull();
  });

  test("update checks turned off: no failing state (the person chose it), and Check now still works", async () => {
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    page = captivePortal;
    const server = await start();
    clock += 4 * RELEASE_CHECK_FAILING_AFTER_MS;
    await Bun.sleep(150);
    expect((await list(server)).update_check_failing ?? null).toBeNull();
    page = redirectTo("0.28.31");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/update/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession }),
    });
    expect(((await res.json()) as { checked: { ok: boolean } }).checked.ok).toBe(true);
  });
});

describe("Updating… never spins for good", () => {
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", detached: true });
    await new Promise((r) => child.on("exit", r));
    return child.pid!;
  }

  test("the wrapper killed outright (or the machine restarted mid-install): Failed with the log and Try again, not Updating…", async () => {
    page = redirectTo("0.28.31");
    writeUpdateState({ pending: { version: "0.28.31", fromVersion: "0.28.30", startedAt: T0, by: "person" } }, dataDir);
    const lock = autoUpdatePaths(dataDir).lock;
    // The line the detached wrapper writes: its process group (gone) and this machine.
    const dead = await deadPid();
    const m = thisLockMachine();
    writeFileSync(lock, `pid=${dead} group=${dead} host=${m.host} boot=${m.boot} pidns=${m.pidns}\n`);
    const at = (Date.now() - 60_000) / 1000;
    utimesSync(lock, at, at);
    const server = await start();
    const update = await waitFor(() => health(server), (u) => u?.state === "failed");
    expect(update).toMatchObject({ state: "failed", version: "0.28.31" });
    expect((await details(server)).failure).toMatchObject({ exit_code: -1 });
    // Try again takes the lock.
    const retry = await fetch(`http://127.0.0.1:${server.port}/api/inbox/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession }),
    });
    expect(retry.status).toBe(200);
    expect(launches.map((l) => l.version)).toEqual(["v0.28.31"]);
  });

  test("a lock stamped hours in the future (the clock moved back) is not an install in progress", async () => {
    page = redirectTo("0.28.31");
    const lock = autoUpdatePaths(dataDir).lock;
    writeFileSync(lock, String(process.ppid));
    const future = (Date.now() + 5 * 60 * 60_000) / 1000;
    utimesSync(lock, future, future);
    const server = await start();
    expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.state).toBe("available");
  });
});

test("a Remind me tomorrow stamped while the clock was ahead hides the update a day at most", async () => {
  page = redirectTo("0.28.31");
  writeUpdateState({ snooze: { version: "0.28.31", until: T0 + 90 * 24 * 60 * 60_000 } }, dataDir);
  const server = await start();
  expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.version).toBe("0.28.31");
});

test("Update now → the new binary on disk → Restart → the new version's Inbox offers What's new", async () => {
  page = redirectTo("0.28.31");
  const binary = join(dataDir, "plannotator");
  writeFileSync(binary, "old");
  let onDisk = "0.28.30";
  let handedOver = false;
  const server = await start({
    binaryPath: binary,
    onRestartRequested: () => (handedOver = true),
    updates: {
      now: () => clock,
      fetchReleasePage: () => fetchLatestFromPage(`${base()}/backnotprop/plannotator/releases/latest`),
      fetchReleaseTag: async (v): Promise<FetchReleaseResult> => ({
        ok: true,
        release: { tag: `v${v}`, body: `## What's New in v${v}\n\nNotes for ${v}.\n\n## Install / Update\n` },
      }),
      isManaged: () => true,
      listSessions: () => [],
      probeVersion: async () => onDisk,
      launchInstaller: (launch) => {
        launches.push(launch);
        // The install script replaces the binary.
        onDisk = "0.28.31";
        writeFileSync(binary, "new binary");
      },
    },
  });
  await waitFor(() => health(server), (u) => u?.state === "available");
  const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession }),
  });
  expect(res.status).toBe(200);
  // The wrapper finished (it releases the lock); the probe sees the new binary: Ready.
  rmSync(autoUpdatePaths(dataDir).lock, { force: true });
  expect((await waitFor(() => health(server), (u) => u?.state === "ready"))?.version).toBe("0.28.31");
  expect(
    (
      await fetch(`http://127.0.0.1:${server.port}/api/inbox/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: server.serverSession }),
      })
    ).status,
  ).toBe(200);
  await waitFor(async () => handedOver, (v) => v);
  servers.splice(servers.indexOf(server), 1);
  // The new binary starts on the same data dir.
  const next = await start({}, "0.28.31");
  const model = await waitFor(() => list(next), (l) => l.updated === "0.28.31");
  expect(model.updated).toBe("0.28.31");
  expect(model.update).toBeNull();
});

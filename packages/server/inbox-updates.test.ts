/**
 * The Inbox's update control against a real Inbox server: the daily check
 * (stubbed fetch, never GitHub), the button's states on health, Update now
 * (a recording launcher, never the install script), Remind me tomorrow, the
 * Settings switches (the dialog's "Install new versions automatically"
 * checkbox writes autoUpdate), What's new, and the pure state rules.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { readUpdateState, writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";
import { startInboxServer, type InboxServer } from "./inbox";
import { deriveInboxUpdate } from "./inbox-updates";
import type { InstallerLaunch } from "./auto-update";

const NOW = Date.now();
const BODY = [
  "| [v0.28.11](https://x/v0.28.11) | Inbox over your tailnet |",
  "| [v0.28.10](https://x/v0.28.10) | Older |",
  "",
  "## What's New in v0.28.12",
  "",
  "A patch release for the Inbox.",
  "",
  "## Install / Update",
].join("\n");

let dataDir: string;
let savedDataDir: string | undefined;
let savedCheck: string | undefined;
let savedAuto: string | undefined;
let fetches: number;
let launches: InstallerLaunch[];
const servers: InboxServer[] = [];

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-updates-")));
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  savedCheck = process.env.PLANNOTATOR_UPDATE_CHECK;
  savedAuto = process.env.PLANNOTATOR_AUTO_UPDATE;
  // config.json and the sessions registry are read from the data dir env.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
  delete process.env.PLANNOTATOR_AUTO_UPDATE;
  fetches = 0;
  launches = [];
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (savedCheck === undefined) delete process.env.PLANNOTATOR_UPDATE_CHECK;
  else process.env.PLANNOTATOR_UPDATE_CHECK = savedCheck;
  if (savedAuto === undefined) delete process.env.PLANNOTATOR_AUTO_UPDATE;
  else process.env.PLANNOTATOR_AUTO_UPDATE = savedAuto;
  rmSync(dataDir, { recursive: true, force: true });
});

const latest = (tag = "v0.28.12"): (() => Promise<FetchReleaseResult>) => async () => {
  fetches++;
  return { ok: true, release: { tag, publishedAt: "2026-10-11T00:00:00Z", body: BODY } };
};

async function start(overrides: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({
    dataDir,
    version: "0.28.10",
    binaryPath: null,
    healthTickMs: 40,
    updates: {
      fetchRelease: latest(),
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

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await Bun.sleep(25);
    value = await read();
  }
  return value;
}

const post = (server: InboxServer, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("the sidebar button", () => {
  test("appears as soon as an update is AVAILABLE (a newer release, nothing installed), from one check", async () => {
    const server = await start();
    const update = await waitFor(() => health(server), (u) => u !== null);
    expect(update).toMatchObject({ available: true, state: "available", version: "0.28.12", current: "0.28.10", action: "script" });
    // Many health ticks later, GitHub was asked once.
    await Bun.sleep(200);
    expect(fetches).toBe(1);
    // The list model carries the same, for the page's first paint.
    const list = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json();
    expect(list.update).toMatchObject({ state: "available", version: "0.28.12" });
  });

  test("off (config): no request, no button", async () => {
    saveConfig({ updateCheck: false });
    const server = await start();
    await Bun.sleep(200);
    expect(await health(server)).toBeNull();
    expect(fetches).toBe(0);
  });

  test("off (env) wins over config", async () => {
    saveConfig({ updateCheck: true });
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    const server = await start();
    await Bun.sleep(200);
    expect(await health(server)).toBeNull();
    expect(fetches).toBe(0);
  });

  test("a dev build shows nothing and asks nobody", async () => {
    const server = await start({ version: "dev" });
    await Bun.sleep(200);
    expect(await health(server)).toBeNull();
    expect(fetches).toBe(0);
  });

  test("a binary the install script does not manage: available, with the command instead of Update now", async () => {
    const server = await start({
      updates: { fetchRelease: latest(), isManaged: () => false, listSessions: () => [], launchInstaller: (l) => void launches.push(l) },
    });
    expect(await waitFor(() => health(server), (u) => u !== null)).toMatchObject({ state: "available", action: "copy" });
    const refused = await post(server, "/api/inbox/update");
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("update_unmanaged");
    expect(launches).toHaveLength(0);
  });
});

describe("Update now", () => {
  test("runs the install script once; a second press while it runs is refused", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    const first = await post(server, "/api/inbox/update");
    expect(first.status).toBe(200);
    expect((await first.json()).update).toMatchObject({ state: "updating", version: "0.28.12" });
    const second = await post(server, "/api/inbox/update");
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("update_locked");
    expect(launches.map((l) => l.version)).toEqual(["v0.28.12"]);
    expect(readUpdateState(dataDir).pending).toMatchObject({ version: "0.28.12", by: "person" });
  });

  test("a cross-site page cannot start it", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    expect((await post(server, "/api/inbox/update", {}, { Origin: "https://evil.example" })).status).toBe(403);
    expect(launches).toHaveLength(0);
  });

  test("an install the person started that failed shows Update failed; a background one does not", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.12", fetchedAt: NOW }, pending: { version: "0.28.12", fromVersion: "0.28.10", startedAt: NOW } }, dataDir);
    writeFileSync(join(dataDir, "update-result.json"), JSON.stringify({ version: "v0.28.12", exitCode: 1 }));
    const background = await start();
    expect(await waitFor(() => health(background), (u) => u !== null)).toMatchObject({ state: "available" });
    background.stop();
    writeUpdateState({ ...readUpdateState(dataDir), pending: { version: "0.28.12", fromVersion: "0.28.10", startedAt: NOW, by: "person" } }, dataDir);
    const person = await start();
    expect(await waitFor(() => health(person), (u) => u !== null)).toMatchObject({ state: "failed", version: "0.28.12" });
    const details = await (await fetch(`http://127.0.0.1:${person.port}/api/inbox/update`)).json();
    expect(details.failure).toMatchObject({ exit_code: 1 });
  });
});

describe("Remind me tomorrow, Settings, What's new", () => {
  test("Remind me tomorrow hides the button for this version, server-side", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    expect((await post(server, "/api/inbox/update/snooze")).status).toBe(200);
    expect(await health(server)).toBeNull();
    expect(readUpdateState(dataDir).snooze?.version).toBe("0.28.12");
  });

  test("the dialog's checkbox writes autoUpdate to config.json; the notices switch writes updateCheck", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    const saved = await post(server, "/api/inbox/settings", { auto_update: true });
    expect(saved.status).toBe(200);
    expect((await saved.json()).updates.auto_update).toEqual({ on: true, env: null });
    expect(loadConfig().autoUpdate).toBe(true);
    expect((await post(server, "/api/inbox/settings", { auto_update: "yes" })).status).toBe(422);
    expect((await post(server, "/api/inbox/settings", { update_check: false })).status).toBe(200);
    expect(loadConfig().updateCheck).toBe(false);
    expect(await health(server)).toBeNull();
  });

  test("What's new: the notes, and the releases skipped in between", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    const notes = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=0.28.12`)).json();
    expect(notes).toMatchObject({ version: "0.28.12", current: "0.28.10", notes: "A patch release for the Inbox." });
    expect(notes.skipped.map((h: { version: string }) => h.version)).toEqual(["0.28.11"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=../x`)).status).toBe(404);
  });

  test("the first start on a newer version than the last one offers What's new for that run", async () => {
    writeUpdateState({ inboxVersion: "0.28.9" }, dataDir);
    const server = await start();
    const list = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json();
    expect(list.updated).toBe("0.28.10");
    server.stop();
    const again = await start();
    expect((await (await fetch(`http://127.0.0.1:${again.port}/api/inbox/threads`)).json()).updated).toBeNull();
  });
});

describe("deriveInboxUpdate", () => {
  const base = {
    current: "0.28.10",
    onDisk: null,
    checksOn: true,
    managed: true,
    lockHeld: false,
    state: { latestRelease: { tag: "0.28.12", fetchedAt: NOW } },
    result: null,
    now: NOW,
  };
  test("ready beats updating beats failed beats available", () => {
    expect(deriveInboxUpdate(base)?.state).toBe("available");
    expect(deriveInboxUpdate({ ...base, lockHeld: true })?.state).toBe("updating");
    expect(deriveInboxUpdate({ ...base, lockHeld: true, onDisk: "0.28.12" })).toMatchObject({ state: "ready", version: "0.28.12" });
  });
  test("nothing when up to date, checks off, or snoozed for this version", () => {
    expect(deriveInboxUpdate({ ...base, current: "0.28.12" })).toBeNull();
    expect(deriveInboxUpdate({ ...base, checksOn: false })).toBeNull();
    expect(deriveInboxUpdate({ ...base, state: { ...base.state, snooze: { version: "0.28.12", until: NOW + 1 } } })).toBeNull();
    expect(deriveInboxUpdate({ ...base, state: { ...base.state, snooze: { version: "0.28.12", until: NOW - 1 } } })?.state).toBe("available");
  });
  test("ready even with checks off: a newer binary is already installed", () => {
    expect(deriveInboxUpdate({ ...base, checksOn: false, onDisk: "0.28.12" })?.state).toBe("ready");
  });
});

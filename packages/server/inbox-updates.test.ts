/**
 * The Inbox's update control against a real Inbox server: the daily check
 * (stubbed fetch, never GitHub), the button's states on health, Update now
 * (a recording launcher, never the install script), Remind me tomorrow, the
 * Settings switches (the dialog's "Install new versions automatically"
 * checkbox writes autoUpdate), What's new, and the pure state rules.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { readUpdateState, writeReleaseNotes, writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUsedBefore, startInboxServer, type InboxServer } from "./inbox";
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

/** A release by its tag, with notes (the What's new link's fetch). */
const tagged = (): ((version: string) => Promise<FetchReleaseResult>) => async (version) => ({
  ok: true,
  release: { tag: `v${version}`, body: `## What's New in v${version}\n\nNotes for ${version}.\n\n## Install / Update\n` },
});

async function start(overrides: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({
    dataDir,
    version: "0.28.10",
    binaryPath: null,
    healthTickMs: 40,
    updates: {
      fetchRelease: latest(),
      fetchReleaseTag: tagged(),
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

  test("a tab left open on an older Inbox (another serverSession) gets 409 and starts nothing", async () => {
    const server = await start();
    await waitFor(() => health(server), (u) => u !== null);
    for (const path of ["/api/inbox/update", "/api/inbox/update/snooze", "/api/inbox/update/check"]) {
      const res = await post(server, path, { serverSession: "0".repeat(32) });
      expect([path, res.status, (await res.json()).code]).toEqual([path, 409, "session_mismatch"]);
    }
    expect(launches).toHaveLength(0);
    expect(readUpdateState(dataDir).snooze).toBeUndefined();
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

describe("What's new for a version installed outside the Inbox (no notes saved)", () => {
  // A fake release API on loopback, reached the way the Inbox reaches GitHub
  // (PLANNOTATOR_UPDATE_API_URL), so the default tag fetch runs for real.
  let api: ReturnType<typeof Bun.serve>;
  let tagRequests: string[];
  let answer: (version: string) => Response | Promise<Response>;
  let savedUrl: string | undefined;

  beforeEach(() => {
    tagRequests = [];
    answer = (version) =>
      Response.json({ tag_name: `v${version}`, body: `## What's New in v${version}\n\nWhat ${version} brings.\n\n## Install / Update\n` });
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const m = /\/releases\/tags\/v(\d+\.\d+\.\d+)$/.exec(path);
        if (!m) return new Response("not found", { status: 404 });
        tagRequests.push(m[1]!);
        return answer(m[1]!);
      },
    });
    savedUrl = process.env.PLANNOTATOR_UPDATE_API_URL;
    process.env.PLANNOTATOR_UPDATE_API_URL = `http://127.0.0.1:${api.port}/releases/latest`;
    // The Inbox ran 0.28.9 before; this run is 0.28.10, installed by the script run by hand.
    writeUpdateState({ inboxVersion: "0.28.9" }, dataDir);
  });

  afterEach(() => {
    api.stop(true);
    if (savedUrl === undefined) delete process.env.PLANNOTATOR_UPDATE_API_URL;
    else process.env.PLANNOTATOR_UPDATE_API_URL = savedUrl;
  });

  /** The real tag fetch (no fetchReleaseTag stub). */
  const startReal = (extra: { whatsNewWaitMs?: number } = {}) =>
    start({
      updates: { fetchRelease: latest(), isManaged: () => true, listSessions: () => [], launchInstaller: () => {}, ...extra },
    });
  const listUpdated = async (server: InboxServer) =>
    ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json()) as { updated: string | null }).updated;
  const whatsNew = (server: InboxServer, version: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=${version}`);

  test("the link shows, and the page gets the notes fetched by the release's tag, asked once", async () => {
    const server = await startReal();
    expect(await listUpdated(server)).toBe("0.28.10");
    const res = await whatsNew(server, "0.28.10");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: "0.28.10", current: "0.28.10", notes: "What 0.28.10 brings." });
    expect((await whatsNew(server, "0.28.10")).status).toBe(200);
    expect(tagRequests).toEqual(["0.28.10"]);
    expect(await listUpdated(server)).toBe("0.28.10");
  });

  test("update checks off and no notes saved: no link, no request", async () => {
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    const server = await startReal();
    expect(await listUpdated(server)).toBeNull();
    const res = await whatsNew(server, "0.28.10");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("notes_not_found");
    await Bun.sleep(150); // a few health ticks
    expect(tagRequests).toEqual([]);
  });

  test("update checks off but the notes are saved: the link shows", async () => {
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    writeReleaseNotes({ version: "0.28.10", notes: "Saved before.", highlights: [] }, dataDir);
    const server = await startReal();
    expect(await listUpdated(server)).toBe("0.28.10");
    expect((await (await whatsNew(server, "0.28.10")).json()).notes).toBe("Saved before.");
    expect(tagRequests).toEqual([]);
  });

  test("the fetch fails: the link goes away and the page is not asked to wait for nothing", async () => {
    answer = () => new Response("rate limited", { status: 403 });
    const server = await startReal();
    expect(await waitFor(() => listUpdated(server), (v) => v === null)).toBeNull();
    expect((await whatsNew(server, "0.28.10")).status).toBe(404);
    // One attempt, then the 6 h back-off: the tick and the route ask no more.
    await Bun.sleep(150);
    expect(tagRequests).toEqual(["0.28.10"]);
  });

  test("a slow answer: the route says notes_loading, and the next ask gets the notes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    answer = async (version) => {
      await gate;
      return Response.json({ tag_name: `v${version}`, body: `## What's New in v${version}\n\nLate notes.\n` });
    };
    const server = await startReal({ whatsNewWaitMs: 50 });
    const first = await whatsNew(server, "0.28.10");
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    expect((await first.json()).code).toBe("notes_loading");
    release();
    const later = await waitFor(
      async () => (await whatsNew(server, "0.28.10")).status,
      (status) => status === 200,
    );
    expect(later).toBe(200);
    expect(tagRequests).toEqual(["0.28.10"]);
  });

  test("notes saved without a What's New part (before the release body was edited) are fetched again", async () => {
    writeReleaseNotes({ version: "0.28.10", notes: "", highlights: [] }, dataDir);
    const server = await startReal();
    expect(await listUpdated(server)).toBe("0.28.10");
    expect((await (await whatsNew(server, "0.28.10")).json()).notes).toBe("What 0.28.10 brings.");
    expect(tagRequests).toEqual(["0.28.10"]);
  });

  test("a version this Inbox has no reason to show is never fetched", async () => {
    const server = await startReal();
    expect((await whatsNew(server, "0.27.1")).status).toBe(404);
    await whatsNew(server, "0.28.10");
    expect(tagRequests).toEqual(["0.28.10"]);
  });
});

describe("the question sound (config.json inboxSound)", () => {
  const settingsOf = async (server: InboxServer) => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()).sound;
  const postJson = (server: InboxServer, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const claim = async (server: InboxServer) => (await (await postJson(server, "/api/inbox/sound/dialog", { serverSession: server.serverSession })).json()).show;

  test("on at 60 unless set; saved field by field; anything else refused with nothing written", async () => {
    writeUpdateState({ inboxVersion: "0.28.9" }, dataDir);
    const server = await start();
    expect(await settingsOf(server)).toEqual({ enabled: true, volume: 60, dialog_shown_for: null, dialog_due: true });
    for (const bad of [
      { enabled: "yes" },
      { volume: 0 },
      { volume: 5 },
      { volume: 101 },
      { volume: 55.5 },
      { volume: "60" },
      { dialog_shown_for: "0.28.10" },
      { dialog_due: false },
      { ring: true },
      [true],
    ]) {
      const refused = await postJson(server, "/api/inbox/settings", { serverSession: server.serverSession, sound: bad });
      expect([JSON.stringify(bad), refused.status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect(loadConfig().inboxSound).toEqual({ dialogDueFor: "0.28.10" });
    const saved = await postJson(server, "/api/inbox/settings", { serverSession: server.serverSession, sound: { volume: 30 } });
    expect((await saved.json()).sound).toEqual({ enabled: true, volume: 30, dialog_shown_for: null, dialog_due: true });
    await postJson(server, "/api/inbox/settings", { serverSession: server.serverSession, sound: { enabled: false } });
    expect(await settingsOf(server)).toEqual({ enabled: false, volume: 30, dialog_shown_for: null, dialog_due: true });
    expect(loadConfig().inboxSound).toEqual({ dialogDueFor: "0.28.10", volume: 30, enabled: false });
  });

  test("after an update the dialog is claimed once: of two tabs asking together one shows it, and a reload never does", async () => {
    writeUpdateState({ inboxVersion: "0.28.9" }, dataDir);
    const server = await start();
    const answers = await Promise.all([claim(server), claim(server)]);
    expect(answers.sort()).toEqual([false, true]);
    expect(loadConfig().inboxSound).toEqual({ dialogShownFor: "0.28.10" });
    expect((await settingsOf(server)).dialog_due).toBe(false);
    expect(await claim(server)).toBe(false);
    // The choice the page makes later keeps the mark.
    await postJson(server, "/api/inbox/settings", { serverSession: server.serverSession, sound: { enabled: false } });
    expect(loadConfig().inboxSound).toEqual({ dialogShownFor: "0.28.10", enabled: false });
    // A stale tab (another server's session) is refused before anything is claimed.
    expect((await postJson(server, "/api/inbox/sound/dialog", { serverSession: "stale" })).status).toBe(409);
  });

  test("due survives a start that ended before any window opened; once claimed it never comes back", async () => {
    writeUpdateState({ inboxVersion: "0.28.9" }, dataDir);
    const first = await start();
    expect((await settingsOf(first)).dialog_due).toBe(true);
    first.stop();
    // The same version starts again: no update this run, but the dialog still waits for a page.
    const second = await start();
    expect((await (await fetch(`http://127.0.0.1:${second.port}/api/inbox/threads`)).json()).updated).toBeNull();
    expect((await settingsOf(second)).dialog_due).toBe(true);
    expect(await claim(second)).toBe(true);
    second.stop();
    const third = await start();
    expect((await settingsOf(third)).dialog_due).toBe(false);
    expect(await claim(third)).toBe(false);
    third.stop();
    const later = await start({ version: "0.28.12" });
    expect(await claim(later)).toBe(false);
    expect(loadConfig().inboxSound).toEqual({ dialogShownFor: "0.28.10" });
  });

  test("someone who used a 0.28.7–0.28.11 Inbox (no recorded version, but its registry and a project) gets the dialog", async () => {
    // An Inbox from before versions were recorded: the registry it wrote and a project in its store.
    const old = await start({ version: "dev" });
    old.stop();
    InboxStore.open(dataDir).ensureProject({ name: "billing-svc", root: dataDir });
    expect(readUpdateState(dataDir).inboxVersion).toBeUndefined();
    const server = await start();
    expect((await settingsOf(server)).dialog_due).toBe(true);
    expect(await claim(server)).toBe(true);
  });

  test("a fresh install marks it shown at start: no dialog now, and none after a later update", async () => {
    const first = await start();
    expect((await settingsOf(first)).dialog_shown_for).toBe("0.28.10");
    expect(await claim(first)).toBe(false);
    first.stop();
    const updated = await start({ version: "0.28.12" });
    expect((await (await fetch(`http://127.0.0.1:${updated.port}/api/inbox/threads`)).json()).updated).toBe("0.28.12");
    expect(await claim(updated)).toBe(false);
    expect(loadConfig().inboxSound).toEqual({ dialogShownFor: "0.28.10" });
  });

  test("no update this run: nothing to claim", async () => {
    writeUpdateState({ inboxVersion: "0.28.10" }, dataDir);
    const server = await start();
    expect(await claim(server)).toBe(false);
    expect(loadConfig().inboxSound).toBeUndefined();
  });
});

describe("inboxUsedBefore", () => {
  test("any one piece of evidence an earlier Inbox left is enough; none is a fresh install", () => {
    expect(inboxUsedBefore(dataDir)).toBe(false);
    const evidence: [string, () => void][] = [
      ["a recorded version", () => writeUpdateState({ inboxVersion: "0.28.12" }, dataDir)],
      ["the registry", () => {
        mkdirSync(join(dataDir, "inbox"), { recursive: true });
        writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
      }],
      ["a project", () => mkdirSync(join(dataDir, "inbox", "projects", "billing-svc-abc123"), { recursive: true })],
      ["the notification settings", () => saveConfig({ inboxNotifications: { dismissed: true } })],
      ["the inbox tool switch", () => saveConfig({ inboxTool: { pi: true } })],
    ];
    for (const [what, leave] of evidence) {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      leave();
      expect([what, inboxUsedBefore(dataDir)]).toEqual([what, true]);
    }
    // An empty projects folder (an Inbox that opened its store and never saw an agent) is not evidence on its own.
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(join(dataDir, "inbox", "projects"), { recursive: true });
    expect(inboxUsedBefore(dataDir)).toBe(false);
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

/**
 * PLANNOTATOR_UPDATE_CHECK=0 stops only the automatic checks, never the
 * person's own way to update (the owner: "we never leave user installs in a
 * state they can't update from"). An Inbox started with checks off showed
 * "0.28.39 is available" in Settings → General with no Update button: Check
 * now fetched the release, but the button's model stayed null.
 *
 * A real Inbox server with an injected clock, a fake GitHub on loopback and a
 * stub installer: never GitHub, never the install script. HOME and the data
 * dir are temp folders.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import {
  fetchLatestFromPage,
  fetchLatestRelease,
  forgetUnwrittenUpdateStateForTests,
  RELEASE_CHECK_INTERVAL_MS,
  writeUpdateState,
} from "@plannotator/shared/update-check";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";
import type { InstallerLaunch } from "./auto-update";

const ENV_KEYS = ["HOME", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_INBOX_CONNECT", "PLANNOTATOR_BROWSER"] as const;
const T0 = Date.now();
let clock: number;
let root: string;
let dataDir: string;
let saved: { [key: string]: string | undefined };
let gh: ReturnType<typeof Bun.serve>;
let latestTag: string;
let ghRequests: number;
let ghDown: boolean;
let tagRequests: string[];
let launches: InstallerLaunch[];
const servers: InboxServer[] = [];

beforeEach(() => {
  clock = T0;
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-checks-off-")));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  mkdirSync(join(root, "home"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = join(root, "home");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_UPDATE_CHECK = "0";
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  latestTag = "0.28.39";
  ghRequests = 0;
  ghDown = false;
  tagRequests = [];
  launches = [];
  // The fake GitHub: the "latest release" redirect and the API, counted.
  gh = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      ghRequests++;
      if (ghDown) return new Response("unavailable", { status: 503 });
      if (new URL(req.url).pathname.startsWith("/api/")) return Response.json({ tag_name: `v${latestTag}`, body: "" });
      return new Response(null, { status: 302, headers: { location: `${base()}/backnotprop/plannotator/releases/tag/v${latestTag}` } });
    },
  });
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  gh.stop(true);
  forgetUnwrittenUpdateStateForTests(dataDir);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${gh.port}`;

async function start(): Promise<InboxServer> {
  const server = await startInboxServer({
    dataDir,
    version: "0.28.38",
    binaryPath: null,
    healthTickMs: 30,
    updates: {
      now: () => clock,
      fetchReleasePage: () => fetchLatestFromPage(`${base()}/backnotprop/plannotator/releases/latest`),
      fetchRelease: () => fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`),
      fetchReleaseTag: async (v) => {
        tagRequests.push(v);
        return { ok: true, release: { tag: `v${v}`, body: `## What's New in v${v}\n\nNotes for ${v}.\n\n## Install / Update\n` } };
      },
      isManaged: () => true,
      listSessions: () => [],
      launchInstaller: (launch) => {
        launches.push(launch);
      },
    },
  });
  servers.push(server);
  return server;
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const health = async (server: InboxServer) =>
  ((await (await fetch(url(server, "/api/inbox/health"))).json()) as { update: InboxUpdate | null }).update;
const post = (server: InboxServer, path: string) =>
  fetch(url(server, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession }),
  });

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

describe("update checks off (PLANNOTATOR_UPDATE_CHECK=0)", () => {
  test("the Inbox never asks GitHub on its own: not at start, not on a page load, not on its tick", async () => {
    const server = await start();
    await fetch(url(server, "/"));
    clock += 3 * RELEASE_CHECK_INTERVAL_MS;
    await Bun.sleep(200);
    expect(ghRequests).toBe(0);
    expect(tagRequests).toEqual([]);
    expect(await health(server)).toBeNull();
  });

  test("Check now → Update to the newer release is offered → Update runs the installer for exactly that tag", async () => {
    const server = await start();
    await Bun.sleep(100);
    expect(await health(server)).toBeNull();

    // Check now asks (the person's click), even with checks off.
    const checked = (await (await post(server, "/api/inbox/update/check")).json()) as {
      checked: { ok: boolean };
      latest: { version: string } | null;
      update: InboxUpdate | null;
      check: { on: boolean; env: boolean | null };
    };
    expect(checked.checked.ok).toBe(true);
    expect(ghRequests).toBeGreaterThan(0);
    expect(checked.latest?.version).toBe("0.28.39");
    expect(checked.check).toMatchObject({ on: false, env: false });
    // The bug: "0.28.39 is available" with nothing to press. Now the Update is offered,
    // in the details Settings reads and in health, which the sidebar's button reads.
    expect(checked.update).toMatchObject({ state: "available", version: "0.28.39", current: "0.28.38", action: "script" });
    expect(await health(server)).toMatchObject({ state: "available", version: "0.28.39" });
    // Its What's new link has notes behind it: Check now fetched them too.
    const notes = await waitFor(
      () => fetch(url(server, "/api/inbox/whats-new?version=0.28.39")).then((r) => r.json() as Promise<{ notes?: string }>),
      (n) => !!n.notes,
    );
    expect(notes.notes).toContain("Notes for 0.28.39.");
    expect(tagRequests).toEqual(["0.28.39"]);

    // Update: the same verified install path as with checks on (startManualUpdate).
    const res = await post(server, "/api/inbox/update");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe("0.28.39");
    expect(launches.map((l) => l.version)).toEqual(["v0.28.39"]);
    expect((await waitFor(() => health(server), (u) => u?.state === "updating"))?.state).toBe("updating");
  });

  test("a release known from a check before checks were turned off: Update offered at start, with no request", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.39", fetchedAt: T0 - 60 * 60_000 } }, dataDir);
    const server = await start();
    expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.version).toBe("0.28.39");
    expect(ghRequests).toBe(0);
    expect(tagRequests).toEqual([]);
    expect((await post(server, "/api/inbox/update")).status).toBe(200);
    expect(launches.map((l) => l.version)).toEqual(["v0.28.39"]);
  });

  test("Update with checks off asks GitHub once first and installs the newest answer, not a weeks-old cached release", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.39", fetchedAt: T0 - 30 * 24 * 60 * 60_000 } }, dataDir);
    latestTag = "0.28.41";
    const server = await start();
    expect((await waitFor(() => health(server), (u) => u?.state === "available"))?.version).toBe("0.28.39");
    expect(ghRequests).toBe(0);
    const res = await post(server, "/api/inbox/update");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe("0.28.41");
    expect(ghRequests).toBeGreaterThan(0);
    expect(launches.map((l) => l.version)).toEqual(["v0.28.41"]);
  });

  test("and when that check fails (offline), Update installs the release already known", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.39", fetchedAt: T0 - 30 * 24 * 60 * 60_000 } }, dataDir);
    ghDown = true;
    const server = await start();
    await waitFor(() => health(server), (u) => u?.state === "available");
    const res = await post(server, "/api/inbox/update");
    expect(res.status).toBe(200);
    expect(ghRequests).toBeGreaterThan(0);
    expect(launches.map((l) => l.version)).toEqual(["v0.28.39"]);
  });

  test("Remind me tomorrow still hides it, the same as with checks on", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.39", fetchedAt: T0 - 60_000 } }, dataDir);
    const server = await start();
    await waitFor(() => health(server), (u) => u?.state === "available");
    expect((await post(server, "/api/inbox/update/snooze")).status).toBe(200);
    expect(await health(server)).toBeNull();
  });

  test("Check now that finds nothing newer offers nothing", async () => {
    latestTag = "0.28.38";
    const server = await start();
    const checked = (await (await post(server, "/api/inbox/update/check")).json()) as { checked: { ok: boolean }; update: InboxUpdate | null };
    expect(checked.checked.ok).toBe(true);
    expect(checked.update).toBeNull();
    expect(launches).toEqual([]);
  });
});

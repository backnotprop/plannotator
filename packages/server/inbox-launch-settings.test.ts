/** Settings → Agents' read of how a launch would start (`GET /api/inbox/launch/settings`) and its launch switch, on a real launch module over a temp data dir and home. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { createInboxCompose } from "./inbox-compose";
import { createInboxLiveSessions } from "./inbox-sessions";
import { claudeBypassSetup, createAgentEnvironmentFor } from "./inbox-agents";

const restore: (() => void)[] = [];
const OWNER = "owner@example.com";
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function setup(options: { shellSkips?: boolean; claude?: Record<string, unknown>; claudeLocal?: Record<string, unknown>; claudeJson?: Record<string, unknown>; fullPermissions?: boolean; enabled?: boolean | null; platform?: NodeJS.Platform } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-settings-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  const enabled = options.enabled === null ? {} : { enabled: options.enabled ?? true };
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { ...enabled, ...(options.fullPermissions === undefined ? {} : { fullPermissions: options.fullPermissions }) } }));
  if (options.claude) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(options.claude));
  if (options.claudeLocal) writeFileSync(join(home, ".claude", "settings.local.json"), JSON.stringify(options.claudeLocal));
  if (options.claudeJson) writeFileSync(join(home, ".claude.json"), JSON.stringify(options.claudeJson));
  const store = InboxStore.open(dataDir);
  const reads = { count: 0 };
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: options.platform ?? "darwin",
    loginEnv: async () => {
      reads.count++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { HOME: home, PATH: "", ...(options.shellSkips ? { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: "1" } : {}) };
    },
    ownEnv: () => ({ HOME: home }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    isGuest: (req, via) => via === "tailnet" && req.headers.get("tailscale-user-login") !== OWNER,
  });
  restore.push(() => launch.stop());
  const get = async (headers: Record<string, string> = {}, via = "local", query = "") => {
    const response = await launch.route(new Request(`http://127.0.0.1:4000/api/inbox/launch/settings${query}`, { headers: { host: "127.0.0.1:4000", ...headers } }), "/api/inbox/launch/settings", via);
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  const call = async (path: string, init: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}, via = "local") => {
    const request = new Request(`http://127.0.0.1:4000${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { host: "127.0.0.1:4000", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const response = await launch.route(request, new URL(request.url).pathname, via);
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}, via = "local") => call("/api/inbox/launch/settings", { body, headers }, via);
  const saved = () => (JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxLaunch: Record<string, unknown> }).inboxLaunch;
  return { get, post, call, saved, reads, launch, home, store };
}

describe("Start agents from New message (config.json `inboxLaunch.enabled`)", () => {
  test("no `enabled` key is on; an explicit false is off, where only the settings route answers and no shell is read", async () => {
    const absent = setup({ enabled: null });
    expect(absent.launch.enabled()).toBe(true);
    expect((await absent.get()).body.launch).toMatchObject({ enabled: true });
    expect(await absent.launch.composeBlock()).toBeDefined();

    const off = setup({ enabled: false, fullPermissions: true });
    expect(off.launch.enabled()).toBe(false);
    expect(await off.launch.composeBlock()).toBeUndefined();
    expect(await off.get()).toEqual({ status: 200, body: { launch: { enabled: false, full_permissions: false } } });
    expect(off.reads.count).toBe(0);
    expect(await off.call("/api/inbox/launch/folders?path=~")).toMatchObject({ status: 404, body: { code: "launch_off" } });
    expect(await off.post({ full_permissions: false })).toMatchObject({ status: 404, body: { code: "launch_off" } });
    expect(await off.post({ scratch_dir: null })).toMatchObject({ status: 404, body: { code: "launch_off" } });
    expect(off.saved()).toEqual({ enabled: false, fullPermissions: true });
  });

  test("the switch writes config.json, keeps the other launch settings, and launch follows at once both ways", async () => {
    const world = setup({ enabled: null, fullPermissions: false });
    const off = await world.post({ enabled: false });
    expect(off).toEqual({ status: 200, body: { launch: { enabled: false, full_permissions: false } } });
    expect(world.saved()).toEqual({ fullPermissions: false, enabled: false });
    expect(world.launch.enabled()).toBe(false);
    expect(await world.launch.composeBlock()).toBeUndefined();

    const on = await world.post({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.launch).toMatchObject({ enabled: true, full_permissions: false });
    expect(world.saved()).toEqual({ fullPermissions: false, enabled: true });
    expect(world.launch.enabled()).toBe(true);
    expect(await world.launch.composeBlock()).toBeDefined();
    expect((await world.post({ full_permissions: true })).status).toBe(200);
  });

  test("off, it refuses only new starts: an agent already started keeps Stop, Delete, Try again, Trust, Open and its permission hook", async () => {
    const off = setup({ enabled: false });
    const id = `lch_${"0".repeat(26)}`;
    for (const action of ["stop", "delete", "retry", "trust", "open"]) {
      const answered = await off.call(`/api/inbox/launch/${id}/${action}`, { body: {} }).then(
        (r) => r.body.code,
        (e: { code?: string }) => e.code,
      );
      expect(answered).not.toBe("launch_off");
    }
    const hook = await off.launch
      .permissionRoute(new Request(`http://127.0.0.1:4000/api/inbox/launch/${id}/permission`, { method: "POST", body: "{}" }), `/api/inbox/launch/${id}/permission`)
      .then(
        async (r) => ((await r!.json()) as { code?: string }).code,
        (e: { code?: string }) => e.code,
      );
    expect(hook).not.toBe("launch_off");
  });

  test("a Send that starts an agent while off is refused in words that say whose switch it is", async () => {
    const off = setup({ enabled: false });
    const live = createInboxLiveSessions({ store: off.store, serverSession: "srv", resolveRoot: async (path) => path });
    const compose = createInboxCompose({
      store: off.store,
      serverSession: "srv",
      live,
      resolveProject: async () => {
        throw new Error("never reached");
      },
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      launch: off.launch,
    });
    const send = (key: string, door: Parameters<typeof compose.route>[4]) => {
      const url = new URL("http://127.0.0.1:4000/api/inbox/messages");
      const body = { idempotency_key: key, body: "Fix the retries.", to: { launch: { agent: "claude-code", project_id: "prj_x" } } };
      const req = new Request(url, { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify(body) });
      return compose.route(req, url, true, "local", door).then(
        () => null,
        (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
      );
    };
    expect(await send("k-here", null)).toEqual({ code: "launch_off", message: "Starting agents from the Inbox is off. Turn it on in Settings → Agents." });
    expect(await send("k-there", { machine: true, window: true, from: { machine: "mch_a", name: "MacBook" } })).toEqual({
      code: "launch_off",
      message: "Starting agents is off on that computer. Turn it on in its Settings → Agents.",
    });
  });

  test("Windows: off unless config.json says true, and Settings is told to show no switch", async () => {
    const windows = setup({ enabled: null, platform: "win32" });
    expect(windows.launch.enabled()).toBe(false);
    expect((await windows.get()).body.launch).toEqual({ unsupported: true, enabled: false, full_permissions: false });
    const explicit = setup({ enabled: true, platform: "win32" });
    expect(explicit.launch.enabled()).toBe(true);
    expect((await explicit.get()).body.launch).toMatchObject({ unsupported: true, enabled: true });
  });

  test("the owner's alone, and only a boolean", async () => {
    const world = setup({ enabled: null });
    expect(await world.post({ enabled: false }, { "tailscale-user-login": "guest@example.com" }, "tailnet")).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(world.launch.enabled()).toBe(true);
    await expect(world.post({ enabled: "false" })).rejects.toMatchObject({ code: "validation_error" });
    expect(world.saved()).toEqual({});
    expect((await world.post({ enabled: false }, { "tailscale-user-login": OWNER }, "tailnet")).status).toBe(200);
    expect(world.launch.enabled()).toBe(false);
  });
});

describe("GET /api/inbox/launch/settings", () => {
  test("another site's page and a tailnet guest are refused, and never start the login shell; the owner reads it on their phone too", async () => {
    const { get, reads } = setup();
    expect(await get({ origin: "https://evil.example" })).toMatchObject({ status: 403, body: { code: "cross_origin" } });
    expect(await get({ "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403, body: { code: "cross_origin" } });
    expect(await get({ "tailscale-user-login": "guest@example.com" }, "tailnet")).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(reads.count).toBe(0);
    expect((await get({ origin: "http://127.0.0.1:4000", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(reads.count).toBe(1);
    expect((await get({ "tailscale-user-login": OWNER }, "tailnet")).status).toBe(200);
  });

  test("concurrent reads share one login-shell read, and a fresh read is reused", async () => {
    const { get, reads } = setup();
    const all = await Promise.all(Array.from({ length: 20 }, () => get()));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(reads.count).toBe(1);
    await get();
    expect(reads.count).toBe(1);
    await Promise.all([get({}, "local", "?ahead=1"), get({}, "local", "?ahead=1")]);
    expect(reads.count).toBe(2);
  });

  test("the switch set: no shell read at all", async () => {
    const { get, reads } = setup({ fullPermissions: false, shellSkips: true });
    expect((await get()).body.launch).toMatchObject({ full_permissions: false, follows: null });
    expect(reads.count).toBe(0);
  });

  test("the shell's export wants full permissions; only the person's own consent makes it apply", async () => {
    const without = setup({ shellSkips: true });
    expect((await without.get()).body.launch).toMatchObject({ full_permissions: true, follows: "shell", needs_consent: true });
    for (const consent of [{ claude: { skipDangerousModePermissionPrompt: true } }, { claudeJson: { bypassPermissionsModeAccepted: true } }]) {
      const withConsent = setup({ shellSkips: true, ...consent });
      expect((await withConsent.get()).body.launch).toMatchObject({ full_permissions: true, follows: "shell", needs_consent: false });
    }
  });

  test("consent and a bypass disable count from Claude's own sources only, and Settings names which stops full permissions", async () => {
    // Consent only in ~/.claude/settings.local.json (Claude never reads it for a session elsewhere): not accepted.
    const localOnly = setup({ fullPermissions: true, claudeLocal: { skipDangerousModePermissionPrompt: true } });
    expect((await localOnly.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: true, bypass_off: false });
    const disabled = setup({ fullPermissions: true, claude: { skipDangerousModePermissionPrompt: true, permissions: { disableBypassPermissionsMode: "disable" } } });
    expect((await disabled.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: false, bypass_off: true });
    const disabledNoConsent = setup({ fullPermissions: true, claude: { permissions: { disableBypassPermissionsMode: "disable" } } });
    expect((await disabledNoConsent.get()).body.launch).toMatchObject({ needs_consent: false, bypass_off: true });
    const ignoredLocal = setup({ fullPermissions: true, claude: { skipDangerousModePermissionPrompt: true }, claudeLocal: { permissions: { disableBypassPermissionsMode: "disable" } } });
    expect((await ignoredLocal.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: false, bypass_off: false });
    const ignoredTrue = setup({ fullPermissions: true, claude: { skipDangerousModePermissionPrompt: true, permissions: { disableBypassPermissionsMode: true } } });
    expect((await ignoredTrue.get()).body.launch).toMatchObject({ needs_consent: false, bypass_off: false });
  });

  test("a launch folder's own settings: its disable turns bypass off; its default mode counts, but never its bypass", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-launch-folder-"));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
    const home = join(root, "home");
    const folder = join(root, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(folder, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: "acceptEdits" } }));
    const e = createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: {} });
    expect(claudeBypassSetup(e, folder)).toEqual({ consent: true, disabled: false, defaultMode: "acceptEdits" });
    writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: "bypassPermissions" } }));
    expect(claudeBypassSetup(e, folder)).toEqual({ consent: true, disabled: false, defaultMode: "acceptEdits" });
    writeFileSync(join(folder, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "plan", disableBypassPermissionsMode: "disable" } }));
    expect(claudeBypassSetup(e, folder)).toEqual({ consent: true, disabled: true, defaultMode: "plan" });
    expect(claudeBypassSetup(e)).toEqual({ consent: true, disabled: false, defaultMode: "acceptEdits" });
  });

  test("the login shell is read the first time New message asks, never at start, and once; off, or on Windows, never", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
    const off = setup({ enabled: false });
    await off.launch.composeBlock();
    await tick();
    expect(off.reads.count).toBe(0);
    const on = setup();
    await tick();
    expect(on.reads.count).toBe(0);
    await Promise.all([on.launch.composeBlock(), on.launch.composeBlock()]);
    await tick();
    expect(on.reads.count).toBe(1);
    await on.launch.composeBlock();
    expect((await on.get()).status).toBe(200);
    expect(on.reads.count).toBe(1);
    const windows = setup({ platform: "win32" });
    await windows.launch.composeBlock();
    expect((await windows.get({}, "local", "?ahead=1")).status).toBe(200);
    await tick();
    expect(windows.reads.count).toBe(0);
  });

  test("a person whose Claude settings set a default mode is not put in auto mode, the switch off included; theirs comes before the shell's export", async () => {
    const off = setup({ fullPermissions: false, claude: { permissions: { defaultMode: "default" } } });
    expect((await off.get()).body.launch).toMatchObject({ full_permissions: false, own_mode: true });
    const own = setup({ shellSkips: true, claude: { permissions: { defaultMode: "acceptEdits" } } });
    expect((await own.get()).body.launch).toMatchObject({ full_permissions: false, own_mode: true, follows: null });
    const bypass = setup({ claude: { skipDangerousModePermissionPrompt: true, permissions: { defaultMode: "bypassPermissions" } } });
    expect((await bypass.get()).body.launch).toMatchObject({ full_permissions: true, follows: "claude", own_mode: false, needs_consent: false });
  });
});

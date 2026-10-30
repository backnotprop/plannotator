/**
 * Settings → Agents' read of how a launch would start (GET /api/inbox/launch/settings),
 * on a real launch module over a temp data dir and a temp home. What each test guards:
 * another site's page and the tailnet are refused before the person's login shell is
 * started; concurrent reads share one shell read; the person's own bypass consent, read
 * from their Claude files, decides whether Full permissions can apply; and a person
 * whose Claude settings set a default mode is not shown (or started in) auto mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { claudeBypassSetup, createAgentEnvironmentFor } from "./inbox-agents";

const restore: (() => void)[] = [];
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

function setup(options: { shellSkips?: boolean; claude?: Record<string, unknown>; claudeLocal?: Record<string, unknown>; claudeJson?: Record<string, unknown>; fullPermissions?: boolean; enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-settings-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: options.enabled ?? true, ...(options.fullPermissions === undefined ? {} : { fullPermissions: options.fullPermissions }) } }));
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
    platform: "darwin",
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
  });
  restore.push(() => launch.stop());
  const get = async (headers: Record<string, string> = {}, via = "local", query = "") => {
    const response = await launch.route(new Request(`http://127.0.0.1:4000/api/inbox/launch/settings${query}`, { headers: { host: "127.0.0.1:4000", ...headers } }), "/api/inbox/launch/settings", via);
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  return { get, reads, launch, home };
}

describe("GET /api/inbox/launch/settings", () => {
  test("another site's page and the tailnet are refused, and never start the login shell", async () => {
    const { get, reads } = setup();
    expect(await get({ origin: "https://evil.example" })).toMatchObject({ status: 403, body: { code: "cross_origin" } });
    expect(await get({ "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403, body: { code: "cross_origin" } });
    expect(await get({}, "tailnet")).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(reads.count).toBe(0);
    // The window's own page reads.
    expect((await get({ origin: "http://127.0.0.1:4000", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(reads.count).toBe(1);
  });

  test("concurrent reads share one login-shell read, and a fresh read is reused", async () => {
    const { get, reads } = setup();
    const all = await Promise.all(Array.from({ length: 20 }, () => get()));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(reads.count).toBe(1);
    await get();
    expect(reads.count).toBe(1);
    // The composer's read ahead ("Start Claude Code" picked) reads again, fresh or not; concurrent ones still share it.
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
    // Consent in the person's Claude settings, or accepted in ~/.claude.json.
    for (const consent of [{ claude: { skipDangerousModePermissionPrompt: true } }, { claudeJson: { bypassPermissionsModeAccepted: true } }]) {
      const withConsent = setup({ shellSkips: true, ...consent });
      expect((await withConsent.get()).body.launch).toMatchObject({ full_permissions: true, follows: "shell", needs_consent: false });
    }
  });

  test("consent and a bypass disable count from Claude's own sources only: never consent from settings.local.json; a user-level disable turns bypass off", async () => {
    const localOnly = setup({ fullPermissions: true, claudeLocal: { skipDangerousModePermissionPrompt: true } });
    expect((await localOnly.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: true });
    const disabled = setup({ fullPermissions: true, claude: { skipDangerousModePermissionPrompt: true, permissions: { disableBypassPermissionsMode: "disable" } } });
    expect((await disabled.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: true });
    const disabledLocal = setup({ fullPermissions: true, claude: { skipDangerousModePermissionPrompt: true }, claudeLocal: { permissions: { disableBypassPermissionsMode: "disable" } } });
    expect((await disabledLocal.get()).body.launch).toMatchObject({ full_permissions: true, needs_consent: true });
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
    // A repo cannot grant bypass, nor consent to it.
    writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: "bypassPermissions" } }));
    expect(claudeBypassSetup(e, folder)).toEqual({ consent: true, disabled: false, defaultMode: "acceptEdits" });
    writeFileSync(join(folder, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "plan", disableBypassPermissionsMode: "disable" } }));
    expect(claudeBypassSetup(e, folder)).toEqual({ consent: true, disabled: true, defaultMode: "plan" });
    // Settings → Agents (no folder): the person's own files only.
    expect(claudeBypassSetup(e)).toEqual({ consent: true, disabled: false, defaultMode: "acceptEdits" });
  });

  test("the login shell read ahead once at Inbox start (launch on only), and a fresh read is reused", async () => {
    const off = setup({ enabled: false });
    off.launch.warm();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(off.reads.count).toBe(0);
    const on = setup();
    on.launch.warm();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(on.reads.count).toBe(1);
    expect((await on.get()).status).toBe(200);
    expect(on.reads.count).toBe(1);
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

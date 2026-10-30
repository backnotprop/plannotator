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

function setup(options: { shellSkips?: boolean; claude?: Record<string, unknown>; claudeJson?: Record<string, unknown>; fullPermissions?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-settings-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(options.fullPermissions === undefined ? {} : { fullPermissions: options.fullPermissions }) } }));
  if (options.claude) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(options.claude));
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
  const get = async (headers: Record<string, string> = {}, via = "local") => {
    const response = await launch.route(new Request("http://127.0.0.1:4000/api/inbox/launch/settings", { headers: { host: "127.0.0.1:4000", ...headers } }), "/api/inbox/launch/settings", via);
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  return { get, reads };
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

  test("a person whose Claude settings set a default mode is not put in auto mode; theirs comes before the shell's export", async () => {
    const own = setup({ shellSkips: true, claude: { permissions: { defaultMode: "acceptEdits" } } });
    expect((await own.get()).body.launch).toMatchObject({ full_permissions: false, own_mode: true, follows: null });
    const bypass = setup({ claude: { skipDangerousModePermissionPrompt: true, permissions: { defaultMode: "bypassPermissions" } } });
    expect((await bypass.get()).body.launch).toMatchObject({ full_permissions: true, follows: "claude", own_mode: false, needs_consent: false });
  });
});

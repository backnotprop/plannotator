import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ALLOW_ONCE } from "@plannotator/core/inbox-permission";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOpenCodeLaunch, type FakeOpenCodeLaunchState } from "../../tests/helpers/fake-opencode-launch";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createInboxLaunch } from "./inbox-launch";
import { OPENCODE_LAUNCH_ENV } from "@plannotator/shared/inbox/opencode-launch";
import { installedOpenCodePlugin, openCodeSpawnEnv } from "./inbox-launch-opencode";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

const cachedPlugin = (home: string, version: string, launches: boolean, generation = "1794443408253") => {
  const dir = join(home, ".cache", "opencode", "npm", "@plannotator", "opencode@latest", generation, "node_modules", "@plannotator", "opencode");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@plannotator/opencode", version }));
  writeFileSync(join(dir, "dist", "server.js"), launches ? `const watch = process.env.${OPENCODE_LAUNCH_ENV};` : "export default {};");
};

function setup(options: { state?: FakeOpenCodeLaunchState; plugin?: boolean; withOpenCode?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-opencode-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  for (const dir of [home, dataDir, folder, join(home, ".config", "opencode")]) mkdirSync(dir, { recursive: true });
  if (options.plugin !== false) writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugins: ["@plannotator/opencode"] }));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const fake = installFakeOpenCodeLaunch(join(root, "fake"), options.state ?? {});
  const bin = options.withOpenCode === false ? join(root, "empty-bin") : fake.bin;
  mkdirSync(bin, { recursive: true });
  const path = `${bin}:/usr/bin:/bin`;
  cleanup.push(() => {
    for (const start of fake.starts()) if (fake.alive(start.pid)) process.kill(start.pid, "SIGKILL"); // inbox-guard: own child (the fake opencode2)
  });
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "project", root: folder });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: (session) => bridge.runStateOf(session) },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: path, LOGIN_ONLY: "from-login", OPENCODE: "1", PLANNOTATOR_PORT: "1", PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
  });
  cleanup.push(() => launch.stop());
  const send = async (body: string, choice: { model?: string; effort?: string } = {}) => {
    const target = launch.target({ launch: { agent: "opencode", project_id: project.id, ...choice } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body, resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  const stopRoute = (launchId: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${launchId}/stop`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ server_session: "srv" }) }), `/api/inbox/launch/${launchId}/stop`, "local");
  return { home, store, project, folder, dataDir, fake, launch, send, stopRoute };
}

describe("OpenCode through the launch engine, against the fake opencode2", () => {
  test("To offers OpenCode only with OpenCode 2, Plannotator's plugin, and a plugin new enough", async () => {
    const ready = setup();
    expect((await ready.launch.composeBlock())!.agents.map((a) => a.agent)).toContain("opencode");

    const missing = setup({ withOpenCode: false });
    expect((await missing.launch.composeBlock())!.not_ready).toContainEqual({ agent: "opencode", name: "OpenCode", code: "missing" });

    const noPlugin = setup({ plugin: false });
    expect((await noPlugin.launch.composeBlock())!.not_ready).toContainEqual({ agent: "opencode", name: "OpenCode", code: "plugin_off" });

    const oldPlugin = setup();
    cachedPlugin(oldPlugin.home, "0.28.61", false);
    expect((await oldPlugin.launch.composeBlock())!.not_ready).toContainEqual({ agent: "opencode", name: "OpenCode", code: "too_old" });

    const oldOpenCode = setup({ state: { version: "2.0.0" } });
    expect((await oldOpenCode.launch.composeBlock())!.not_ready).toContainEqual({ agent: "opencode", name: "OpenCode", code: "too_old" });
  });

  test("Send starts a private server in the folder whose plugin watches new sessions, makes the session with the picked model and variant, and the plugin takes the root", async () => {
    const t = setup();
    const choices = await until("the lists", async () => (await t.launch.composeBlock())!.agents.find((a) => a.agent === "opencode")?.choices);
    expect(choices).toMatchObject({ models: ["opencode/flint-40b-free", "opencode/big-pickle"], effort_word: "Variant" });
    expect(choices.model_efforts).toEqual({ "opencode/flint-40b-free": ["low", "medium", "high", "xhigh", "max"], "opencode/big-pickle": [] });

    const root = await t.send("Tidy the readme.", { model: "opencode/flint-40b-free", effort: "high" });
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(root.id)!.to).toEqual({ host: "opencode", session });
    const [start] = t.fake.starts();
    expect(start!.argv.slice(0, 3)).toEqual(["serve", "--hostname", "127.0.0.1"]);
    expect(start!.cwd).toBe(t.folder);
    expect(start!.env).toMatchObject({ PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_INBOX_LAUNCHED: "1", PLANNOTATOR_DATA_DIR: t.dataDir, LOGIN_ONLY: "from-login" });
    expect(start!.env.PLANNOTATOR_INBOX_LAUNCHED_SESSION).toBeUndefined();
    expect(start!.env.OPENCODE).toBeUndefined();
    const [created] = t.fake.http("POST", /^\/api\/session$/);
    expect(created!.body).toEqual({ location: { directory: t.folder }, title: "Tidy", model: { providerID: "opencode", id: "flint-40b-free", variant: "high" } });
    await until("the root went in as a turn", () => t.fake.turns().some((turn) => turn.session === session && turn.text.includes("Tidy the readme.")));
    await until("the root marked delivered", () => t.store.message(root.id)!.delivery);
  });

  test("Stop ends the server; the next reply starts one that watches the session from the start, and the reply goes in there", async () => {
    const t = setup({ state: { turnMs: 60_000 } });
    const root = await t.send("A long job.");
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    await until("working", async () => (await t.launch.runOf(root.id))?.state === "working");
    const pid = t.fake.starts()[0]!.pid;
    expect((await t.stopRoute(t.store.message(root.id)!.launch!.id))!.status).toBe(200);
    await until("the server ended", () => !t.fake.alive(pid));
    expect(t.fake.http("POST", /\/interrupt$/)).toHaveLength(1);

    t.fake.set({ turnMs: 100 });
    t.store.sendReply(root.id, { words: "Please go on.", idempotency_key: "reply-1" });
    const again = await until("a second server", () => t.fake.starts()[1]);
    expect(again.env.PLANNOTATOR_INBOX_LAUNCHED_SESSION).toBe(session);
    await until("the reply went in on it", () => t.fake.turns().some((turn) => turn.pid === again.pid && turn.text.includes("Please go on.")));
    expect(t.fake.http("POST", /^\/api\/session$/)).toHaveLength(1);
  }, 30_000);

  test("a permission OpenCode asks is the card: Allow once and Deny, and Allow once answers once", async () => {
    const t = setup();
    const root = await t.send("Please APPROVE this.");
    const question = await until("the card", () => {
      const id = t.store.threadMessageIds(root.id).find((m) => t.store.message(m)!.author.kind === "agent" && t.store.questionsOf(m).length > 0);
      return id ? { id, q: t.store.questionsOf(id)[0]! } : null;
    });
    expect(question.q.choices.map((c) => c.label)).toEqual(["Allow once", "Deny"]);
    const picked = { v: 1 as const, key: question.q.key, kind: "single" as const, prompt: question.q.prompt, selected: [INBOX_PERMISSION_ALLOW_ONCE] };
    const saved = t.store.savePicks(question.id, [{ key: question.q.key, revision: question.q.revision, answer: picked }], { unsentOnly: true, confirmFull: false });
    t.store.sendReply(question.id, { idempotency_key: "answer-1", questions: [{ key: question.q.key, revision: saved[0]!.revision }] });
    await until("OpenCode got once", () => {
      t.launch.sweep(true);
      return t.fake.http("POST", /\/permission\/[^/]+\/reply$/).some((call) => call.body?.decision === "once");
    });
  });

  test("a plugin that fails to load in the started server fails the start with OpenCode's words, and the server ends", async () => {
    const t = setup({ state: { plugin: { version: "0.0.0-dev", status: "failed", error: "Cannot find module 'x'" } } });
    const root = await t.send("Hello.");
    const error = await until("the start failed", () => t.store.message(root.id)!.launch!.error);
    expect(error).toMatchObject({ code: "failed", text: "Plannotator's OpenCode plugin did not load: Cannot find module 'x'." });
    await until("its server ended", () => t.fake.starts().every((start) => !t.fake.alive(start.pid)));
  });
});

describe("OpenCode host pieces", () => {
  test("the spawn env drops an outer OpenCode's markers and Plannotator's names, and sets what the plugin watches", () => {
    expect(openCodeSpawnEnv({ PATH: "/bin", OPENCODE: "1", OPENCODE_SERVER_PASSWORD: "theirs", PLANNOTATOR_PORT: "1", XDG_CONFIG_HOME: "/c" }, "/data", "ses_abc", "pw")).toEqual({
      PATH: "/bin",
      XDG_CONFIG_HOME: "/c",
      PLANNOTATOR_INBOX_TOOL: "1",
      PLANNOTATOR_INBOX_LAUNCHED: "1",
      PLANNOTATOR_INBOX_LAUNCHED_SESSION: "ses_abc",
      PLANNOTATOR_DATA_DIR: "/data",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "pw",
    });
  });

  test("the installed plugin is the newest generation OpenCode installed, and it launches only when its bundle knows the launch env", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-cache-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    expect(installedOpenCodePlugin(join(home, ".cache"))).toBeNull();
    cachedPlugin(home, "0.28.61", false);
    expect(installedOpenCodePlugin(join(home, ".cache"))).toEqual({ version: "0.28.61", launches: false });
    cachedPlugin(home, "0.29.0", true, "1794443999999");
    expect(installedOpenCodePlugin(join(home, ".cache"))).toEqual({ version: "0.29.0", launches: true });
  });
});

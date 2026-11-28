import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ALLOW_ONCE } from "@plannotator/core/inbox-permission";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOpenCodeLaunch, type FakeOpenCodeLaunchState } from "../../tests/helpers/fake-opencode-launch";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createInboxLaunch } from "./inbox-launch";
import { OPENCODE_LAUNCH_ENV } from "@plannotator/shared/inbox/opencode-launch";
import { createOpenCodeLaunchHost, installedOpenCodePlugin, openCodeSpawnEnv } from "./inbox-launch-opencode";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext } from "./inbox-launch-host";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";

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

function setup(options: { state?: FakeOpenCodeLaunchState; plugin?: boolean; withOpenCode?: boolean; rex?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-opencode-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  for (const dir of [home, dataDir, folder, join(home, ".config", "opencode")]) mkdirSync(dir, { recursive: true });
  if (options.plugin !== false) writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugins: ["@plannotator/opencode"] }));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(options.rex ? { startIn: "rex" } : {}) } }));
  // Rex chosen: the tabs it was asked for (a stand-in for inbox-rex.ts; no Rex is reached).
  const rexTabs: { command: string; tab: string }[] = [];
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
    ...(options.rex
      ? {
          rex: {
            open: async (request: { command: string; tab: string }) => (rexTabs.push({ command: request.command, tab: request.tab }), { opened: true as const, session: "session:x", window: "window:y", block: "block:z", line: "Rex · project / OpenCode" }),
            appAttachedNow: async () => true,
            paneGone: async () => null,
            closePane: async () => "closed" as const,
          },
        }
      : {}),
  });
  cleanup.push(() => launch.stop());
  const send = async (body: string, choice: { model?: string; effort?: string; primary_agent?: string } = {}) => {
    const target = launch.target({ launch: { agent: "opencode", project_id: project.id, ...choice } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body, resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  const stopRoute = (launchId: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${launchId}/stop`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ server_session: "srv" }) }), `/api/inbox/launch/${launchId}/stop`, "local");
  return { home, store, project, folder, dataDir, fake, launch, send, stopRoute, rexTabs };
}

/** The OpenCode host alone, its CLI on PATH as `name` (OpenCode 2 may be installed as `opencode`). */
function bareHost(name: "opencode" | "opencode2", state: FakeOpenCodeLaunchState = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-host-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  const bin = join(root, "bin");
  for (const dir of [home, dataDir, folder, bin, join(home, ".config", "opencode")]) mkdirSync(dir, { recursive: true });
  // OpenCode 2's config (`plugins`): an `opencode` on PATH is that generation.
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugins: ["@plannotator/opencode"] }));
  const fake = installFakeOpenCodeLaunch(join(root, "fake"), state);
  symlinkSync(join(fake.bin, "opencode2"), join(bin, name));
  cleanup.push(() => {
    for (const start of fake.starts()) if (fake.alive(start.pid)) process.kill(start.pid, "SIGKILL"); // inbox-guard: own child (the fake opencode2)
  });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const ctx = {
    dataDir,
    homeDir: home,
    platform: process.platform,
    selfCommand: ["plannotator"],
    ownEnv: () => env,
    environment: async () => createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env }),
    shell: () => null,
    loginEnv: async () => env,
    launchDir: (id: string) => join(dataDir, "launch", id),
    startLog: () => {},
    displayFolder: (p: string) => p,
    bridge: { runStateOf: () => null },
    log: () => {},
  } as unknown as LaunchHostContext;
  const host = createOpenCodeLaunchHost(ctx);
  cleanup.push(() => host.close());
  return { host, folder, fake };
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

  test("OpenCode's own agents are offered beside the model; the one picked is the new session's agent, and one it does not list is refused", async () => {
    const t = setup({
      state: {
        agents: [
          { id: "build", mode: "primary", hidden: false },
          { id: "plan", mode: "primary", hidden: false },
          { id: "general", mode: "subagent", hidden: false },
        ],
      },
    });
    const choices = await until("the lists", async () => (await t.launch.composeBlock())!.agents.find((a) => a.agent === "opencode")?.choices);
    expect(choices.primary_agents).toEqual(["build", "plan"]);
    await expect(t.send("Not this one.", { primary_agent: "general" })).rejects.toThrow("OpenCode has no agent general");

    const root = await t.send("Plan the readme.", { model: "opencode/big-pickle", primary_agent: "plan" });
    await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(root.id)!.launch).toMatchObject({ model: "opencode/big-pickle", primary_agent: "plan" });
    const [created] = t.fake.http("POST", /^\/api\/session$/);
    expect(created!.body).toEqual({ location: { directory: t.folder }, title: "Tidy", model: { providerID: "opencode", id: "big-pickle" }, agent: "plan" });
    // The next start offers it first.
    expect((await t.launch.composeBlock())!.agents.find((a) => a.agent === "opencode")?.choices?.last).toEqual({ model: "opencode/big-pickle", primary_agent: "plan" });
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

  test("Rex chosen: the session is made with the picked model on a server that then ends, and a Rex tab runs OpenCode's own UI on it, the plugin watching that session", async () => {
    const t = setup({ rex: true });
    await until("the lists", async () => (await t.launch.composeBlock())!.agents.find((a) => a.agent === "opencode")?.choices);
    const root = await t.send("Tidy the readme in Rex.", { model: "opencode/big-pickle" });
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(root.id)!.launch).toMatchObject({ session, rex: { line: "Rex · project / OpenCode", block: "block:z" } });
    const [created] = t.fake.http("POST", /^\/api\/session$/);
    expect(created!.body).toMatchObject({ location: { directory: t.folder }, title: "Tidy", model: { providerID: "opencode", id: "big-pickle" } });
    // The server that made it is gone: only the tab runs OpenCode (never two on one session).
    const [server] = t.fake.starts();
    await until("the making server ended", () => !t.fake.alive(server!.pid));
    expect(t.rexTabs).toHaveLength(1);
    const { command, tab } = t.rexTabs[0]!;
    expect(tab).toBe("OpenCode");
    expect(command).toContain(`cd '${t.folder}' && exec env PLANNOTATOR_INBOX_TOOL=1 PLANNOTATOR_INBOX_LAUNCHED_SESSION='${session}' PLANNOTATOR_DATA_DIR='${t.dataDir}' opencode2 --standalone --session '${session}'`);
    // The person's words reach it as its first turn through the plugin, never on the command line.
    expect(command).not.toContain("readme");
    expect(t.fake.turns()).toEqual([]);
  });

  test("Rex, right after an Inbox restart (no check has run yet): the tab runs OpenCode 2 by the name it has here, `opencode` too", async () => {
    const { host, folder } = bareHost("opencode");
    const again = await host.rexCommand!({ id: "l1", agent: "opencode", folder, session: "ses_one", session_ref: "ses_one" } as unknown as InboxLaunchRecord, { name: "Tidy", login: {}, resume: true });
    expect(again.ok && again.command).toContain(" opencode --standalone --session 'ses_one'");
  });

  test("the Inbox closing while a Rex start's short-lived server makes its session: that server ends too", async () => {
    // Making the session takes a while: the Inbox closes meanwhile.
    const { host, folder, fake } = bareHost("opencode2", { sessionMs: 5_000 });
    void host.rexCommand!({ id: "l2", agent: "opencode", folder } as unknown as InboxLaunchRecord, { name: "Tidy", login: {}, resume: false });
    const [server] = await until("the making server", () => (fake.starts().length ? fake.starts() : null));
    await until("its session asked for", () => fake.http("POST", /^\/api\/session$/).length > 0);
    host.close();
    await until("that server ended", () => !fake.alive(server!.pid));
  });

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
    expect(openCodeSpawnEnv({ PATH: "/bin", OPENCODE: "1", OPENCODE_PASSWORD: "inherited", OPENCODE_SERVER_PASSWORD: "theirs", PLANNOTATOR_PORT: "1", XDG_CONFIG_HOME: "/c" }, "/data", "ses_abc", "pw")).toEqual({
      PATH: "/bin",
      XDG_CONFIG_HOME: "/c",
      PLANNOTATOR_INBOX_TOOL: "1",
      PLANNOTATOR_INBOX_LAUNCHED: "1",
      PLANNOTATOR_INBOX_LAUNCHED_SESSION: "ses_abc",
      PLANNOTATOR_DATA_DIR: "/data",
      OPENCODE_PASSWORD: "pw",
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

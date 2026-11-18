/**
 * A launch bridge (inbox-launch-bridge.ts): an app on this computer that hosts the agents the Inbox starts, against a
 * fake app on 127.0.0.1. What each test guards: the bridge is off (no hosts, nothing sent) unless its config holds and
 * names this Inbox; its hosts are the launch agents the app offers, named with the app's name; the key goes only to
 * loopback, never through a redirect, and never when it is not exactly 32 bytes; a start carries the launch, its
 * message and thread, the agent and the folder; Stop, Open and Resume act only on a chat exactly one launch owns and
 * post nothing otherwise; an answer over 1 MiB is refused; the port is read again for each request. On the engine: a
 * launch through the bridge settles to the app's host, its run line says Open in the app, Open starts no Terminal,
 * and a refused Stop says so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { createLaunchBridgeHosts } from "./inbox-launch-bridge";
import type { LaunchHost, LaunchHostContext } from "./inbox-launch-host";

const restore: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of restore.splice(0).reverse()) await undo();
});

function setEnv(name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/** The app's side: every request it got, and what it answers per path (`<METHOD> <path without query>`). */
function fakeApp(answers: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : null });
      const answer = answers[`${req.method} ${url.pathname}`];
      return answer ? answer(req, url) : Response.json({ ok: false, text: "not here" }, { status: 404 });
    },
  });
  restore.push(() => server.stop(true));
  return { seen, port: server.port, posts: () => seen.filter((s) => s.method === "POST") };
}

const CATALOG = (folder: string, providers = ["claude-code", "codex", "opencode", "pi"]) => ({
  ok: true,
  workspaces: [{ folder, project: "project", selector: "w1" }],
  providers: providers.map((id) => ({ id, name: id })),
  sessions: {},
});
/** The app's status of one chat: the launches that own it. */
const statusOf = (session: string, launches: { launchId: string; session?: string; state?: string }[]) =>
  Response.json({ ok: true, version: 1, session, complete: true, launches: launches.map((l) => ({ session, state: "created", ...l })) });

/** A temp Inbox data folder and the app's private files, the env set to them. */
function setup(port: number, options: { config?: Record<string, unknown>; mode?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-bridge-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  const app = join(root, "app");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(folder, { recursive: true });
  mkdirSync(app, { recursive: true, mode: 0o700 });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  const key = Buffer.alloc(32, 7);
  const files = { config: join(app, "bridge.json"), address: join(app, "address.json"), key: join(app, "key") };
  const write = (path: string, data: string | Buffer, mode = 0o600) => {
    writeFileSync(path, data, { mode });
    chmodSync(path, mode);
  };
  write(files.address, JSON.stringify({ v: 1, port }));
  write(files.key, key);
  const config = { v: 1, host: "testapp", name: "Testapp", dataDir, address: files.address, key: files.key, ...options.config };
  write(files.config, JSON.stringify(config), options.mode ?? 0o600);
  setEnv("PLANNOTATOR_LAUNCH_BRIDGE", files.config);
  const logs: string[] = [];
  const context = { dataDir, log: (line: string) => logs.push(line), bridge: { runStateOf: () => null } } as unknown as LaunchHostContext;
  return { root, dataDir, folder, files, key, write, context, logs, movePort: (to: number) => write(files.address, JSON.stringify({ v: 1, port: to })) };
}

const launchIn = (folder: string, extra: Partial<InboxLaunchRecord> = {}) => ({ id: "lch_1", agent: "claude-code", folder, session_ref: "chat-1", ...extra }) as InboxLaunchRecord;
const hostFor = (hosts: LaunchHost[], agent: string) => hosts.find((h) => h.agent === agent)!;

describe("a launch bridge: on only when its config holds", () => {
  test("unset: no hosts, nothing read or sent", () => {
    const app = fakeApp();
    const { context } = setup(app.port);
    setEnv("PLANNOTATOR_LAUNCH_BRIDGE", undefined);
    expect(createLaunchBridgeHosts(context)).toEqual([]);
    expect(app.seen).toEqual([]);
  });

  test("a config others can read, or one naming another Inbox's data folder: off, said in the log, never a throw", () => {
    const app = fakeApp();
    const open = setup(app.port, { mode: 0o644 });
    expect(createLaunchBridgeHosts(open.context)).toEqual([]);
    expect(open.logs.join("\n")).toContain("not private");

    const other = setup(app.port, { config: { dataDir: "/elsewhere/.plannotator" } });
    expect(createLaunchBridgeHosts(other.context)).toEqual([]);
    expect(other.logs.join("\n")).toContain("dataDir");

    // An agent's own id as the app's host would hand its chats to that agent's own ways in.
    const asAgent = setup(app.port, { config: { host: "codex" } });
    expect(createLaunchBridgeHosts(asAgent.context)).toEqual([]);
    expect(app.seen).toEqual([]);
  });

  test("its hosts are the launch agents the app offers, named with the app's name", async () => {
    let folder = "";
    const app = fakeApp({ "GET /api/lifecycle/catalog": () => Response.json(CATALOG(folder, ["claude-code", "codex"])) });
    const s = setup(app.port);
    folder = s.folder;
    const hosts = createLaunchBridgeHosts(s.context);
    expect(hosts.map((h) => [h.agent, h.name, h.routeHost, h.openIn])).toEqual([
      ["claude-code", "Claude in Testapp", "testapp", "Testapp"],
      ["codex", "Codex in Testapp", "testapp", "Testapp"],
      ["opencode", "OpenCode in Testapp", "testapp", "Testapp"],
      ["pi", "Pi in Testapp", "testapp", "Testapp"],
    ]);
    const offered = await Promise.all(hosts.map(async (h) => [h.agent, (await h.available([s.folder])).ok]));
    expect(offered).toEqual([
      ["claude-code", true],
      ["codex", true],
      ["opencode", false],
      ["pi", false],
    ]);
    // A folder the app has not open is not offered either.
    expect((await hostFor(hosts, "codex").available([join(s.root, "elsewhere")])).ok).toBe(false);
  });
});

describe("a launch bridge's requests", () => {
  test("the key goes as a lowercase-hex bearer to 127.0.0.1 only, whatever else the address file says", async () => {
    const app = fakeApp({ "GET /api/lifecycle/catalog": () => Response.json(CATALOG("/")) });
    const s = setup(app.port);
    s.write(s.files.address, JSON.stringify({ v: 1, port: app.port, host: "example.com", url: "http://example.com/" }));
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (urls.push(String(input)), real(input, init))) as typeof fetch;
    restore.push(() => {
      globalThis.fetch = real;
    });
    const hosts = createLaunchBridgeHosts(s.context);
    expect((await hosts[0]!.available()).ok).toBe(true);
    expect(urls).toEqual([`http://127.0.0.1:${app.port}/api/lifecycle/catalog`]);
    expect(app.seen[0]!.auth).toBe(`Bearer ${s.key.toString("hex")}`);
  });

  test("a key that is not exactly 32 bytes, or a key file others can read: nothing is sent", async () => {
    const app = fakeApp({ "GET /api/lifecycle/catalog": () => Response.json(CATALOG("/")) });
    const s = setup(app.port);
    const hosts = createLaunchBridgeHosts(s.context);
    s.write(s.files.key, Buffer.alloc(31, 7));
    expect(await hosts[0]!.available()).toMatchObject({ ok: false, reason: "Testapp is not running." });
    s.write(s.files.key, s.key, 0o644);
    expect((await hosts[0]!.available()).ok).toBe(false);
    expect(app.seen).toEqual([]);
  });

  test("a redirect is refused, so the key never follows it", async () => {
    const elsewhere = fakeApp({ "POST /api/lifecycle/start": () => Response.json({ ok: true, session: "x", ref: "x" }) });
    const app = fakeApp({ "POST /api/lifecycle/start": () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${elsewhere.port}/api/lifecycle/start` } }) });
    const s = setup(app.port);
    const host = hostFor(createLaunchBridgeHosts(s.context), "claude-code");
    await expect(host.start(launchIn(s.folder), { name: "n", login: {}, source: { messageId: "m1", threadId: "t1" } })).rejects.toThrow();
    expect(app.posts()).toHaveLength(1);
    expect(elsewhere.seen).toEqual([]);
  });

  test("an answer over 1 MiB is refused", async () => {
    const app = fakeApp({ "POST /api/lifecycle/start": () => new Response(`{"ok":true,"pad":"${"x".repeat(1024 * 1024)}"}`) });
    const s = setup(app.port);
    const host = hostFor(createLaunchBridgeHosts(s.context), "codex");
    await expect(host.start(launchIn(s.folder), { name: "n", login: {}, source: { messageId: "m1", threadId: "t1" } })).rejects.toThrow("Testapp's answer was too long.");
  });

  test("the port is read again for each request: the app restarted on another port is found", async () => {
    const start = (session: string) => () => Response.json({ ok: true, session, ref: session });
    const first = fakeApp({ "POST /api/lifecycle/start": start("chat-a") });
    const second = fakeApp({ "POST /api/lifecycle/start": start("chat-b") });
    const s = setup(first.port);
    const host = hostFor(createLaunchBridgeHosts(s.context), "pi");
    const input = { name: "n", login: {}, source: { messageId: "m1", threadId: "t1" } };
    expect(await host.start(launchIn(s.folder), input)).toEqual({ ok: true, session: "chat-a", ref: "chat-a" });
    s.movePort(second.port);
    expect(await host.start(launchIn(s.folder), input)).toEqual({ ok: true, session: "chat-b", ref: "chat-b" });
    expect([first.posts().length, second.posts().length]).toEqual([1, 1]);
  });

  test("start carries the launch, its message and thread, the agent and the folder, and takes the app's session", async () => {
    const app = fakeApp({ "POST /api/lifecycle/start": () => Response.json({ ok: true, session: "chat-1", ref: "chat-1" }) });
    const s = setup(app.port);
    const host = hostFor(createLaunchBridgeHosts(s.context), "opencode");
    const result = await host.start(launchIn(s.folder, { agent: "opencode", model: "m-1" }), { name: "n", login: {}, source: { messageId: "msg_1", threadId: "thr_1" }, reconcile: true });
    expect(result).toEqual({ ok: true, session: "chat-1", ref: "chat-1" });
    expect(app.posts()[0]!.body).toMatchObject({ launchId: "lch_1", messageId: "msg_1", threadId: "thr_1", provider: "opencode", folder: s.folder, model: "m-1", ownerAction: true, reconcile: true });
    // No message to tie it to: nothing is started.
    expect(await host.start(launchIn(s.folder), { name: "n", login: {} })).toMatchObject({ ok: false, code: "failed" });
    expect(app.posts()).toHaveLength(1);
  });

  test("Stop, Open and Resume act only on a chat exactly one launch (this one) owns; otherwise nothing is posted", async () => {
    let owners: { launchId: string }[] = [];
    const ok = () => Response.json({ ok: true });
    const app = fakeApp({
      "GET /api/lifecycle/status": (_req, url) => statusOf(url.searchParams.get("session")!, owners),
      "POST /api/lifecycle/stop": ok,
      "POST /api/lifecycle/open": ok,
      "POST /api/lifecycle/resume": ok,
    });
    const s = setup(app.port);
    const host = hostFor(createLaunchBridgeHosts(s.context), "claude-code");
    const launch = launchIn(s.folder);
    for (const shown of [[], [{ launchId: "lch_1" }, { launchId: "lch_2" }], [{ launchId: "lch_other" }]]) {
      owners = shown;
      expect((await host.open!(launch)).exitCode).toBe(1);
      expect((await host.resume(launch)).failure).toMatchObject({ code: "failed" });
      // Stop asks for any single owner: the empty and the doubled status refuse it.
      if (shown.length !== 1) expect((await host.stop("chat-1")).exitCode).toBe(1);
    }
    expect(app.posts()).toEqual([]);

    owners = [{ launchId: "lch_1" }];
    expect((await host.open!(launch)).exitCode).toBe(0);
    expect((await host.resume(launch)).failure).toBeNull();
    expect((await host.stop("chat-1")).exitCode).toBe(0);
    expect(app.posts().map((p) => [p.path, p.body!.launchId, p.body!.session])).toEqual([
      ["/api/lifecycle/open", "lch_1", "chat-1"],
      ["/api/lifecycle/resume", "lch_1", "chat-1"],
      ["/api/lifecycle/stop", "lch_1", "chat-1"],
    ]);
  });
});

describe("a launch through a bridge, on the engine", () => {
  test("settles to the app's host, its line says Open in the app, Open starts no Terminal, a refused Stop says why", async () => {
    let folder = "";
    let owners: { launchId: string }[] = [];
    const app = fakeApp({
      "GET /api/lifecycle/catalog": () => Response.json(CATALOG(folder, ["claude-code"])),
      "POST /api/lifecycle/start": () => Response.json({ ok: true, session: "chat-1", ref: "chat-1" }),
      "GET /api/lifecycle/status": (_req, url) => statusOf(url.searchParams.get("session")!, owners),
      "POST /api/lifecycle/open": () => Response.json({ ok: true }),
    });
    const s = setup(app.port);
    folder = s.folder;
    writeFileSync(join(s.dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
    const store = InboxStore.open(s.dataDir);
    const project = store.ensureProject({ name: "project", root: s.folder });
    const launch = createInboxLaunch({
      store,
      live: { runStateOf: () => null },
      dataDir: s.dataDir,
      serverSession: "srv",
      homeDir: join(s.root, "home"),
      platform: "darwin",
      loginEnv: async () => ({ HOME: join(s.root, "home"), PATH: "" }),
      ownEnv: () => ({ HOME: join(s.root, "home"), PATH: "" }),
      installDirs: [],
      displayFolder: (path) => path,
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      selfCommand: ["plannotator"],
      hosts: createLaunchBridgeHosts,
    });
    restore.push(() => launch.stop());
    const post = (id: string, action: string) =>
      launch.route(
        new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
        `/api/inbox/launch/${id}/${action}`,
        "local",
      );

    // New message offers the app's Claude in place of the Inbox's own (no other agent is offered by the app).
    expect((await launch.composeBlock())!.agents.map((a) => [a.agent, a.name])).toEqual([["claude-code", "Claude in Testapp"]]);

    const target = launch.target({ launch: { agent: "claude-code", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    expect(prepared.to.host).toBe("testapp");
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(root);
    for (let i = 0; i < 200 && store.message(root.id)!.launch!.session_ref !== "chat-1"; i++) await Bun.sleep(5);
    expect(store.message(root.id)!.to).toEqual({ host: "testapp", session: "chat-1" });
    expect(app.posts()[0]!.body).toMatchObject({ launchId: prepared.launch.id, messageId: root.id, threadId: root.thread_id, provider: "claude-code", folder: s.folder, reconcile: false });
    expect(await launch.runOf(root.id)).toMatchObject({ agent: "claude-code", open_in: "Testapp" });
    expect(launch.agents()).toMatchObject([{ launch_id: prepared.launch.id, host: "testapp", session: "chat-1" }]);

    // Open goes to the app, never to osascript (none is on this PATH, which would refuse it).
    owners = [{ launchId: prepared.launch.id }];
    const opened = (await post(prepared.launch.id, "open"))!;
    expect([opened.status, await opened.json()]).toEqual([200, { ok: true }]);
    expect(app.posts().at(-1)!.path).toBe("/api/lifecycle/open");

    // A Stop the app does not own is refused in its words, and the chat is not marked stopped.
    owners = [];
    const before = app.posts().length;
    await expect(post(prepared.launch.id, "stop")).rejects.toMatchObject({ code: "stop_unavailable", message: "No single launch in Testapp owns this chat." });
    expect(app.posts()).toHaveLength(before);
    expect((await launch.runOf(root.id))?.stopped_by_person ?? false).toBe(false);
  });
});

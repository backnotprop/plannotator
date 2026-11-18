/**
 * Rex in a running Inbox (CI runs this: it starts one), with a fake Rex (tests/helpers/fake-rex.ts) as this
 * computer's. What it guards: Rex is read about, and anything from it shown for, only sessions the Inbox itself started
 * in Rex while "Start new agents in" is Rex; with the default setting, Rex is never contacted, however many sessions run
 * in Rex panes by hand. A place reaches the Agents list only as Rex confirms it, as one line, and only for this
 * computer's own window (the tailnet gets none, and makes no Rex read); what the pane says (blocked on a prompt) is the
 * agent's state on the list, with its kind, and its icon's mark; Show in Rex asks the app only at the click, only for
 * such a session, and a refusal takes the item away; the Show route answers only this computer's own window (never
 * the tailnet, never another site).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAgentsGroup } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, INBOX_PLACE_POLL_FIELD } from "@plannotator/shared/inbox/connection";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxRex } from "./inbox-rex";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME", "PLANNOTATOR_TEST_SANDBOX"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const fakes: FakeRex[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) await fake.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const MAGIC = "inbox-host.tail0000.ts.net";
const OWNER = "owner@example.com";

/** A scripted tailscale that publishes the Inbox (as inbox-agent-icons.test.ts): no real tailscale runs. */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${MAGIC}:${httpsPort}/\n`);
  };
}

/**
 * The Inbox's sessions clock. A fresh Inbox counts every session as there for its first minute, so it moves on ten
 * minutes after the start (as inbox-reply-launch-route.test.ts): the asker a launch answers has ended, as a real one has.
 */
const clock = { ahead: 0 };
const sessionsNow = () => Date.now() + clock.ahead;

async function world(options: { remote: boolean; startIn?: "rex"; phones?: boolean }) {
  clock.ahead = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-rex-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const project = join(root, "my-app");
  for (const dir of [dataDir, home, project]) mkdirSync(dir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  process.env.PLANNOTATOR_TEST_SANDBOX = dataDir;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxLaunch: { enabled: true, ...(options.startIn ? { startIn: options.startIn } : {}) } }));
  const fake = startFakeRex({ remote: options.remote });
  fakes.push(fake);
  const launchHost = fakeLaunchHost();
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: options.phones === true,
    tailscale: scriptedTailscale(),
    readProjectRepo: async () => null,
    sessionsNow,
    launchHosts: () => [launchHost.host],
    rex: createInboxRex({ socketPath: fake.socketPath, readTimeoutMs: 1_000 }),
  });
  servers.push(server);
  clock.ahead = 10 * 60_000;
  const client = new Client({ name: "inbox-rex-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  /** A session polls, saying where it lives (or not). */
  const poll = async (session: string, place?: { session: string; block: string }) => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, waitMs: 0, ...(place ? { [INBOX_PLACE_POLL_FIELD]: { kind: "rex", ...place } } : {}) }),
    });
    expect(response.status).toBe(200);
  };
  /** A session writes once (so it is listed) and polls. */
  const agent = async (session: string, place?: { session: string; block: string }) => {
    await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", agent_host: "claude-code", body: `Hello from ${session}.` } });
    await poll(session, place);
  };
  /** A session the Inbox launched (the engine's fake host), answering a question: its session id once started. */
  const launched = async () => {
    const store = server.store;
    const folder = store.ensureProject({ name: "my-app", root: project });
    const asked = store.sendMessage({ project_id: folder.id, author: { kind: "agent", host: "claude-code", session: "ses-asker", name: "Claude Code" }, body: "Which one?", wakes: true, idempotency_key: "asked" }).message;
    const sent = await fetch(`${base}/api/inbox/messages/${asked.id}/reply`, {
      method: "POST",
      // Pressed in this computer's own window (a page of this Inbox): the only Send that may start in Rex.
      headers: { Origin: base, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k1", words: "This one.", questions: [], to: { launch: { agent: FAKE, project_id: folder.id } } }),
    });
    expect({ status: sent.status, body: sent.status === 200 ? null : await sent.text() }).toEqual({ status: 200, body: null });
    const id = ((await sent.json()) as { reply: { id: string } }).reply.id;
    let session: string | null = null;
    for (let i = 0; i < 400 && !session; i++) {
      session = store.message(id)?.launch?.session ?? null;
      if (!session) await Bun.sleep(5);
    }
    expect(session).not.toBeNull();
    return session!;
  };
  const windowHeaders = { "Sec-Fetch-Site": "same-origin", Origin: base };
  const agentsOf = async (headers: Record<string, string> = windowHeaders, at = base) => {
    const model = (await (await fetch(`${at}/api/inbox/threads`, { headers })).json()) as { agents: InboxAgentsGroup[] };
    return model.agents.flatMap((group) => group.agents);
  };
  const show = (session: string, headers: Record<string, string> = windowHeaders, at = base) =>
    fetch(`${at}/api/inbox/rex/show`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, session }) });
  const tailnet = () => {
    const listener = server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    return { at: `http://127.0.0.1:${listener}`, headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, Origin: `https://${MAGIC}:${server.port}`, "Sec-Fetch-Site": "same-origin" } };
  };
  /** A session the Inbox started in Rex, polling from its own tab: its id and the tab's ids. */
  const inRex = async () => {
    const session = await launched();
    const made = fake.sessions.find((s) => s.label === "my-app")!;
    const ids = { session: made.session_id, window: made.windows[0]!.window_id, block: made.windows[0]!.blocks[0]! };
    await poll(session, ids);
    return { session, ids };
  };
  /** A New message that starts an agent, sent to `url` with `headers`: its root once the agent started. */
  let sends = 0;
  const sendNew = async (headers: Record<string, string>, url = `${base}/api/inbox/messages`, withSession = true) => {
    const folder = server.store.ensureProject({ name: "my-app", root: project });
    const key = `00000000-0000-4000-8000-${String(++sends).padStart(12, "0")}`;
    const body = { ...(withSession ? { serverSession: server.serverSession } : {}), idempotency_key: key, body: "Tidy the readme.", to: { launch: { agent: FAKE, project_id: folder.id } } };
    const sent = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect({ status: sent.status, body: sent.status === 200 ? null : await sent.text() }).toEqual({ status: 200, body: null });
    const id = ((await sent.json()) as { message: { id: string } }).message.id;
    for (let i = 0; i < 400 && !server.store.message(id)?.launch?.session_ref; i++) await Bun.sleep(5);
    return server.store.message(id)!;
  };
  /** A paired phone's token, through the real pairing routes. */
  const pairPhone = async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const made = (await (await post("/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    return ((await (await post("/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string }).token;
  };
  return { fake, agent, poll, launched, inRex, agentsOf, show, tailnet, sendNew, pairPhone, base, server };
}

/** Wait for the list to say it (Rex is read in the background; the list answers from the last read). */
async function until(check: () => Promise<boolean>) {
  // Up to 5 s: a list read starts Rex's next read only once the last is a couple of seconds old.
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  expect(await check()).toBe(true);
}

describe("the Agents list and Rex", () => {
  test("the default setting: Rex is never contacted, however many sessions say they live in a Rex pane", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-by-hand", ids);
    const background = await w.launched();
    await w.poll(background, ids);
    for (let i = 0; i < 3; i++) {
      const agents = await w.agentsOf();
      expect(agents.find((a) => a.session === "ses-by-hand")).toMatchObject({ state: expect.any(String) });
      expect(agents.find((a) => a.session === "ses-by-hand")?.place).toBeUndefined();
      expect(agents.find((a) => a.session === background)?.place).toBeUndefined();
      await Bun.sleep(1_100);
    }
    // Routines are on with Launch: their clock asks whether Launch is on, never Rex.
    const far = w.tailnet();
    const settings = (await (await fetch(`${far.at}/api/inbox/launch/settings`, { headers: far.headers })).json()) as { launch: Record<string, unknown> };
    expect(settings.launch.rex_here).toBeUndefined();
    expect(w.fake.calls).toEqual([]);
    expect(w.fake.connections().opened).toBe(0);
  });

  test("started in Rex: the Inbox's own Rex session for the project gets a tab running the agent, and its place is that tab", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const { session } = await w.inRex();
    const made = w.fake.sessions.find((s) => s.label === "my-app");
    expect(made?.windows.map((win) => win.label)).toEqual(["Fake Agent"]);
    expect(w.fake.calls.find((c) => c.method === "session.create")?.payload).toMatchObject({ initial_windows: [{ layout: { block: { options: { login: true, command: ["/bin/sh", "-c", expect.stringContaining(`--session ${session}`)] } } } }] });
    // A start never moves Rex's app.
    expect(w.fake.methods()).not.toContain("client.perform");
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toMatchObject({ kind: "rex", line: "Rex · my-app / Fake Agent" });
    // Its pane's status is the mark on its icon, as it is.
    w.fake.setStatus(made!.windows[0]!.blocks[0]!, [{ state: "blocked", kind: "auth", app: "fake-agent" }]);
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.rex_mark).toEqual({ state: "blocked", kind: "auth" });
    // The tailnet's window gets none.
    const far = w.tailnet();
    expect((await w.agentsOf(far.headers, far.at)).find((a) => a.session === session)?.rex_mark).toBeUndefined();
  });

  test("a pane blocked on a prompt: the agent waits on you, with the kind on its mark; working again: working", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const { session, ids } = await w.inRex();
    w.fake.setStatus(ids.block, [{ state: "blocked", kind: "question", app: "claude-code", msg: "V2hpY2ggb25lPw==" }]);
    // Its run line says it first (waiting on you in Rex: Stopped on you), so the Inbox's own word is "waiting".
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark?.state === "blocked");
    expect((await w.agentsOf()).find((a) => a.session === session)).toMatchObject({ state: "waiting", rex_mark: { state: "blocked", kind: "question" } });
    w.fake.setStatus(ids.block, [{ state: "working", app: "claude-code" }]);
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark?.state === "working");
    const working = (await w.agentsOf()).find((a) => a.session === session);
    expect(working).toMatchObject({ state: "working", rex_mark: { state: "working" } });
    expect(working?.rex_status).toBeUndefined();
  }, 20_000);

  test("Rex chosen: a session the person runs in Rex by hand gets no place, no status and no mark", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const { session } = await w.inRex();
    const theirs = w.fake.addSession("their work", "shell");
    w.fake.setStatus(theirs.block, [{ state: "blocked", kind: "permission", app: "claude-code" }]);
    await w.agent("ses-by-hand", theirs);
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place !== undefined);
    const byHand = (await w.agentsOf()).find((a) => a.session === "ses-by-hand");
    expect(byHand?.place).toBeUndefined();
    expect(byHand?.rex_status).toBeUndefined();
    expect(byHand?.rex_mark).toBeUndefined();
    // Never read about: no status asked of its block.
    expect(w.fake.calls.filter((c) => c.method === "block.method" && c.payload.block_id === theirs.block)).toEqual([]);
  });

  test("Rex chosen: a Send from the tailnet or a paired phone starts in the background (the window's headers copied or not); this window's starts in Rex", async () => {
    const w = await world({ remote: false, startIn: "rex", phones: true });
    const far = w.tailnet();
    const fromTailnet = await w.sendNew(far.headers, `${far.at}/api/inbox/messages`);
    expect(fromTailnet.launch!.session_ref).toBeTruthy();
    expect(fromTailnet.launch!.rex).toBeUndefined();
    const token = await w.pairPhone();
    const fromPhone = await w.sendNew({ Authorization: `Bearer ${token}`, "Sec-Fetch-Site": "same-origin", Origin: w.base }, `${w.base}/api/inbox/device/messages`, false);
    expect(fromPhone.launch!.session_ref).toBeTruthy();
    expect(fromPhone.launch!.rex).toBeUndefined();
    expect(w.fake.methods()).not.toContain("session.create");
    expect(w.fake.methods()).not.toContain("session.new_window");
    // The same Send pressed in this computer's own window: Rex.
    const here = await w.sendNew({ Origin: w.base, "Sec-Fetch-Site": "same-origin" });
    expect(here.launch!.rex).toBeDefined();
    expect(w.fake.methods()).toContain("session.create");
  }, 20_000);

  test("over the tailnet: no place, and Rex is not read", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    const remote = w.tailnet();
    for (let i = 0; i < 3; i++) expect((await w.agentsOf(remote.headers, remote.at)).find((a) => a.session === "ses-in-rex")?.place).toBeUndefined();
    await Bun.sleep(50);
    expect(w.fake.calls).toEqual([]);
  });
});

describe("POST /api/inbox/rex/show", () => {
  test("this computer's window: Rex's app goes to the pane of an agent the Inbox started in Rex", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session, ids } = await w.inRex();
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place?.show === true);
    const response = await w.show(session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shown: true });
    expect(w.fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  });

  test("refused (Remote Control off): not shown, and no longer offered", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session } = await w.inRex();
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place?.show === true);
    w.fake.setRemote(false);
    expect(await (await w.show(session)).json()).toEqual({ shown: false, refused: true });
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place?.show === undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
  });

  test("another site, the tailnet, or a session the Inbox did not start in Rex: refused, and Rex is asked nothing", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session } = await w.inRex();
    const theirs = w.fake.addSession("their work", "shell");
    await w.agent("ses-by-hand", theirs);
    const before = w.fake.calls.length;
    expect((await w.show(session, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.show(session, {})).status).toBe(403);
    const remote = w.tailnet();
    expect((await w.show(session, remote.headers, remote.at)).status).toBe(403);
    expect((await w.show("ses-by-hand")).status).toBe(404);
    expect(w.fake.calls.slice(before).filter((c) => c.method === "client.perform" || c.method === "session.focus_block" || c.method === "session.attach")).toEqual([]);
  });
});

/**
 * Rex in a running Inbox (CI runs this: it starts one), with a fake Rex (tests/helpers/fake-rex.ts) as this
 * computer's. What it guards: while "Start new agents in" is Rex, every agent of this computer's in a Rex pane (one
 * started there by hand too) gets its place, its pane's status and Show in Rex, and a Send from anywhere (this window,
 * the tailnet, a paired phone) starts in Rex; back on the default setting, the agents the Inbox started in Rex keep
 * theirs until they end, and with none left Rex is never contacted, however many sessions run in Rex panes by hand. A
 * place reaches the Agents list only as Rex confirms it, as one line, in every window, with Show in Rex only in this
 * computer's; what the pane says (blocked on a prompt) is the agent's state on the list, with its kind, and its icon's
 * mark; Show asks the app only at the click, and a refusal takes the item away for a while; another site never asks;
 * Stop closes the agent's own tab. And a Rex with no app on its computer (a Linux server's): a Send starts in its tab
 * with no app attached, and Show in Rex, from the tailnet's window or a linked machine's through the door, asks the
 * Rex apps attached to it from other computers, never a Mac's own app for a click made elsewhere.
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
import { startFakeRex, type FakeRex, type FakeRexFarApp } from "../../tests/helpers/fake-rex";
import { startInboxServer, type InboxServer } from "./inbox";
import { parseLinkOffer } from "./inbox-links";
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
/** This computer's own tailnet address (`Self.TailscaleIPs`): serve's X-Forwarded-For for a browser here on the tailnet address. */
const SELF_IP = "100.100.1.1";

/** A scripted tailscale that publishes the Inbox (as inbox-agent-icons.test.ts): no real tailscale runs. */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42, TailscaleIPs: [SELF_IP] }, User: { "42": { ID: 42, LoginName: OWNER } } }));
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

async function world(options: { remote: boolean; startIn?: "rex"; phones?: boolean; headless?: boolean; apps?: FakeRexFarApp[] }) {
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
  // `headless`: a Rex server with no app on its computer; `apps`: the Rex apps attached to it from other computers.
  const fake = startFakeRex({ remote: options.remote, ...(options.headless ? { app: false } : {}), ...(options.apps ? { apps: options.apps } : {}) });
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
    rex: createInboxRex({ socketPath: fake.socketPath, readTimeoutMs: 1_000, headless: options.headless === true }),
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
      // Pressed in this computer's own window (a page of this Inbox).
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
  /** A linked machine's token for this Inbox's door, through the real offer and pairing routes. */
  const pairMachine = async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const offered = (await (await post("/api/inbox/machines/offer", {})).json()) as { link: string };
    return ((await (await post("/api/inbox/device/pair", { name: "MacBook", platform: "machine", secret: parseLinkOffer(offered.link)!.secret })).json()) as { token: string }).token;
  };
  return { fake, agent, poll, launched, inRex, agentsOf, show, tailnet, sendNew, pairPhone, pairMachine, base, server };
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
    // Routines are on with Launch: their clock asks whether Launch is on, never Rex. (Settings → Agents' own read is
    // the one that asks, from any window: inbox-launch-rex.test.ts.)
    const far = w.tailnet();
    expect((await w.agentsOf(far.headers, far.at)).find((a) => a.session === "ses-by-hand")?.place).toBeUndefined();
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
    // The tailnet's window gets its place and mark too, but no Show in Rex (it would move a screen no one there sees).
    const far = w.tailnet();
    const there = (await w.agentsOf(far.headers, far.at)).find((a) => a.session === session);
    expect(there?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
    expect(there?.rex_mark).toEqual({ state: "blocked", kind: "auth" });
  });

  test("Stop closes the agent's own tab in Rex, and the line says it stopped", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const { session, ids } = await w.inRex();
    const root = w.server.store.launchedRoots().find((m) => m.launch?.session === session)!;
    const stopped = await fetch(`${w.base}/api/inbox/launch/${root.launch!.id}/stop`, {
      method: "POST",
      headers: { Origin: w.base, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ serverSession: w.server.serverSession }),
    });
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { run: { state: string } }).run.state).toBe("stopped");
    expect(w.fake.calls.filter((c) => c.method === "block.close").map((c) => c.payload)).toEqual([{ session_id: ids.session, block_id: ids.block }]);
    expect(w.fake.sessions.find((s) => s.session_id === ids.session)!.windows).toEqual([]);
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

  test("Rex chosen: an agent the person started in Rex by hand gets its place, its pane's mark and Show in Rex too", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const theirs = w.fake.addSession("their work", "shell");
    w.fake.setStatus(theirs.block, [{ state: "blocked", kind: "permission", app: "claude-code" }]);
    await w.agent("ses-by-hand", theirs);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-by-hand")?.rex_mark !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === "ses-by-hand")).toMatchObject({ place: { kind: "rex", line: "Rex · their work / shell", show: true }, rex_mark: { state: "blocked", kind: "permission" } });
    expect(await (await w.show("ses-by-hand")).json()).toEqual({ shown: true });
  });

  test("Rex chosen: an agent the Inbox started in the background never wears a Rex place, even when its connection reports the person's pane", async () => {
    const w = await world({ remote: true });
    // Started in the background, under a supervisor started from the person's own Rex pane: it reports that pane.
    const background = await w.launched();
    const turned = await fetch(`${w.base}/api/inbox/launch/settings`, { method: "POST", headers: { Origin: w.base, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ serverSession: w.server.serverSession, start_in: "rex" }) });
    expect(turned.status).toBe(200);
    const theirs = w.fake.addSession("their work", "claude");
    w.fake.setStatus(theirs.block, [{ state: "blocked", kind: "permission", app: "claude-code" }]);
    await w.poll(background, theirs);
    // The person's own agent in that pane gets it (so Rex was read), the background one never does.
    await w.agent("ses-by-hand", theirs);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-by-hand")?.rex_mark !== undefined);
    const listed = (await w.agentsOf()).find((a) => a.session === background);
    expect(listed?.place).toBeUndefined();
    expect(listed?.rex_mark).toBeUndefined();
    expect(listed?.state).not.toBe("waiting");
    expect(await (await w.show(background)).json()).not.toEqual({ shown: true });
  });

  test("Rex chosen: an agent started in Rex whose connection reports no place (Pi, OpenCode) still gets its tab's place, mark and Show", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const session = await w.launched();
    const made = w.fake.sessions.find((s) => s.label === "my-app")!;
    w.fake.setStatus(made.windows[0]!.blocks[0]!, [{ state: "blocked", kind: "question", app: "pi" }]);
    await w.poll(session);
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)).toMatchObject({ place: { kind: "rex", line: "Rex · my-app / Fake Agent", show: true }, rex_mark: { state: "blocked", kind: "question" } });
    expect(await (await w.show(session)).json()).toEqual({ shown: true });
  });

  test("started in Rex and not connected yet, its tab blocked on a prompt (the agent's own trust question): the line says it waits on you in Rex, and its icon has the mark", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const session = await w.launched();
    const made = w.fake.sessions.find((s) => s.label === "my-app")!;
    w.fake.setStatus(made.windows[0]!.blocks[0]!, [{ state: "blocked", kind: "permission", app: "claude-code" }]);
    const root = w.server.store.launchedRoots().find((m) => m.launch?.session === session)!;
    const runOf = async () => ((await (await fetch(`${w.base}/api/inbox/threads/${root.thread_id}`, { headers: { "Sec-Fetch-Site": "same-origin", Origin: w.base } })).json()) as { run: { state: string; rex?: { waiting?: string } } | null }).run;
    // A list read keeps Rex's read fresh (as an open window's stream does).
    await until(async () => (await w.agentsOf(), (await runOf())?.state === "waiting_terminal"));
    expect((await runOf())?.rex?.waiting).toBe("permission");
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)).toMatchObject({ place: { kind: "rex", line: "Rex · my-app / Fake Agent" }, rex_mark: { state: "blocked", kind: "permission" } });
  }, 20_000);

  test("Rex chosen: a Send from the tailnet or a paired phone starts in Rex too, as one from this window does", async () => {
    const w = await world({ remote: false, startIn: "rex", phones: true });
    const far = w.tailnet();
    const fromTailnet = await w.sendNew(far.headers, `${far.at}/api/inbox/messages`);
    expect(fromTailnet.launch!.rex).toMatchObject({ line: "Rex · my-app / Fake Agent" });
    const token = await w.pairPhone();
    // The phone app's own request (the device door turns a browser's away before anything starts).
    const fromPhone = await w.sendNew({ Authorization: `Bearer ${token}` }, `${w.base}/api/inbox/device/messages`, false);
    expect(fromPhone.launch!.rex).toMatchObject({ line: "Rex · my-app / Fake Agent" });
    const here = await w.sendNew({ Origin: w.base, "Sec-Fetch-Site": "same-origin" });
    expect(here.launch!.rex).toMatchObject({ line: "Rex · my-app / Fake Agent" });
    // One Rex session for the project, a tab each; Rex's app never moved.
    expect(w.fake.sessions.filter((s) => s.label === "my-app").flatMap((s) => s.windows.map((win) => win.label))).toEqual(["Fake Agent", "Fake Agent", "Fake Agent"]);
    expect(w.fake.methods()).not.toContain("client.perform");
  }, 20_000);

  test("back to the background: the agent started in Rex keeps its place and mark until it ends, one started by hand loses its; then Rex is not contacted", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const { session, ids } = await w.inRex();
    const theirs = w.fake.addSession("their work", "shell");
    await w.agent("ses-by-hand", theirs);
    w.fake.setStatus(ids.block, [{ state: "working", app: "fake-agent" }]);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-by-hand")?.place !== undefined);
    const turned = await fetch(`${w.base}/api/inbox/launch/settings`, { method: "POST", headers: { Origin: w.base, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ serverSession: w.server.serverSession, start_in: "inbox" }) });
    expect(turned.status).toBe(200);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-by-hand")?.place === undefined);
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.rex_mark?.state === "working");
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toMatchObject({ kind: "rex", line: "Rex · my-app / Fake Agent" });
    // It ends (its tab closed: it polls no more), and nothing else is in Rex for the Inbox: no more contact.
    clock.ahead += 60 * 60_000;
    await w.poll("ses-by-hand");
    await Bun.sleep(2_500);
    await w.agentsOf();
    await Bun.sleep(100);
    const before = w.fake.calls.length;
    for (let i = 0; i < 3; i++) {
      await w.agentsOf();
      await Bun.sleep(1_100);
    }
    expect(w.fake.calls.slice(before)).toEqual([]);
  }, 30_000);

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

  test("refused (Remote Control off): not shown, and not offered for a while", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session } = await w.inRex();
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place?.show === true);
    w.fake.setRemote(false);
    expect(await (await w.show(session)).json()).toEqual({ shown: false, refused: true });
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place?.show === undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
  });

  test("another site's page, or a session in no Rex pane: refused, and Rex's app is asked nothing", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session } = await w.inRex();
    await w.agent("ses-nowhere");
    const before = w.fake.calls.length;
    expect((await w.show(session, { "Sec-Fetch-Site": "cross-site", Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await w.show("ses-nowhere")).status).toBe(404);
    expect(w.fake.calls.slice(before).filter((c) => c.method === "client.perform" || c.method === "session.focus_block" || c.method === "session.attach")).toEqual([]);
  });
});

describe("Show in Rex from a window on this computer's own tailnet address", () => {
  test("serve says it came from this computer's own node: offered and shown through this Mac's own app, as this computer's window; another computer's tailnet window is not", async () => {
    const w = await world({ remote: true, startIn: "rex" });
    const { session, ids } = await w.inRex();
    const far = w.tailnet();
    const here = { ...far.headers, "X-Forwarded-For": SELF_IP };
    const elsewhere = { ...far.headers, "X-Forwarded-For": "100.100.2.2" };
    await until(async () => (await w.agentsOf(here, far.at)).find((a) => a.session === session)?.place?.show === true);
    expect((await w.agentsOf(elsewhere, far.at)).find((a) => a.session === session)?.place?.show).toBeUndefined();
    const response = await w.show(session, here, far.at);
    expect(await response.json()).toEqual({ shown: true });
    expect(w.fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  }, 20_000);
});

describe("a Rex with no app on its computer, and Show in Rex from another computer", () => {
  const performed = (fake: FakeRex) => fake.calls.filter((c) => c.method === "client.perform").map((c) => c.payload.client_id);

  test("no app attached: a Send still starts in a tab of Rex, its place shows over the tailnet, and Show in Rex is not offered", async () => {
    const w = await world({ remote: false, startIn: "rex", headless: true });
    const { session } = await w.inRex();
    const far = w.tailnet();
    await until(async () => (await w.agentsOf(far.headers, far.at)).find((a) => a.session === session)?.place !== undefined);
    expect((await w.agentsOf(far.headers, far.at)).find((a) => a.session === session)?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
    expect((await w.agentsOf()).find((a) => a.session === session)?.place?.show).toBeUndefined();
    expect(await (await w.show(session, far.headers, far.at)).json()).toEqual({ shown: false });
    expect(performed(w.fake)).toEqual([]);
  }, 20_000);

  test("an app attached from another computer: the tailnet's window offers Show in Rex, and that app goes to the pane", async () => {
    const w = await world({ remote: false, startIn: "rex", headless: true, apps: [{ id: "a1" }] });
    const { session, ids } = await w.inRex();
    const far = w.tailnet();
    await until(async () => (await w.agentsOf(far.headers, far.at)).find((a) => a.session === session)?.place?.show === true);
    expect(await (await w.show(session, far.headers, far.at)).json()).toEqual({ shown: true, by: ["far-a1"] });
    expect(performed(w.fake)).toEqual([w.fake.farAppId("a1")]);
    expect(w.fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  }, 20_000);

  test("a linked machine's window, on a Mac: its list read offers Show in Rex only for an app attached from elsewhere, and its Show through the door asks that app, never this Mac's own; a phone's token never reaches it", async () => {
    const w = await world({ remote: true, startIn: "rex", phones: true, apps: [{ id: "a1" }] });
    const { session } = await w.inRex();
    const machine = { Authorization: `Bearer ${await w.pairMachine()}` };
    const listed = async () => {
      const model = (await (await fetch(`${w.base}/api/inbox/device/threads`, { headers: machine })).json()) as { agents: InboxAgentsGroup[] };
      return model.agents.flatMap((group) => group.agents).find((a) => a.session === session);
    };
    await until(async () => (await listed())?.place?.show === true);
    const ask = (headers: Record<string, string>) => fetch(`${w.base}/api/inbox/device/rex/show`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ session, idempotency_key: crypto.randomUUID() }) });
    // Only a press in a window there: an agent's bare call through that machine's token moves nothing.
    expect((await ask(machine)).status).toBe(403);
    expect(performed(w.fake)).toEqual([]);
    const shown = await ask({ ...machine, "X-Plannotator-Window": "1" });
    expect({ status: shown.status, body: await shown.json() }).toEqual({ status: 200, body: { shown: true, by: ["far-a1"] } });
    expect(performed(w.fake)).toEqual([w.fake.farAppId("a1")]);
    // That app gone: the linked machine's list stops offering it (this Mac's own app is never a linked machine's to move).
    w.fake.setFarApps([]);
    await until(async () => (await listed())?.place?.show === undefined);
    expect((await listed())?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
    expect(await (await ask({ ...machine, "X-Plannotator-Window": "1" })).json()).toEqual({ shown: false });
    expect(performed(w.fake)).toEqual([w.fake.farAppId("a1")]);
    expect((await ask({ Authorization: `Bearer ${await w.pairPhone()}` })).status).toBe(404);
  }, 20_000);
});

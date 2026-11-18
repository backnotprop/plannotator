/**
 * Rex in a running Inbox (CI runs this: it starts one), with a fake Rex (tests/helpers/fake-rex.ts) as this
 * computer's. What it guards: an agent's place reaches the Agents list only as Rex confirms it, as one line, and only
 * for this computer's own window (the tailnet gets none, and makes no Rex read); a session the Inbox launched in the
 * background never gets one, one it started in Rex gets its own tab's; what the pane says (blocked on a prompt) is the
 * agent's state on the list, with its kind; Show in Rex is offered only after the app confirmed a jump, asks the app only at the click, and a
 * refusal takes the item away; the Show route answers
 * only this computer's own window (never the tailnet, never another site); a session that never said it lives in
 * Rex is never shown there.
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

async function world(options: { remote: boolean; startIn?: "rex" }) {
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
    phones: false,
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
      headers: { Origin: base, "Content-Type": "application/json" },
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
  return { fake, agent, poll, launched, agentsOf, show, tailnet };
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
  test("a place Rex confirms is one line; a session that said none, or a wrong one, has none", async () => {
    const w = await world({ remote: false });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    await w.agent("ses-elsewhere");
    await w.agent("ses-wrong", { session: ids.session, block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" });
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place !== undefined);
    const agents = await w.agentsOf();
    // No Show in Rex yet: Rex's app has not confirmed a jump in this run (its Remote Control may be off).
    expect(agents.find((a) => a.session === "ses-in-rex")?.place).toEqual({ kind: "rex", line: "Rex · my-app / Claude Code" });
    expect(agents.find((a) => a.session === "ses-elsewhere")?.place).toBeUndefined();
    expect(agents.find((a) => a.session === "ses-wrong")?.place).toBeUndefined();
    // Read for the list, the app was asked nothing.
    expect(w.fake.methods()).not.toContain("client.perform");
  });

  test("a pane blocked on a prompt: the agent waits on you, with the kind; working again: working", async () => {
    const w = await world({ remote: false });
    const ids = w.fake.addSession("my-app", "Claude Code");
    w.fake.setStatus(ids.block, [{ state: "blocked", kind: "question", app: "claude-code", msg: "V2hpY2ggb25lPw==" }]);
    await w.agent("ses-blocked", ids);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-blocked")?.rex_status !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === "ses-blocked")).toMatchObject({ state: "waiting", waiting: 0, rex_status: { state: "blocked", kind: "question" } });
    w.fake.setStatus(ids.block, [{ state: "working", app: "claude-code" }]);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-blocked")?.state === "working");
    expect((await w.agentsOf()).find((a) => a.session === "ses-blocked")?.rex_status).toBeUndefined();
  });

  test("started in Rex: the Inbox's own Rex session for the project gets a tab running the agent, and its place is that tab", async () => {
    const w = await world({ remote: false, startIn: "rex" });
    const session = await w.launched();
    const made = w.fake.sessions.find((s) => s.label === "my-app");
    expect(made?.windows.map((win) => win.label)).toEqual(["Fake Agent"]);
    expect(w.fake.calls.find((c) => c.method === "session.create")?.payload).toMatchObject({ initial_windows: [{ layout: { block: { options: { login: true, command: ["/bin/sh", "-c", expect.stringContaining(`--session ${session}`)] } } } }] });
    await w.poll(session, { session: made!.session_id, block: made!.windows[0]!.blocks[0]! });
    await until(async () => (await w.agentsOf()).find((a) => a.session === session)?.place !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toEqual({ kind: "rex", line: "Rex · my-app / Fake Agent" });
  });

  test("a session the Inbox launched in the background gets no place, whatever pane it says", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    const session = await w.launched();
    await w.poll(session, ids);
    await w.agent("ses-in-rex", ids);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place !== undefined);
    expect((await w.agentsOf()).find((a) => a.session === session)?.place).toBeUndefined();
  });

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
  test("this computer's window: Rex's app goes to the pane", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    const response = await w.show("ses-in-rex");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shown: true });
    expect(w.fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  });

  test("offered once the app confirmed a jump; refused (Remote Control off): not shown, and no longer offered", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    expect(await (await w.show("ses-in-rex")).json()).toEqual({ shown: true });
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place?.show === true);
    w.fake.setRemote(false);
    expect(await (await w.show("ses-in-rex")).json()).toEqual({ shown: false, refused: true });
    const place = (await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place;
    expect(place).toEqual({ kind: "rex", line: "Rex · my-app / Claude Code" });
  });

  test("another site, the tailnet, or a session not in Rex: refused, and Rex is asked nothing", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    await w.agent("ses-elsewhere");
    const before = w.fake.calls.length;
    expect((await w.show("ses-in-rex", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.show("ses-in-rex", {})).status).toBe(403);
    const remote = w.tailnet();
    expect((await w.show("ses-in-rex", remote.headers, remote.at)).status).toBe(403);
    expect((await w.show("ses-elsewhere")).status).toBe(404);
    expect(w.fake.calls.slice(before).filter((c) => c.method === "client.perform" || c.method === "session.focus_block")).toEqual([]);
  });
});

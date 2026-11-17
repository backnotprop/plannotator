/**
 * Rex in a running Inbox (CI runs this: it starts one), with a fake Rex (tests/helpers/fake-rex.ts) as this
 * computer's. What it guards: an agent's place reaches the Agents list only as Rex confirms it, as one line; Show in
 * Rex is offered only to a window on this computer and only while Rex's Remote Control is on; the Show route answers
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
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxRex } from "./inbox-rex";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME"] as const;
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

async function world(options: { remote: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-rex-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const project = join(root, "my-app");
  for (const dir of [dataDir, home, project]) mkdirSync(dir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true }));
  const fake = startFakeRex({ remote: options.remote });
  fakes.push(fake);
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(), rex: createInboxRex({ socketPath: fake.socketPath }) });
  servers.push(server);
  const client = new Client({ name: "inbox-rex-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  /** A session writes once (so it is listed) and polls, saying where it lives (or not). */
  const agent = async (session: string, place?: { session: string; block: string }) => {
    await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", agent_host: "claude-code", body: `Hello from ${session}.` } });
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, waitMs: 0, ...(place ? { [INBOX_PLACE_POLL_FIELD]: { kind: "rex", ...place } } : {}) }),
    });
    expect(response.status).toBe(200);
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
  return { fake, agent, agentsOf, show, tailnet };
}

/** Wait for the app's answer about actions (asked in the background after a read). */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
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
    const agents = await w.agentsOf();
    expect(agents.find((a) => a.session === "ses-in-rex")?.place).toEqual({ kind: "rex", line: "Rex · my-app / Claude Code" });
    expect(agents.find((a) => a.session === "ses-elsewhere")?.place).toBeUndefined();
    expect(agents.find((a) => a.session === "ses-wrong")?.place).toBeUndefined();
  });

  test("Show in Rex: offered to this computer's window while Remote Control is on, never over the tailnet", async () => {
    const w = await world({ remote: true });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    await until(async () => (await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place?.show === true);
    const remote = w.tailnet();
    const overTailnet = (await w.agentsOf(remote.headers, remote.at)).find((a) => a.session === "ses-in-rex");
    expect(overTailnet?.place?.show).toBeUndefined();
  });

  test("Remote Control off: never offered", async () => {
    const w = await world({ remote: false });
    const ids = w.fake.addSession("my-app", "Claude Code");
    await w.agent("ses-in-rex", ids);
    await w.agentsOf();
    for (let i = 0; i < 20 && !w.fake.methods().includes("client.perform"); i++) await Bun.sleep(20);
    expect((await w.agentsOf()).find((a) => a.session === "ses-in-rex")?.place?.show).toBeUndefined();
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

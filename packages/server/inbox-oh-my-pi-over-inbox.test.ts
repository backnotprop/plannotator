/**
 * A session started by hand in Oh My Pi, over a real Inbox (#3443; temp data dir, scratch HOME, no agent on PATH):
 * its connection polls as host `pi` with `plugin.host: "oh-my-pi"` and calls the tool as "Pi", as Plannotator's Pi
 * extension does inside Oh My Pi. What this catches: its message stored under "Pi" (the `/mcp` door not naming it from
 * the runtime), the To picker's session (`GET /api/inbox/sessions`) or the Agents list (`GET /api/inbox/threads`)
 * without `runtime`, and a plain Pi session in the same project renamed. The rules alone: inbox-runtime-name.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxAgentName, type InboxAgentsGroup, type InboxComposeProject } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an Oh My Pi session's message is stored as Oh My Pi, and the To picker and the Agents list carry its runtime; a Pi session stays Pi", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-omp-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(home, "code", "harbor");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({
    dataDir: join(root, "data"),
    version: "dev",
    binaryPath: null,
    agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: "" } }),
    updates: { fetchRelease: async () => ({ ok: false, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-omp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);

  const poll = async (session: string, pluginHost: "pi" | "oh-my-pi") => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, host: "pi", waitMs: 0, project_path: project, plugin: { version: "0.28.70", on_disk: "0.28.70", host: pluginHost } }),
    });
    expect(response.status).toBe(200);
  };
  const send = async (session: string) => {
    const result = await client.callTool({ name: "send_message", arguments: { body: `Done in ${session}.`, project_path: project, agent_session: session, agent_host: "pi", agent_name: "Pi" } });
    return (result.structuredContent as { message_id: string }).message_id;
  };

  await poll("omp-1", "oh-my-pi");
  await poll("pi-1", "pi");
  const fromOmp = await send("omp-1");
  const fromPi = await send("pi-1");
  expect(inboxAgentName(server.store.message(fromOmp)!.author)).toBe("Oh My Pi");
  expect(inboxAgentName(server.store.message(fromPi)!.author)).toBe("Pi");
  expect(server.store.message(fromOmp)!.author).toMatchObject({ kind: "agent", host: "pi", session: "omp-1" });

  const window = { "Sec-Fetch-Site": "same-origin", Origin: base };
  const compose = (await (await fetch(`${base}/api/inbox/sessions`, { headers: window })).json()) as { projects: InboxComposeProject[] };
  const sessions = compose.projects.flatMap((group) => group.sessions);
  expect(sessions.find((s) => s.session === "omp-1")).toMatchObject({ host: "pi", runtime: "oh-my-pi" });
  expect(sessions.find((s) => s.session === "pi-1")?.runtime).toBeUndefined();

  const list = (await (await fetch(`${base}/api/inbox/threads`, { headers: window })).json()) as { agents: InboxAgentsGroup[] };
  const agents = list.agents.flatMap((group) => group.agents);
  expect(agents.find((a) => a.session === "omp-1")).toMatchObject({ host: "pi", runtime: "oh-my-pi" });
  expect(agents.find((a) => a.session === "pi-1")?.runtime).toBeUndefined();
});

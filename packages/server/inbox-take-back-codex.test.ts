import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";

const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const fakes: FakeAgents[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  await Bun.sleep(400);
  for (const fake of fakes.splice(0)) fake.remove();
});

const codexMeta = () => ({ threadId: THREAD, sessionId: THREAD, "x-codex-turn-metadata": { thread_id: THREAD, turn_started_at_unix_ms: Date.now(), turn_trigger: "user", codex_version: "0.160.0" } });

async function world() {
  const fake = createFakeAgents("plannotator-take-back-codex-");
  fakes.push(fake);
  fake.install("codex");
  const project = join(fake.root, "ledger");
  mkdirSync(project, { recursive: true });
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_CODEX_QUEUE_DELAY_MS: "150" } });
  const server = await startInboxServer({ dataDir: join(fake.root, "data"), binaryPath: null, agentEnvironment: environment, codexWake: { extraClis: [] } });
  servers.push(server);
  const client = new Client({ name: "codex-mcp-client", version: "0.160.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const asked = (await client.callTool({ name: "send_message", arguments: { body: "Which runner?", project_path: project, agent_session: THREAD, agent_host: "codex", agent_name: "Codex" }, _meta: codexMeta() }))
    .structuredContent as { message_id: string };
  const reply = async (key: string, words: string) => ((await (await post(`messages/${asked.message_id}/reply`, { idempotency_key: key, words })).json()) as { reply: { id: string } }).reply.id;
  const takeBack = async (id: string) => (await post(`messages/${id}/take-back`, {})).status === 200;
  const queued = (id: string) => fake.calls().some((call) => call.name === "codex" && call.args[0] === "queue" && call.args.some((arg) => arg.startsWith("--message=") && arg.includes(`(${id})`)));
  return { server, reply, takeBack, queued };
}

describe("take back against the Codex wake", () => {
  test("a reply queued behind another in the same sweep is never both taken back and queued", async () => {
    const w = await world();
    let takenBack = 0;
    let both = 0;
    for (let i = 0; i < 20; i++) {
      await w.reply(`a${i}`, `Round ${i}: first.`);
      const id = await w.reply(`k${i}`, `Round ${i}: use the ARM runner.`);
      await Bun.sleep(Math.random() * 300);
      const taken = await w.takeBack(id);
      await w.server.codexWake.sweep();
      await Bun.sleep(30);
      await w.server.codexWake.sweep();
      if (taken) takenBack++;
      if (taken && w.queued(id)) both++;
    }
    expect(both).toBe(0);
    expect(takenBack).toBeGreaterThan(0);
  }, 120_000);
});

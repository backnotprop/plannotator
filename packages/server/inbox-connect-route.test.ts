/**
 * The Inbox's agent connections over HTTP: `POST /api/inbox/control/connect`
 * (what `plannotator inbox` sends to an Inbox an agent started) takes the
 * registry's token like every connection route, runs the connect step once at
 * a time, and `GET /api/inbox/agents` reports what it did. Fake agent CLIs and
 * a scratch home (tests/helpers/fake-agents.ts).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

let fake: FakeAgents;
let server: InboxServer | null = null;

beforeEach(() => {
  fake = createFakeAgents("plannotator-connect-route-");
});
afterEach(() => {
  server?.stop();
  server = null;
  fake.remove();
});

async function start(): Promise<InboxServer> {
  server = await startInboxServer({
    dataDir: join(fake.root, "data"),
    selfCommand: ["/opt/plannotator"],
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env }),
  });
  return server;
}

const control = (s: InboxServer, token: string | null, method = "POST") =>
  fetch(`http://127.0.0.1:${s.port}/api/inbox/control/connect`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
  });

test("the connect route needs the registry's token and connects the agents found", async () => {
  fake.install("codex");
  const s = await start();
  expect((await control(s, null)).status).toBe(401);
  expect((await control(s, "wrong")).status).toBe(401);
  expect(fake.calls()).toEqual([]);

  const answer = await control(s, s.token);
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { connect: { added: string[] } };
  expect(body.connect.added).toEqual(["codex"]);

  const agents = (await (await fetch(`http://127.0.0.1:${s.port}/api/inbox/agents`)).json()) as {
    records: Record<string, { state: string; path: string }>;
    last_report: { added: string[]; seen: boolean };
    connecting: boolean;
  };
  expect(agents.records.codex).toMatchObject({ state: "added", path: "~/.codex/config.toml" });
  expect(agents.last_report).toMatchObject({ added: ["codex"], seen: false });
  expect(agents.connecting).toBe(false);
});

test("two runs at once are one run", async () => {
  fake.install("codex");
  const s = await start();
  const [a, b] = await Promise.all([s.connectAgents(), s.connectAgents()]);
  expect(a).toBe(b);
  expect(fake.calls().filter((c) => c.args[1] === "add")).toHaveLength(1);
});

test("the Inbox stopping mid-run kills the agent CLIs still running", async () => {
  fake.install("amp");
  server = await startInboxServer({
    dataDir: join(fake.root, "data"),
    selfCommand: ["/opt/plannotator"],
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_AGENT_HANG: "amp" } }),
  });
  const running = server.connectAgents();
  const started = Date.now();
  while (fake.calls().length === 0 && Date.now() - started < 5000) await Bun.sleep(25);
  expect(fake.live().map((p) => p.name)).toEqual(["amp"]);
  server.stop();
  server = null;
  expect((await running).unfinished).toEqual(["amp"]);
  for (let waited = 0; waited < 1000 && fake.live().length > 0; waited += 25) await Bun.sleep(25);
  expect(fake.live()).toEqual([]);
});

test("a browser request (an Origin) never reaches the connect route", async () => {
  const s = await start();
  const answer = await fetch(`http://127.0.0.1:${s.port}/api/inbox/control/connect`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, Origin: `http://127.0.0.1:${s.port}` },
    body: "{}",
  });
  expect(answer.status).toBe(403);
  expect(fake.calls()).toEqual([]);
});

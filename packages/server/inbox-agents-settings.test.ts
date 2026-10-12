/**
 * Settings → Agents and the first-open card over HTTP (`/api/inbox/agents`,
 * `/agents/notes`, `/agents/seen`): each agent's reach, reminder and note,
 * the person's switches (never re-added once off), the one-time note
 * question, and the window guards. Fake agent CLIs and a scratch home
 * (tests/helpers/fake-agents.ts); config.json lives in the scratch data dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_NOTE_START } from "./inbox-agent-notes";
import { createAgentEnvironmentFor } from "./inbox-agents";

let fake: FakeAgents;
let server: InboxServer | null = null;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-agents-settings-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  server?.stop();
  server = null;
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

interface AgentRow {
  id: string;
  detected: boolean;
  reach: { kind: string; on: boolean; state: string; path: string | null; locked: boolean };
  reminder: { on: boolean; locked: boolean; needs_tool: boolean } | null;
  note: { state: string; path: string | null; create: boolean; reason: string | null } | null;
}
interface Model {
  agents: AgentRow[];
  notes_offered: boolean;
  error?: string | null;
  last_report: { seen: boolean } | null;
}

async function start(extraEnv: Record<string, string> = {}): Promise<InboxServer> {
  server = await startInboxServer({
    dataDir,
    selfCommand: ["/opt/plannotator"],
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extraEnv } }),
  });
  return server;
}

const url = (s: InboxServer, path: string) => `http://127.0.0.1:${s.port}${path}`;
const get = async (s: InboxServer): Promise<Model> => (await fetch(url(s, "/api/inbox/agents"))).json() as Promise<Model>;
const post = async (s: InboxServer, path: string, body: Record<string, unknown>) =>
  fetch(url(s, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: s.serverSession, ...body }) });
const row = (model: Model, id: string) => model.agents.find((agent) => agent.id === id)!;

test("each agent's reach, reminder and note, read without writing anything", async () => {
  fake.install("codex");
  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(join(fake.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
  const s = await start();
  const model = await get(s);
  expect(row(model, "codex")).toMatchObject({ detected: true, reach: { kind: "mcp", on: false, state: "not_connected", path: "~/.codex/config.toml" }, reminder: null, note: { state: "absent", path: "~/.codex/AGENTS.md", create: true } });
  expect(row(model, "claude-code")).toMatchObject({ detected: true, reach: { kind: "tool", on: true }, reminder: { on: true, locked: false }, note: { path: "~/.claude/rules/plannotator-inbox.md" } });
  expect(row(model, "opencode").note).toMatchObject({ state: "unavailable" });
  expect(row(model, "amp").detected).toBe(false);
  expect(model.notes_offered).toBe(false);
  expect(fake.calls()).toEqual([]);
});

test("reach off removes Plannotator's entry and stays off at the next run; on adds it again", async () => {
  fake.install("codex");
  const s = await start();
  await s.connectAgents();
  expect(row(await get(s), "codex").reach.state).toBe("connected");

  const off = (await (await post(s, "/api/inbox/agents", { agent: "codex", reach: false })).json()) as Model;
  expect(off.error).toBeNull();
  expect(row(off, "codex").reach).toMatchObject({ on: false, state: "off" });
  expect(fake.calls().at(-1)?.args).toEqual(["mcp", "remove", "plannotator-inbox"]);

  await s.connectAgents();
  expect(fake.calls().filter((c) => c.args[1] === "add")).toHaveLength(1);

  const on = (await (await post(s, "/api/inbox/agents", { agent: "codex", reach: true })).json()) as Model;
  expect(row(on, "codex").reach.state).toBe("connected");
});

test("the reminder switch per host, and the tool switch for Pi's extension", async () => {
  mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  const s = await start();
  expect(row(await get(s), "pi").reminder).toMatchObject({ on: false, needs_tool: true });
  await post(s, "/api/inbox/agents", { agent: "pi", reach: true });
  expect(row(await get(s), "pi").reminder).toMatchObject({ on: true, needs_tool: false });
  const model = (await (await post(s, "/api/inbox/agents", { agent: "pi", reminder: false })).json()) as Model;
  expect(row(model, "pi").reminder?.on).toBe(false);
  expect(loadConfig()).toMatchObject({ inboxTool: { pi: true }, inboxReminder: { pi: false } });
});

test("PLANNOTATOR_INBOX_TOOL locks the tool and reminder switches", async () => {
  const s = await start({ PLANNOTATOR_INBOX_TOOL: "0" });
  const model = (await (await post(s, "/api/inbox/agents", { agent: "claude-code", reminder: true })).json()) as Model;
  expect(model.error).toBe("PLANNOTATOR_INBOX_TOOL decides this");
  expect(row(model, "claude-code").reach.locked).toBe(true);
  expect(loadConfig().inboxReminder).toBeUndefined();
});

test("the card's question: the ticked notes are added, Not now adds none, and it is never asked again", async () => {
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), "Mine.\n");
  const s = await start();
  const answer = (await (await post(s, "/api/inbox/agents/notes", { add: ["codex", "gemini"] })).json()) as Model & { results: { ok: boolean; action: string }[] };
  expect(answer.results.map((r) => r.action)).toEqual(["added", "created"]);
  expect(answer.notes_offered).toBe(true);
  expect(readFileSync(join(fake.home, ".codex", "AGENTS.md"), "utf8")).toContain(INBOX_NOTE_START);
  expect(existsSync(join(fake.home, ".gemini", "GEMINI.md"))).toBe(true);
  const off = (await (await post(s, "/api/inbox/agents", { agent: "gemini", note: false })).json()) as Model;
  expect(row(off, "gemini").note?.state).toBe("absent");
  expect(existsSync(join(fake.home, ".gemini", "GEMINI.md"))).toBe(false);
  expect((await post(s, "/api/inbox/agents/notes", { add: ["vscode"] })).status).toBe(422);
});

test("the card's head is closed once (seen)", async () => {
  fake.install("codex");
  const s = await start();
  await s.connectAgents();
  expect((await get(s)).last_report?.seen).toBe(false);
  const model = (await (await post(s, "/api/inbox/agents/seen", {})).json()) as Model;
  expect(model.last_report?.seen).toBe(true);
});

test("the window guards: another site, an old tab", async () => {
  const s = await start();
  const cross = await fetch(url(s, "/api/inbox/agents/notes"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ add: ["codex"] }),
  });
  expect(cross.status).toBe(403);
  const stale = await fetch(url(s, "/api/inbox/agents/notes"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "old", add: ["codex"] }) });
  expect(stale.status).toBe(409);
  expect(existsSync(join(fake.home, ".codex", "AGENTS.md"))).toBe(false);
});

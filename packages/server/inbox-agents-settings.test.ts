/**
 * Settings → Agents and the first-open card over HTTP (`/api/inbox/agents`,
 * `/agents/notes`, `/agents/seen`): each agent's reach, reminder and note,
 * the person's switches (never re-added once off), the one-time note
 * question, and the window guards. Fake agent CLIs and a scratch home
 * (tests/helpers/fake-agents.ts); config.json lives in the scratch data dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_NOTE_START } from "./inbox-agent-notes";
import { claudePluginStateFromScopes, createAgentEnvironmentFor } from "./inbox-agents";

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

test("the first-run screen's plugin field: Claude Code found on PATH without the plugin is left to the person; with the plugin it is the tool; Pi and OpenCode say whether theirs is installed", async () => {
  // A `claude` on PATH that is never run (reading the model runs no agent CLI).
  writeFileSync(join(fake.bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fake.install("pi", "opencode");
  mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  const s = await start();
  const before = (await get(s)) as Model & { agents: (AgentRow & { plugin?: { installed: boolean } | null })[] };
  const claude = before.agents.find((agent) => agent.id === "claude-code")!;
  expect(claude).toMatchObject({ detected: true, reach: { kind: "manual", on: false, state: "manual" }, plugin: { installed: false } });
  expect(before.agents.find((agent) => agent.id === "pi")).toMatchObject({ detected: true, reach: { kind: "tool" }, plugin: { installed: true } });
  expect(before.agents.find((agent) => agent.id === "opencode")).toMatchObject({ detected: true, reach: { kind: "manual" }, plugin: { installed: false } });
  expect(before.agents.find((agent) => agent.id === "codex")).toMatchObject({ plugin: null });
  // Turning Claude Code on without its plugin is refused: there is nothing to turn on.
  const refused = (await (await post(s, "/api/inbox/agents", { agent: "claude-code", reach: true })).json()) as Model;
  expect(refused.error).toContain("Claude Code is connected by hand");

  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(join(fake.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
  const after = (await get(s)) as Model & { agents: (AgentRow & { plugin?: { installed: boolean } | null })[] };
  expect(after.agents.find((agent) => agent.id === "claude-code")).toMatchObject({ detected: true, reach: { kind: "tool", on: true }, plugin: { installed: true } });
  expect(fake.calls()).toEqual([]);
});

test("Claude Code's plugin is found in every scope the Inbox can read: settings.local.json, the plugin registry; an explicit false in settings wins over the registry", async () => {
  const claude = join(fake.home, ".claude");
  mkdirSync(join(claude, "plugins"), { recursive: true });
  const s = await start();
  const plugin = async () => ((await get(s)) as Model & { agents: (AgentRow & { plugin?: { installed: boolean } | null })[] }).agents.find((a) => a.id === "claude-code")!.plugin;
  expect(await plugin()).toEqual({ installed: false });
  writeFileSync(join(claude, "settings.local.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
  expect(await plugin()).toEqual({ installed: true });
  rmSync(join(claude, "settings.local.json"));
  // The registry (v2: { plugins: { id: [records] } }) records it: installed, unless a settings scope turns it off.
  writeFileSync(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "plannotator@plannotator": [{ scope: "user" }] } }));
  expect(await plugin()).toEqual({ installed: true });
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": false } }));
  // Turned off by name (`claude plugin disable`): not installed for the Inbox, and said, so the screen never offers installing it.
  expect(await plugin()).toEqual({ installed: false, disabled: true });
});

test("Claude Code's mod off (claudeCodeMod in config.json, or PLANNOTATOR_CLAUDE_MOD=0): the plugin gives no Inbox tool, so it is not connected", async () => {
  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(join(fake.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claudeCodeMod: false }));
  const s = await start();
  type Row = AgentRow & { tool?: { on: boolean; mod_off?: boolean } | null; plugin?: { installed: boolean } | null };
  const claude = async (srv: InboxServer) => ((await get(srv)) as Model & { agents: Row[] }).agents.find((a) => a.id === "claude-code")!;
  expect(await claude(s)).toMatchObject({ detected: true, reach: { kind: "tool", on: false, state: "off" }, tool: { on: false, mod_off: true }, plugin: { installed: true } });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
  expect(await claude(s)).toMatchObject({ reach: { kind: "tool", on: true }, tool: { on: true } });
  expect((await claude(s)).tool?.mod_off).toBeUndefined();
  server?.stop();
  const env = await start({ PLANNOTATOR_CLAUDE_MOD: "0" });
  expect(await claude(env)).toMatchObject({ reach: { on: false }, tool: { on: false, mod_off: true } });
});

test("Claude Code without its plugin, connected by hand (claude mcp add --scope user): it reaches the Inbox through MCP; another program under the name does not count", async () => {
  writeFileSync(join(fake.bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // CLAUDE_CONFIG_DIR is set in the fake environment, so Claude Code's global config is $CLAUDE_CONFIG_DIR/.claude.json.
  const file = join(fake.home, ".claude", ".claude.json");
  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { "plannotator-inbox": { type: "stdio", command: "/usr/local/bin/plannotator", args: ["inbox", "mcp"] } } }));
  const s = await start();
  expect(row(await get(s), "claude-code").reach).toMatchObject({ kind: "mcp", on: true, state: "connected" });
  writeFileSync(file, JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "my-proxy", args: [] } } }));
  expect(row(await get(s), "claude-code").reach).toMatchObject({ kind: "manual", on: false });
  expect(fake.calls()).toEqual([]);
});

test("OpenCode's generation is the one on PATH: opencode2 is OpenCode 2, opencode alone is OpenCode 1", async () => {
  const s = await start();
  const opencode = async () => ((await get(s)) as Model & { agents: (AgentRow & { plugin?: unknown })[] }).agents.find((a) => a.id === "opencode")!.plugin;
  expect(await opencode()).toEqual({ installed: false });
  fake.install("opencode");
  expect(await opencode()).toEqual({ installed: false, generation: "1" });
  fake.install("opencode2" as never);
  expect(await opencode()).toEqual({ installed: false, generation: "2" });
});

test("turning Pi's extension tool on removes the MCP entry Plannotator added before the extension, so Pi never carries both", async () => {
  fake.install("pi");
  const s = await start();
  // Pi without the extension: the window's Connect adds the MCP entry (`pi mcp add`).
  expect((await (await post(s, "/api/inbox/agents", { agent: "pi", reach: true })).json() as Model).error ?? null).toBeNull();
  const mcp = join(fake.home, ".pi", "agent", "mcp.json");
  expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["plannotator-inbox"]).toBeDefined();
  // The person installs the extension, then turns its tool on.
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  const model = (await (await post(s, "/api/inbox/agents", { agent: "pi", reach: true })).json()) as Model;
  expect(model.error ?? null).toBeNull();
  expect(row(model, "pi").reach).toMatchObject({ kind: "tool", on: true });
  expect(loadConfig().inboxTool).toEqual({ pi: true });
  expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["plannotator-inbox"]).toBeUndefined();
  expect(fake.calls().map((call) => call.args.slice(0, 2).join(" "))).toEqual(["mcp add", "mcp remove"]);
});

test("a tool turned off by name in config.json is chosen_off; the host default is not", async () => {
  mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  const s = await start();
  const pi = async () => ((await get(s)) as Model & { agents: (AgentRow & { tool?: { on: boolean; chosen_off?: boolean } | null })[] }).agents.find((a) => a.id === "pi")!.tool;
  expect(await pi()).toMatchObject({ on: false, chosen_off: false });
  await post(s, "/api/inbox/agents", { agent: "pi", reach: false });
  expect(await pi()).toMatchObject({ on: false, chosen_off: true });
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

test("Qwen Code connected under another QWEN_HOME: Settings shows it off with where it is; turning it on into a settings.json Qwen would refuse keeps the old entry; fixed, it moves", async () => {
  fake.install("qwen");
  const mine = '{\n  // mine\n  "mcpServers": {}\n}\n';
  mkdirSync(join(fake.home, ".qwen"), { recursive: true });
  writeFileSync(join(fake.home, ".qwen", "settings.json"), mine);
  const first = await start();
  await first.connectAgents();
  const connected = readFileSync(join(fake.home, ".qwen", "settings.json"), "utf8");
  expect(connected).toContain("plannotator-inbox");
  first.stop();

  // The Inbox started from a shell with another QWEN_HOME, whose settings.json has a trailing comma.
  const other = join(fake.root, "other-qwen");
  mkdirSync(other, { recursive: true });
  const trailing = '{\n  "mcpServers": { "x": { "command": "y" }, },\n}\n';
  writeFileSync(join(other, "settings.json"), trailing);
  const s = await start({ QWEN_HOME: other });
  await s.connectAgents();
  const shown = await get(s);
  expect(row(shown, "qwen").reach).toMatchObject({ kind: "mcp", on: false, state: "elsewhere", path: "~/.qwen/settings.json" });

  // The switch: on (as the UI sends it), refused, nothing changed anywhere.
  const refused = (await (await post(s, "/api/inbox/agents", { agent: "qwen", reach: true })).json()) as Model;
  expect(refused.error).toContain("stays connected in ~/.qwen/settings.json");
  expect(readFileSync(join(fake.home, ".qwen", "settings.json"), "utf8")).toBe(connected);
  expect(readFileSync(join(other, "settings.json"), "utf8")).toBe(trailing);
  expect(row(refused, "qwen").reach.state).toBe("elsewhere");

  // The person fixes it: on moves it, and the old file is theirs again, byte for byte.
  writeFileSync(join(other, "settings.json"), '{\n  "mcpServers": { "x": { "command": "y" } }\n}\n');
  const moved = (await (await post(s, "/api/inbox/agents", { agent: "qwen", reach: true })).json()) as Model;
  expect(moved.error).toBeNull();
  expect(row(moved, "qwen").reach).toMatchObject({ on: true, state: "connected" });
  expect(readFileSync(join(fake.home, ".qwen", "settings.json"), "utf8")).toBe(mine);
  expect(readFileSync(join(other, "settings.json"), "utf8")).toContain("plannotator-inbox");
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
  // No plugin in this home: the lock shows on the tool switch (with the plugin it is the reach switch).
  expect(row(model, "claude-code").tool?.locked).toBe(true);
  expect(row(model, "claude-code").plugin).toEqual({ installed: false });
  expect(loadConfig().inboxReminder).toBeUndefined();
});

test("the card's question: the ticked notes are added, Not now adds none, and it is never asked again", async () => {
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), "Mine.\n");
  mkdirSync(join(fake.home, ".gemini"), { recursive: true });
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

test("Try again: a failure the person fixed leaves the last report, so the card's amber line goes and the agent can take a note", async () => {
  fake.install("codex");
  const failFile = join(fake.root, "fail");
  writeFileSync(failFile, "codex");
  const s = await start({ FAKE_AGENT_FAIL_FILE: failFile });
  await s.connectAgents();
  const failed = await get(s);
  expect((failed.last_report as unknown as { failed: { agent: string }[] }).failed.map((f) => f.agent)).toEqual(["codex"]);
  const still = (await (await post(s, "/api/inbox/agents", { agent: "codex", reach: true })).json()) as Model;
  expect(still.error).toContain("codex mcp add exited with code 3");
  writeFileSync(failFile, "");
  const fixed = (await (await post(s, "/api/inbox/agents", { agent: "codex", reach: true })).json()) as Model;
  expect(fixed.error).toBeNull();
  expect((fixed.last_report as unknown as { failed: unknown[] }).failed).toEqual([]);
  expect(row(fixed, "codex").reach.state).toBe("connected");
});

test("the Inbox tool switch of Claude Code, Pi and OpenCode stays in reach when the agent is not found here", async () => {
  const s = await start();
  const model = await get(s);
  for (const id of ["claude-code", "pi", "opencode"]) {
    expect(row(model, id).detected).toBe(false);
    expect((row(model, id) as AgentRow & { tool: { on: boolean } }).tool).toBeDefined();
  }
  const on = (await (await post(s, "/api/inbox/agents", { agent: "pi", tool: true })).json()) as Model & { agents: (AgentRow & { tool: { on: boolean } })[] };
  expect(on.agents.find((a) => a.id === "pi")!.tool.on).toBe(true);
  expect(loadConfig().inboxTool).toEqual({ pi: true });
});

test("the card never writes a note for an agent not found here, and a question whose every add failed stays open", async () => {
  const s = await start();
  const answer = (await (await post(s, "/api/inbox/agents/notes", { add: ["gemini"] })).json()) as Model & { results: { ok: boolean; reason?: string }[] };
  expect(answer.results).toEqual([{ ok: false, agent: "gemini", reason: "Gemini CLI was not found on this computer", path: null }] as never);
  expect(answer.notes_offered).toBe(false);
  expect(existsSync(join(fake.home, ".gemini"))).toBe(false);
});

test("Settings' note switch refuses an agent not found here too, and writes nothing", async () => {
  const s = await start();
  const refused = (await (await post(s, "/api/inbox/agents", { agent: "gemini", note: true })).json()) as Model & { error: string | null };
  expect(refused.error).toBe("Gemini CLI was not found on this computer");
  expect(existsSync(join(fake.home, ".gemini"))).toBe(false);
  expect(existsSync(join(dataDir, "inbox", "agent-notes.json"))).toBe(false);
});

test("PLANNOTATOR_INBOX_NOTES=0: no offer, no row for an agent without a note, a note cannot be added, and one already written is listed so it can be turned off", async () => {
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), "Mine.\n");
  mkdirSync(join(fake.home, ".gemini"), { recursive: true });
  // A note written before the variable was set.
  const before = await start();
  await post(before, "/api/inbox/agents", { agent: "gemini", note: true });
  await before.stop();
  const s = await start({ PLANNOTATOR_INBOX_NOTES: "0" });
  const model = await get(s);
  expect(row(model, "codex").note).toBeNull();
  expect(row(model, "gemini").note?.state).toBe("added");
  expect((model as unknown as { notes_env_off: boolean }).notes_env_off).toBe(true);
  const refused = await post(s, "/api/inbox/agents", { agent: "codex", note: true });
  expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([400, "notes_disabled"]);
  expect(readFileSync(join(fake.home, ".codex", "AGENTS.md"), "utf8")).toBe("Mine.\n");
  const off = (await (await post(s, "/api/inbox/agents", { agent: "gemini", note: false })).json()) as Model;
  expect(row(off, "gemini").note).toBeNull();
  // Plannotator created GEMINI.md for the note, so turning it off removes the file.
  expect(existsSync(join(fake.home, ".gemini", "GEMINI.md"))).toBe(false);
});

// The approved "inbox-agent-note-dialog" design: the question is asked once PER AGENT.
type Asked = Model & { notes_asked: string[]; results?: { ok: boolean; agent: string }[] };

test("asked once per agent: Not now answers only for the agents the dialog showed; an agent that connects later is asked alone", async () => {
  fake.install("codex");
  const s = await start();
  await s.connectAgents();
  const first = (await get(s)) as Asked;
  expect(first.notes_asked).toEqual([]);
  expect(row(first, "codex").note?.state).toBe("absent");
  const notNow = (await (await post(s, "/api/inbox/agents/notes", { add: [], asked: ["codex"], seen: true })).json()) as Asked;
  expect(notNow.notes_asked).toEqual(["codex"]);
  expect(notNow.notes_offered).toBe(true);
  expect(notNow.last_report?.seen).toBe(true);
  // Nothing written without a yes.
  expect(existsSync(join(fake.home, ".codex", "AGENTS.md"))).toBe(false);

  fake.install("codex", "gemini");
  await s.connectAgents();
  const later = (await get(s)) as Asked;
  expect(later.notes_asked).toEqual(["codex"]);
  expect(row(later, "gemini")).toMatchObject({ detected: true, reach: { on: true }, note: { state: "absent" } });
  const add = (await (await post(s, "/api/inbox/agents/notes", { add: ["gemini"], asked: ["gemini"], seen: true })).json()) as Asked;
  expect(add.results?.map((r) => [r.agent, r.ok])).toEqual([["gemini", true]]);
  expect(add.notes_asked).toEqual(["codex", "gemini"]);
  expect(loadConfig().inboxAgentNotes).toEqual({ offered: true, asked: ["codex", "gemini"] });
});

test("an add that failed leaves that agent unasked (it is asked again); the others shown are answered", async () => {
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), "Mine.\n");
  const s = await start();
  // Gemini is not on this computer: its add fails.
  const answer = (await (await post(s, "/api/inbox/agents/notes", { add: ["codex", "gemini"], asked: ["codex", "gemini", "claude-code"] })).json()) as Asked;
  expect(answer.results?.map((r) => [r.agent, r.ok])).toEqual([["codex", true], ["gemini", false]]);
  expect(answer.notes_asked).toEqual(["claude-code", "codex"]);
});

test("a config from 0.28.18 (offered, no list): the agents that could take a note count as asked, an agent found later does not", async () => {
  fake.install("codex");
  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(join(fake.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
  const s = await start();
  await s.connectAgents();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAgentNotes: { offered: true } }));
  const migrated = (await get(s)) as Asked;
  expect(migrated.notes_asked).toEqual(["claude-code", "codex"]);
  expect(loadConfig().inboxAgentNotes).toEqual({ offered: true, asked: ["claude-code", "codex"] });

  fake.install("codex", "gemini");
  await s.connectAgents();
  const later = (await get(s)) as Asked;
  expect(later.notes_asked).toEqual(["claude-code", "codex"]);
  expect(row(later, "gemini").note?.state).toBe("absent");
});

test("a config from 0.28.18 whose person said yes: an agent with the note counts as asked, so removing the note never asks again", async () => {
  fake.install("codex", "gemini");
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), "Mine.\n");
  const s = await start();
  await s.connectAgents();
  // 0.28.18: the card's Add wrote Codex's note and saved only `offered`.
  await post(s, "/api/inbox/agents/notes", { add: ["codex"], asked: ["codex"] });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAgentNotes: { offered: true } }));
  const migrated = (await get(s)) as Asked;
  expect(migrated.notes_asked).toEqual(["codex", "gemini"]);
  const removed = (await (await post(s, "/api/inbox/agents", { agent: "codex", note: false })).json()) as Asked;
  expect(row(removed, "codex").note?.state).toBe("absent");
  expect(removed.notes_asked).toEqual(["codex", "gemini"]);
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex", "gemini"]);
});

test("a yes in Settings → Agents answers the dialog for that agent: removing the note later never asks again", async () => {
  fake.install("codex");
  const s = await start();
  await s.connectAgents();
  expect(((await get(s)) as Asked).notes_asked).toEqual([]);
  const on = (await (await post(s, "/api/inbox/agents", { agent: "codex", note: true })).json()) as Asked;
  expect(on.error).toBeNull();
  expect(on.notes_asked).toEqual(["codex"]);
  const off = (await (await post(s, "/api/inbox/agents", { agent: "codex", note: false })).json()) as Asked;
  expect(row(off, "codex").note?.state).toBe("absent");
  expect(off.notes_asked).toEqual(["codex"]);
});

test("a note already in an agent's file (written by hand or an older Inbox, no record) counts as asked", async () => {
  fake.install("codex");
  mkdirSync(join(fake.home, ".codex"), { recursive: true });
  const s = await start();
  await s.connectAgents();
  writeFileSync(join(fake.home, ".codex", "AGENTS.md"), `Mine.\n\n${(await get(s) as unknown as { note_text: string }).note_text}\n`);
  const model = (await get(s)) as Asked;
  expect(row(model, "codex").note?.state).toBe("added");
  expect(model.notes_asked).toEqual(["codex"]);
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex"]);
});

test("a window older than the dialog (no asked list): the agents that can take a note now count as asked", async () => {
  fake.install("codex");
  const s = await start();
  await s.connectAgents();
  const answer = (await (await post(s, "/api/inbox/agents/notes", { add: [] })).json()) as Asked;
  expect(answer.notes_asked).toEqual(["codex"]);
});

test("the answer's fields are checked", async () => {
  const s = await start();
  expect((await post(s, "/api/inbox/agents/notes", { add: [], asked: ["vscode"] })).status).toBe(422);
  expect((await post(s, "/api/inbox/agents/notes", { add: [], asked: "codex" })).status).toBe(422);
  expect((await post(s, "/api/inbox/agents/notes", { add: [], seen: "yes" })).status).toBe(422);
  expect(loadConfig().inboxAgentNotes).toBeUndefined();
});

// The independent review's follow-ups on #1974.

type FullRow = AgentRow & { tool?: { on: boolean; mod_off?: boolean } | null; plugin?: Record<string, unknown> | null };
const claudeRow = async (srv: InboxServer) => ((await get(srv)) as Model & { agents: FullRow[] }).agents.find((a) => a.id === "claude-code")!;
const claudeSettings = (value: unknown, name = "settings.json") => {
  mkdirSync(join(fake.home, ".claude"), { recursive: true });
  writeFileSync(join(fake.home, ".claude", name), JSON.stringify(value));
};

test("the mod's own precedence: PLANNOTATOR_CLAUDE_MOD in Claude Code's settings env wins over this process's env and config.json", async () => {
  claudeSettings({ enabledPlugins: { "plannotator@plannotator": true }, env: { PLANNOTATOR_CLAUDE_MOD: "0" } });
  const s = await start({ PLANNOTATOR_CLAUDE_MOD: "1" });
  expect(await claudeRow(s)).toMatchObject({ reach: { kind: "tool", on: false }, tool: { mod_off: true }, reminder: { on: false, needs_tool: true } });
  // Settings → Agents' switch would change nothing: refused with why.
  const refused = (await (await post(s, "/api/inbox/agents", { agent: "claude-code", reach: true })).json()) as Model;
  expect(refused.error).toContain("Claude Code mod is off");
  // settings.local.json, the stronger user scope, turns it back on.
  claudeSettings({ env: { PLANNOTATOR_CLAUDE_MOD: "1" } }, "settings.local.json");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claudeCodeMod: false }));
  expect(await claudeRow(s)).toMatchObject({ reach: { on: true }, tool: { on: true } });
  expect((await claudeRow(s)).tool?.mod_off).toBeUndefined();
});

test("a disabled plugin or the mod off never hides a hand-added MCP entry; ~/.claude.json is read when CLAUDE_CONFIG_DIR is unset, past 1 MiB", async () => {
  writeFileSync(join(fake.bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  claudeSettings({ enabledPlugins: { "plannotator@plannotator": false } });
  // A big ~/.claude.json, as Claude Code's project history makes it.
  const big = { projects: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`/p/${i}`, { history: "x".repeat(5000) }])), mcpServers: { "plannotator-inbox": { command: "/opt/plannotator", args: ["inbox", "mcp"] } } };
  writeFileSync(join(fake.home, ".claude.json"), JSON.stringify(big));
  expect(readFileSync(join(fake.home, ".claude.json")).length).toBeGreaterThan(1024 * 1024);
  const s = await start({ CLAUDE_CONFIG_DIR: "" });
  expect(await claudeRow(s)).toMatchObject({ reach: { kind: "mcp", on: true, path: "~/.claude.json" }, plugin: { installed: false, disabled: true } });
  server?.stop();
  claudeSettings({ enabledPlugins: { "plannotator@plannotator": true } });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ claudeCodeMod: false }));
  const mod = await start({ CLAUDE_CONFIG_DIR: "" });
  expect(await claudeRow(mod)).toMatchObject({ reach: { kind: "mcp", on: true }, tool: { mod_off: true }, plugin: { installed: true } });
});

test("managed settings turning the plugin off win over the user's true, and say so", () => {
  expect(claudePluginStateFromScopes([{ scope: "managed", on: false }, { scope: "user", on: true }], true)).toEqual({ state: "disabled", managed: true });
  expect(claudePluginStateFromScopes([{ scope: "managed", on: undefined }, { scope: "user", on: false }, { scope: "user", on: true }], true)).toEqual({ state: "disabled", managed: false });
  expect(claudePluginStateFromScopes([{ scope: "user", on: undefined }], true)).toEqual({ state: "enabled", managed: false });
  expect(claudePluginStateFromScopes([], false)).toEqual({ state: "absent", managed: false });
});

test("OpenCode's generation from evidence: the global config's shape wins over the commands on PATH", async () => {
  fake.install("opencode2" as never);
  const s = await start();
  const opencode = async () => ((await get(s)) as Model & { agents: FullRow[] }).agents.find((a) => a.id === "opencode")!.plugin;
  expect(await opencode()).toEqual({ installed: false, generation: "2" });
  mkdirSync(join(fake.home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(fake.home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["some-other-plugin"] }));
  expect(await opencode()).toEqual({ installed: false, generation: "1" });
});

test("Turn on removes Pi's MCP entry first: if it cannot be removed, the tool stays off and MCP keeps working", async () => {
  fake.install("pi");
  const failFile = join(fake.root, "fail");
  const s = await start({ FAKE_AGENT_FAIL_FILE: failFile });
  await post(s, "/api/inbox/agents", { agent: "pi", reach: true });
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  writeFileSync(failFile, "pi");
  const model = (await (await post(s, "/api/inbox/agents", { agent: "pi", reach: true })).json()) as Model;
  expect(model.error).toContain("could not be removed, so its Inbox tool stays off");
  expect(loadConfig().inboxTool).toBeUndefined();
  expect(JSON.parse(readFileSync(join(fake.home, ".pi", "agent", "mcp.json"), "utf8")).mcpServers["plannotator-inbox"]).toBeDefined();
});

test("the connect run replaces Pi's MCP entry once the extension is there and its tool is on", async () => {
  fake.install("pi");
  const s = await start();
  await s.connectAgents();
  const mcp = join(fake.home, ".pi", "agent", "mcp.json");
  expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["plannotator-inbox"]).toBeDefined();
  writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
  // The tool still off (Pi's default): the MCP entry is Pi's only way in, so it stays.
  await s.connectAgents();
  expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["plannotator-inbox"]).toBeDefined();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
  await s.connectAgents();
  expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["plannotator-inbox"]).toBeUndefined();
  expect(row(await get(s), "pi").reach).toMatchObject({ kind: "tool", on: true });
});

test("Cursor's note is copied by hand: the card answers it as shown to copy only when Cursor is here, and never writes a file; Settings has no switch for it", async () => {
  const s = await start();
  const missing = (await (await post(s, "/api/inbox/agents/notes", { add: ["cursor"] })).json()) as Model & { results: unknown[] };
  expect(missing.results).toEqual([{ ok: false, agent: "cursor", reason: "Cursor was not found on this computer", path: null }]);
  expect(existsSync(join(fake.home, ".cursor"))).toBe(false);
  s.stop();
  fake.install("cursor-agent");
  const found = await start();
  const answer = (await (await post(found, "/api/inbox/agents/notes", { add: ["cursor"] })).json()) as Model & { results: unknown[] };
  expect(answer.results).toEqual([{ ok: true, agent: "cursor", action: "manual", path: null }]);
  expect(existsSync(join(fake.home, ".cursor"))).toBe(false);
  expect(existsSync(join(dataDir, "inbox", "agent-notes.json"))).toBe(false);
  const note = row(answer, "cursor").note!;
  expect(note).toMatchObject({ state: "manual", path: null, create: false });
  expect(note.reason).toContain("Customize → Rules");
  expect((await post(found, "/api/inbox/agents", { agent: "cursor", note: true })).status).toBe(422);
});

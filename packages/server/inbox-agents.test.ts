/**
 * Connecting the agents on this computer to the Inbox (inbox-agents.ts), with
 * fake agent CLIs on a scratch PATH and a scratch home (tests/helpers/
 * fake-agents.ts): what is found, what each agent gets, what is never
 * touched, what a later run does, and what uninstall removes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  agentHomeAllowed,
  connectInboxAgents,
  createAgentEnvironmentFor,
  formatConnectReport,
  isPlannotatorInboxCommand,
  planInboxAgentRemoval,
  readCodexEntry,
  readInboxAgents,
  writeJsonEntry,
  type AgentEnvironment,
} from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents();
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  // config.json (inboxTool) is read through the env, as the Inbox reads it.
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}, platform: NodeJS.Platform = "linux"): AgentEnvironment {
  return createAgentEnvironmentFor({ platform, homeDir: fake.home, env: { ...fake.env, ...extra } });
}

function connect(extra: Record<string, string> = {}, options: { agentTimeoutMs?: number; totalTimeoutMs?: number; platform?: NodeJS.Platform } = {}) {
  return connectInboxAgents({
    dataDir,
    selfCommand: SELF,
    environment: environment(extra, options.platform),
    agentTimeoutMs: options.agentTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  });
}

const adds = () => fake.calls().filter((call) => call.args[1] === "add");

describe("what is found", () => {
  test("nothing installed: nothing is run or written, and nothing is said", async () => {
    const report = await connect();
    expect(report.added).toEqual([]);
    expect(fake.calls()).toEqual([]);
    expect(formatConnectReport(report)).toEqual([]);
  });

  test("PLANNOTATOR_INBOX_CONNECT=0 skips the whole step", async () => {
    fake.install("codex");
    const report = await connect({ PLANNOTATOR_INBOX_CONNECT: "0" });
    expect(report.skipped).toBe("env");
    expect(fake.calls()).toEqual([]);
  });

  test("a test run whose home is not a scratch folder never touches it", () => {
    expect(agentHomeAllowed({ homeDir: "/Users/somebody-real", env: { PLANNOTATOR_TEST_SANDBOX: "/tmp/x" } })).toBe(false);
    expect(agentHomeAllowed({ homeDir: fake.home, env: { PLANNOTATOR_TEST_SANDBOX: "/tmp/x" } })).toBe(true);
  });
});

describe("agents with their own `mcp add`", () => {
  test("Codex: `codex mcp add plannotator-inbox -- <this CLI> inbox mcp`, recorded, then left alone", async () => {
    fake.install("codex");
    const report = await connect();
    expect(report.added).toEqual(["codex"]);
    expect(adds()).toEqual([{ name: "codex", args: ["mcp", "add", "plannotator-inbox", "--", ...SELF, "inbox", "mcp"] }]);
    expect(readCodexEntry(join(fake.home, ".codex", "config.toml"))).toEqual({ kind: "ours", argv: [...SELF, "inbox", "mcp"] });
    expect(readInboxAgents(dataDir).agents.codex).toMatchObject({ state: "added", reach: "mcp" });

    const again = await connect();
    expect(again.added).toEqual([]);
    expect(again.already).toEqual(["codex"]);
    expect(adds()).toHaveLength(1);
    expect(formatConnectReport(again)).toEqual([]);
  });

  test("Gemini, Windsurf/Devin, Amp and Pi (no extension) each get their own command", async () => {
    fake.install("gemini", "devin", "amp", "pi");
    const report = await connect();
    expect(report.added.sort()).toEqual(["amp", "gemini", "pi", "windsurf"]);
    const byName = Object.fromEntries(adds().map((call) => [call.name, call.args]));
    expect(byName.gemini).toEqual(["mcp", "add", "-s", "user", "plannotator-inbox", ...SELF, "inbox", "mcp"]);
    expect(byName.devin).toEqual(["mcp", "add", "-s", "user", "plannotator-inbox", "--", ...SELF, "inbox", "mcp"]);
    expect(byName.amp).toEqual(["mcp", "add", "plannotator-inbox", "--", ...SELF, "inbox", "mcp"]);
    expect(byName.pi).toEqual(["mcp", "add", "plannotator-inbox", "--", ...SELF, "inbox", "mcp"]);
  });

  test("an entry that already runs Plannotator (any path) is found, not added again", async () => {
    fake.install("codex");
    mkdirSync(join(fake.home, ".codex"), { recursive: true });
    writeFileSync(join(fake.home, ".codex", "config.toml"), '[mcp_servers."plannotator-inbox"]\ncommand = "/usr/local/bin/plannotator"\nargs = [\n  "inbox",\n  "mcp",\n]\n');
    const report = await connect();
    expect(report.added).toEqual([]);
    expect(report.already).toEqual(["codex"]);
    expect(adds()).toEqual([]);
    expect(readInboxAgents(dataDir).agents.codex?.state).toBe("found");
  });

  test("an entry named plannotator-inbox that runs something else is never replaced, now or later", async () => {
    fake.install("codex");
    mkdirSync(join(fake.home, ".codex"), { recursive: true });
    const toml = '[mcp_servers.plannotator-inbox]\ncommand = "my-own-server"\nargs = []\n';
    writeFileSync(join(fake.home, ".codex", "config.toml"), toml);
    const report = await connect();
    expect(report.foreign).toEqual([{ agent: "codex", path: "~/.codex/config.toml" }]);
    expect(formatConnectReport(report)).toEqual(["Codex has its own plannotator-inbox entry in ~/.codex/config.toml; left alone."]);
    expect(adds()).toEqual([]);
    await connect();
    expect(adds()).toEqual([]);
    expect(readFileSync(join(fake.home, ".codex", "config.toml"), "utf8")).toBe(toml);
  });

  test("Codex found by its folder but without its CLI: left for a person (no TOML is edited)", async () => {
    mkdirSync(join(fake.home, ".codex"), { recursive: true });
    writeFileSync(join(fake.home, ".codex", "auth.json"), "{}");
    const report = await connect();
    expect(report.manual).toEqual(["codex"]);
    expect(existsSync(join(fake.home, ".codex", "config.toml"))).toBe(false);
  });

  test("a failing `mcp add` is reported with its reason, nothing recorded, and tried again next run", async () => {
    fake.install("codex");
    const report = await connect({ FAKE_AGENT_FAIL: "codex" });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toContain("codex mcp add exited with code 3 (boom: codex could not write its config (permission denied))");
    expect(formatConnectReport(report)[0]).toStartWith("Couldn't connect Codex: codex mcp add exited with code 3");
    expect(readInboxAgents(dataDir).agents.codex).toBeUndefined();
    const retry = await connect();
    expect(retry.added).toEqual(["codex"]);
  });

  test("one agent's limit: a hanging `mcp add` is stopped and reported, the others go on", async () => {
    fake.install("amp", "codex");
    const report = await connect({ FAKE_AGENT_HANG: "amp" }, { agentTimeoutMs: 1500 });
    expect(report.added).toEqual(["codex"]);
    expect(report.failed.map((f) => [f.agent, f.reason])).toEqual([["amp", "amp mcp add did not finish within 2 s"]]);
  });

  test("the whole step's limit: agents still going are left for the next run", async () => {
    fake.install("amp");
    const report = await connect({ FAKE_AGENT_HANG: "amp" }, { agentTimeoutMs: 5000, totalTimeoutMs: 300 });
    expect(report.unfinished).toEqual(["amp"]);
    expect(readInboxAgents(dataDir).agents.amp).toBeUndefined();
  });
});

describe("agents connected by one key in a plain-JSON file", () => {
  test("Cursor: one key, the rest of the file, its indentation and CRLF kept", async () => {
    const dir = join(fake.home, ".cursor");
    mkdirSync(dir, { recursive: true });
    const before = '{\r\n    "mcpServers": {\r\n        "other": {\r\n            "command": "x"\r\n        }\r\n    },\r\n    "theme": 1\r\n}\r\n';
    writeFileSync(join(dir, "mcp.json"), before);
    const report = await connect();
    expect(report.added).toEqual(["cursor"]);
    const after = readFileSync(join(dir, "mcp.json"), "utf8");
    expect(after).toContain("\r\n");
    expect(after.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(after).toContain('\r\n    "mcpServers": {\r\n        "other"');
    expect(JSON.parse(after)).toEqual({
      mcpServers: { other: { command: "x" }, "plannotator-inbox": { command: SELF[0], args: ["inbox", "mcp"] } },
      theme: 1,
    });
  });

  test("a write that changes nothing is skipped (the file is not touched)", () => {
    const file = join(fake.home, "mcp.json");
    expect(writeJsonEntry(file, ["mcpServers"], { command: "/p/plannotator", args: ["inbox", "mcp"] })).toEqual({ ok: true, changed: true });
    const mtime = statSync(file).mtimeMs;
    Bun.sleepSync(20);
    expect(writeJsonEntry(file, ["mcpServers"], { command: "/p/plannotator", args: ["inbox", "mcp"] })).toEqual({ ok: true, changed: false });
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  test("a file that is not plain JSON is refused and left as it was", async () => {
    const dir = join(fake.home, ".cursor");
    mkdirSync(dir, { recursive: true });
    const before = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    writeFileSync(join(dir, "mcp.json"), before);
    const report = await connect();
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toBe("~/.cursor/mcp.json can't be read (it is not plain JSON), so Plannotator left it as it was");
    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toBe(before);
  });

  test("a symlinked file (dotfiles) is written at its target and stays a link", async () => {
    const dotfiles = join(fake.root, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    writeFileSync(join(dotfiles, "mcp.json"), '{\n  "mcpServers": {}\n}\n');
    mkdirSync(join(fake.home, ".kiro", "settings"), { recursive: true });
    symlinkSync(join(dotfiles, "mcp.json"), join(fake.home, ".kiro", "settings", "mcp.json"));
    const report = await connect();
    expect(report.added).toEqual(["kiro"]);
    expect(lstatSync(join(fake.home, ".kiro", "settings", "mcp.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dotfiles, "mcp.json"), "utf8")).mcpServers["plannotator-inbox"].args).toEqual(["inbox", "mcp"]);
  });

  test("an entry removed outside Plannotator is never added back by itself", async () => {
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    await connect();
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), '{\n  "mcpServers": {}\n}\n');
    const report = await connect();
    expect(report.added).toEqual([]);
    expect(JSON.parse(readFileSync(join(fake.home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({});
    expect(readInboxAgents(dataDir).agents.cursor?.removed_outside_at).toBeString();
  });

  test("the Claude desktop app: its config file, created when missing, and a word to restart it", async () => {
    mkdirSync(join(fake.home, "Library", "Application Support", "Claude"), { recursive: true });
    const report = await connect({}, { platform: "darwin" });
    expect(report.added).toEqual(["claude-app"]);
    const file = join(fake.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["plannotator-inbox"]).toEqual({ command: SELF[0], args: ["inbox", "mcp"] });
    expect(formatConnectReport(report)).toContain("Restart the Claude app to use it there.");
  });
});

describe("Pi and OpenCode with Plannotator's extension or plugin: the tool switch", () => {
  test("Pi's extension and OpenCode's plugin: inboxTool on for both, nothing else run", async () => {
    fake.install("pi", "opencode");
    mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
    mkdirSync(join(fake.home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(fake.home, ".config", "opencode", "opencode.jsonc"), '{\n  // mine\n  "plugin": ["@plannotator/opencode@latest"],\n}\n');
    const report = await connect();
    expect(report.added.sort()).toEqual(["opencode", "pi"]);
    expect(loadConfig().inboxTool).toEqual({ pi: true, opencode: true });
    expect(adds()).toEqual([]);
  });

  test("a switch the person turned off stays off", async () => {
    mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [{ source: "npm:@plannotator/pi-extension" }] }));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: false } }));
    const report = await connect();
    expect(report.added).toEqual([]);
    expect(loadConfig().inboxTool).toEqual({ pi: false });
    expect(readInboxAgents(dataDir).agents.pi?.state).toBe("off");
  });

  test("PLANNOTATOR_INBOX_TOOL decides: nothing is written", async () => {
    mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
    await connect({ PLANNOTATOR_INBOX_TOOL: "0" });
    expect(loadConfig().inboxTool).toBeUndefined();
  });

  test("OpenCode without the plugin is left to a person (opencode.json may be JSONC and per project)", async () => {
    fake.install("opencode");
    const report = await connect();
    expect(report.manual).toEqual(["opencode"]);
    expect(fake.calls()).toEqual([]);
  });

  test("Claude Code: nothing written; said to be on already", async () => {
    mkdirSync(join(fake.home, ".claude"), { recursive: true });
    writeFileSync(join(fake.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
    fake.install("codex");
    const report = await connect();
    expect(report.claude_code).toBe(true);
    expect(formatConnectReport(report)).toEqual([
      "Connected Codex to the Inbox (Claude Code was already on).",
      "Agents use it from their next session. Change this in the Inbox's Settings.",
    ]);
  });
});

describe("later runs", () => {
  test("an agent installed since the first run is connected, and said once as new", async () => {
    fake.install("codex");
    await connect();
    fake.install("amp");
    const report = await connect();
    expect(report.first).toBe(false);
    expect(report.added).toEqual(["amp"]);
    expect(formatConnectReport(report)).toEqual(["Connected Amp to the Inbox (new on this computer). Change it in Settings."]);
    expect(formatConnectReport(await connect())).toEqual([]);
  });
});

describe("uninstall", () => {
  test("removes what was added (its own command or one key), leaves the person's other entries", async () => {
    fake.install("codex");
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    await connect();
    const plan = planInboxAgentRemoval(dataDir, environment());
    expect(plan.items.map((item) => item.describe)).toEqual([
      "MCP server plannotator-inbox from Codex (codex mcp remove plannotator-inbox)",
      "MCP server plannotator-inbox from Cursor (~/.cursor/mcp.json, that entry only)",
    ]);
    for (const item of plan.items) expect(await item.apply()).toBeNull();
    expect(fake.calls().at(-1)).toEqual({ name: "codex", args: ["mcp", "remove", "plannotator-inbox"] });
    expect(readCodexEntry(join(fake.home, ".codex", "config.toml"))).toEqual({ kind: "absent" });
    expect(JSON.parse(readFileSync(join(fake.home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  });

  test("an entry changed by hand to run something else is the person's: skipped and named", async () => {
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    await connect();
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), '{"mcpServers":{"plannotator-inbox":{"command":"mine"}}}');
    const plan = planInboxAgentRemoval(dataDir, environment());
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([`Cursor's "plannotator-inbox" now runs something else (changed by hand), so it is yours`]);
  });

  test("with the record gone, the known files are still scanned for an entry that runs Plannotator", () => {
    mkdirSync(join(fake.home, ".kiro", "settings"), { recursive: true });
    writeFileSync(join(fake.home, ".kiro", "settings", "mcp.json"), JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "plannotator", args: ["inbox", "mcp"] } } }));
    const plan = planInboxAgentRemoval(dataDir, environment());
    expect(plan.items.map((item) => item.agent)).toEqual(["kiro"]);
  });
});

test("isPlannotatorInboxCommand: our stdio entry under any path, a source checkout, never something else", () => {
  expect(isPlannotatorInboxCommand(["/x/plannotator", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["C:\\bin\\plannotator.exe", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["/usr/bin/bun", "/src/plannotator/apps/hook/server/index.ts", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["npx", "some-server"])).toBe(false);
  expect(isPlannotatorInboxCommand(["/x/plannotator", "review"])).toBe(false);
});

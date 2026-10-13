/**
 * Connecting the agents on this computer to the Inbox (inbox-agents.ts), with
 * fake agent CLIs on a scratch PATH and a scratch home (tests/helpers/
 * fake-agents.ts): what is found, what each agent gets, what is never
 * touched, what a later run does, and what uninstall removes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  agentHomeAllowed,
  codexHome,
  geminiDir,
  connectInboxAgents,
  createAgentEnvironmentFor,
  formatConnectReport,
  formatSeconds,
  isPlannotatorInboxCommand,
  planInboxAgentRemoval,
  readCodexEntry,
  readInboxAgents,
  writeJsonEntry,
  type AgentEnvironment,
} from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];
const OURS = [...SELF, "inbox", "mcp"];

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
  // Throws (failing the test) when a fake CLI was still running; it is killed first.
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

/** Every fake CLI the test started has ended (a SIGKILL in flight gets a moment). */
async function expectNoFakeRunning(): Promise<void> {
  for (let waited = 0; waited < 1000 && fake.live().length > 0; waited += 25) await Bun.sleep(25);
  expect(fake.live()).toEqual([]);
}

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
    expect(report.failed.map((f) => [f.agent, f.reason])).toEqual([["amp", "amp mcp add did not finish within 1.5 s"]]);
    // Stopped means killed: the hung CLI is not running any more.
    await expectNoFakeRunning();
  });

  test("a hanging `--version` is stopped too, and the agent is left to connect by hand", async () => {
    fake.install("amp");
    // The probe's own limit is 5 s.
    const report = await connect({ FAKE_AGENT_HANG_VERSION: "amp" });
    expect(report.manual).toEqual(["amp"]);
    await expectNoFakeRunning();
  }, 15_000);

  test("the whole step's limit: agents still going are left for the next run, and their CLIs are killed", async () => {
    fake.install("amp");
    const report = await connect({ FAKE_AGENT_HANG: "amp" }, { agentTimeoutMs: 5000, totalTimeoutMs: 300 });
    expect(report.unfinished).toEqual(["amp"]);
    expect(readInboxAgents(dataDir).agents.amp).toBeUndefined();
    // Not left running until its own 5 s limit (or forever, once this process exits first).
    await expectNoFakeRunning();
  });

  test("the caller going away (the Inbox stops) kills the CLIs still running and writes nothing", async () => {
    fake.install("amp");
    const stop = new AbortController();
    const running = connectInboxAgents({
      dataDir,
      selfCommand: SELF,
      environment: environment({ FAKE_AGENT_HANG: "amp" }),
      agentTimeoutMs: 20_000,
      totalTimeoutMs: 20_000,
      signal: stop.signal,
    });
    const started = Date.now();
    while (fake.live().length === 0 && Date.now() - started < 5000) await Bun.sleep(25);
    expect(fake.live().map((p) => p.name)).toEqual(["amp"]);
    stop.abort();
    const report = await running;
    expect(report.unfinished).toEqual(["amp"]);
    expect(existsSync(join(dataDir, "inbox", "agents.json"))).toBe(false);
    await expectNoFakeRunning();
  });

  test("a hung CLI does not outlive this process: the exit handler kills it", async () => {
    // A child process runs a connect whose CLI hangs past the child's own exit.
    fake.install("amp");
    const script = join(fake.root, "exit-early.ts");
    writeFileSync(
      script,
      `import { connectInboxAgents, createAgentEnvironmentFor } from ${JSON.stringify(join(import.meta.dir, "inbox-agents.ts"))};
const env = JSON.parse(process.env.FAKE_ENV_JSON);
void connectInboxAgents({ dataDir: process.env.DATA, selfCommand: ["/x"], environment: createAgentEnvironmentFor({ platform: process.platform, homeDir: env.HOME, env }), agentTimeoutMs: 60000, totalTimeoutMs: 60000 });
const started = Date.now();
// Exit once the hanging \`mcp add\` has started (it records its call first).
const wait = () => { if (require("fs").readFileSync(env.FAKE_AGENT_LOG, "utf8").length > 0 || Date.now() - started > 5000) process.exit(0); else setTimeout(wait, 25); };
wait();
`,
    );
    const child = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, DATA: dataDir, FAKE_ENV_JSON: JSON.stringify({ ...fake.env, FAKE_AGENT_HANG: "amp" }) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(fake.calls().map((call) => call.name)).toEqual(["amp"]);
    await expectNoFakeRunning();
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
      "Agents use it from their next session. PLANNOTATOR_INBOX_CONNECT=0 skips this step; plannotator uninstall removes what it added.",
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
    expect(formatConnectReport(report)).toEqual(["Connected Amp to the Inbox (new on this computer)."]);
    expect(formatConnectReport(await connect())).toEqual([]);
  });
});

describe("uninstall", () => {
  test("removes what was added (its own command or one key), leaves the person's other entries", async () => {
    fake.install("codex");
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    await connect();
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
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
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([`Cursor's "plannotator-inbox" now runs something else (changed by hand), so it is yours`]);
  });

  test("with no record (agents.json lost), nothing is removed: an entry that runs exactly this binary may be the person's, so it is named and left", () => {
    const kiro = join(fake.home, ".kiro", "settings", "mcp.json");
    mkdirSync(join(fake.home, ".kiro", "settings"), { recursive: true });
    writeFileSync(kiro, JSON.stringify({ mcpServers: { "plannotator-inbox": { command: SELF[0], args: ["inbox", "mcp"] } } }));
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "plannotator", args: ["inbox", "mcp"] } } }));
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([
      `Kiro's "plannotator-inbox" in ~/.kiro/settings/mcp.json runs this Plannotator, but no record says Plannotator added it, so it may be yours (to remove it, delete that entry by hand)`,
    ]);
  });

  test("an entry Plannotator only found (the person added it) is never removed", async () => {
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    writeFileSync(join(fake.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "plannotator-inbox": { command: SELF[0], args: ["inbox", "mcp"] } } }));
    await connect();
    expect(readInboxAgents(dataDir).agents.cursor?.state).toBe("found");
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toEqual([]);
  });
});

test("formatSeconds says the limit it was: never rounded up", () => {
  expect(formatSeconds(1500)).toBe("1.5 s");
  expect(formatSeconds(10_000)).toBe("10 s");
  expect(formatSeconds(1999)).toBe("1.9 s");
  expect(formatSeconds(250)).toBe("0.2 s");
});

test("isPlannotatorInboxCommand: our stdio entry under any path, a source checkout, never something else", () => {
  expect(isPlannotatorInboxCommand(["/x/plannotator", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["C:\\bin\\plannotator.exe", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["/usr/bin/bun", "/src/plannotator/apps/hook/server/index.ts", "inbox", "mcp"])).toBe(true);
  expect(isPlannotatorInboxCommand(["npx", "some-server"])).toBe(false);
  expect(isPlannotatorInboxCommand(["/x/plannotator", "review"])).toBe(false);
  expect(isPlannotatorInboxCommand(["/x/my-plannotator-proxy", "inbox", "mcp"])).toBe(false);
  expect(isPlannotatorInboxCommand(["/home/plannotator/bin/other", "inbox", "mcp"])).toBe(false);
});

describe("a CLI is asked what it is before it is handed an mcp add", () => {
  test("Pi before 0.99 (no `pi mcp`: the words would be a chat prompt) is left to the person, and nothing else runs", async () => {
    fake.install("pi");
    const report = await connect({ FAKE_PI_VERSION: "0.85.1" });
    expect(report.manual).toEqual(["pi"]);
    expect(fake.calls()).toEqual([]);
    // The terminal says why, once; the next run says nothing more about it.
    expect(formatConnectReport(report)).toContain("Pi needs connecting by hand: Pi before 0.99 has no `pi mcp`; update Pi, or add plannotator-inbox to ~/.pi/agent/mcp.json by hand.");
    const again = await connect({ FAKE_PI_VERSION: "0.85.1" });
    expect(again.manual).toEqual(["pi"]);
    expect(formatConnectReport(again)).toEqual([]);
  });

  test("Codex CLI before 0.35 and Gemini CLI before 0.1.19 (no `mcp add` yet) are left to the person, with why", async () => {
    fake.install("codex", "gemini");
    mkdirSync(join(fake.home, ".gemini"), { recursive: true });
    const report = await connect({ FAKE_CODEX_VERSION: "codex-cli 0.34.0", FAKE_GEMINI_VERSION: "0.1.18" });
    expect(report.manual.sort()).toEqual(["codex", "gemini"]);
    expect(fake.calls()).toEqual([]);
    const lines = formatConnectReport(report);
    expect(lines).toContain("Codex needs connecting by hand: Codex CLI before 0.35 has no `codex mcp add`; update Codex, or add plannotator-inbox to its config.toml by hand.");
    expect(lines).toContain("Gemini CLI needs connecting by hand: Gemini CLI before 0.1.19 has no `gemini mcp add`; update Gemini CLI, or add plannotator-inbox to its settings.json by hand.");
    // The first builds that have it are connected.
    const later = await connect({ FAKE_CODEX_VERSION: "codex-cli 0.35.0", FAKE_GEMINI_VERSION: "0.1.19" });
    expect(later.added.sort()).toEqual(["codex", "gemini"]);
  });

  test("a program that only shares the name (cln's `pi` printing digits, amp.rs, another codex) is never handed an mcp add", async () => {
    fake.install("pi", "amp", "codex");
    const report = await connect({ FAKE_PI_VERSION: "3.14159265358979", FAKE_AMP_VERSION: "amp 0.6.2", FAKE_CODEX_VERSION: "codex 1.0" });
    expect(report.manual.sort()).toEqual(["amp", "codex", "pi"]);
    expect(fake.calls()).toEqual([]);
  });

  test("Cline is never run (its mcp add is not verified): left to the person", async () => {
    fake.install("cline");
    const report = await connect();
    expect(report.manual).toEqual(["cline"]);
    expect(fake.calls()).toEqual([]);
  });

  test("a grandchild holding the CLI's output open does not hold the run", async () => {
    fake.install("codex");
    const started = Date.now();
    const report = await connect({ FAKE_AGENT_GRANDCHILD: "codex" }, { agentTimeoutMs: 8000 });
    expect(report.added).toEqual(["codex"]);
    expect(Date.now() - started).toBeLessThan(6000);
    // A CLI that exited by itself keeps the daemon it started (unchanged); this test ends it.
    expect(fake.stopAll().map((p) => p.args)).toEqual([["--fake-grandchild"]]);
  });
});

describe("Codex's config.toml is read as TOML (every form), and an entry Plannotator did not write is never replaced", () => {
  const toml = (text: string) => {
    mkdirSync(join(fake.home, ".codex"), { recursive: true });
    writeFileSync(join(fake.home, ".codex", "config.toml"), text);
  };
  test.each([
    ["an inline table under [mcp_servers]", '[mcp_servers]\nplannotator-inbox = { command = "my-server", args = [] }\n'],
    ["a dotted root key", 'mcp_servers.plannotator-inbox.command = "my-server"\n'],
    ["a quoted header part", '[mcp_servers."plannotator-inbox"]\ncommand = "my-server"\n'],
    ["a literal-string header part", "[mcp_servers.'plannotator-inbox']\ncommand = 'my-server'\n"],
  ])("%s: foreign, no mcp add", async (_name, text) => {
    fake.install("codex");
    toml(text);
    const report = await connect();
    expect(report.foreign.map((f) => f.agent)).toEqual(["codex"]);
    expect(adds()).toEqual([]);
    expect(readFileSync(join(fake.home, ".codex", "config.toml"), "utf8")).toBe(text);
  });

  test("not valid TOML: refused and left as it was", async () => {
    fake.install("codex");
    toml("a = = 1\n");
    const report = await connect();
    expect(report.failed[0]!.reason).toContain("it is not valid TOML");
    expect(adds()).toEqual([]);
  });

  test("a relative CODEX_HOME resolves against the working folder, as Codex does", () => {
    const e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, CODEX_HOME: "rel-codex" } });
    expect(codexHome(e)).toBe(join(process.cwd(), "rel-codex"));
  });

  test("Gemini's folder follows GEMINI_CLI_HOME", () => {
    const e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, GEMINI_CLI_HOME: join(fake.root, "gh") } });
    expect(geminiDir(e)).toBe(join(fake.root, "gh", ".gemini"));
  });
});

test("a lasting failure is said once; the run still tries again", async () => {
  fake.install("codex");
  const first = await connect({ FAKE_AGENT_FAIL: "codex" });
  expect(first.failed).toHaveLength(1);
  const second = await connect({ FAKE_AGENT_FAIL: "codex" });
  expect(second.failed).toEqual([]);
  expect(adds()).toHaveLength(2);
});

test("OpenCode 2's plugins in object form are found", async () => {
  mkdirSync(join(fake.home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(fake.home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugins: [{ package: "@plannotator/opencode@latest" }] }));
  const report = await connect();
  expect(report.added).toEqual(["opencode"]);
});

describe("a JSON edit changes only the one entry", () => {
  const cursor = () => join(fake.home, ".cursor", "mcp.json");
  const put = (text: string) => {
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    writeFileSync(cursor(), text);
  };
  test("a compact file stays compact; big integers, 1.0 and \\u escapes stay as written; a BOM is kept", async () => {
    const before = '﻿{"n":12345678901234567890,"f":1.0,"s":"caf\\u00e9","mcpServers":{"a":{"command":"x"}}}';
    put(before);
    await connect();
    const after = readFileSync(cursor(), "utf8");
    expect(after).toBe(`﻿{"n":12345678901234567890,"f":1.0,"s":"caf\\u00e9","mcpServers":{"a":{"command":"x"},"plannotator-inbox":{"command":"${SELF[0]}","args":["inbox","mcp"]}}}`);
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toHaveLength(1);
    await planInboxAgentRemoval(dataDir, environment(), OURS).items[0]!.apply();
    expect(readFileSync(cursor(), "utf8")).toBe(before);
  });

  test("add then remove gives the file back byte for byte: empty files, no final newline, LF and CRLF, a container Plannotator made", async () => {
    const files: [string, string][] = [
      ["cursor", join(fake.home, ".cursor", "mcp.json")],
      ["kiro", join(fake.home, ".kiro", "settings", "mcp.json")],
    ];
    const cases = ["", "\n", "\r\n", "{}", "{}\n", "{}\r\n", '{"a":1}', '{\r\n  "a": 1\r\n}', '{\r\n  "a": 1\r\n}\r\n', '{\n  "mcpServers": {}\n}', '{\n  "mcpServers": {\n    "o": { "command": "x" }\n  }\n}\n'];
    for (const [agent, path] of files) {
      for (const before of cases) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, before);
        rmSync(join(dataDir, "inbox", "agents.json"), { force: true });
        const report = await connect();
        expect([agent, before, report.added.includes(agent as never)]).toEqual([agent, before, true]);
        const item = planInboxAgentRemoval(dataDir, environment(), OURS).items.find((candidate) => candidate.agent === agent)!;
        expect(await item.apply()).toBeNull();
        expect([agent, JSON.stringify(readFileSync(path, "utf8"))]).toEqual([agent, JSON.stringify(before)]);
      }
    }
  });

  test("a JSON file Plannotator created is gone after removal; one the person wrote into meanwhile stays, without the entry", async () => {
    const cursor = join(fake.home, ".cursor", "mcp.json");
    mkdirSync(join(fake.home, ".cursor"), { recursive: true });
    await connect();
    expect(existsSync(cursor)).toBe(true);
    for (const item of planInboxAgentRemoval(dataDir, environment(), OURS).items) expect(await item.apply()).toBeNull();
    expect(existsSync(cursor)).toBe(false);

    rmSync(join(dataDir, "inbox", "agents.json"), { force: true });
    await connect();
    const added = JSON.parse(readFileSync(cursor, "utf8"));
    added.mcpServers.mine = { command: "mine" };
    writeFileSync(cursor, JSON.stringify(added, null, 2));
    for (const item of planInboxAgentRemoval(dataDir, environment(), OURS).items) expect(await item.apply()).toBeNull();
    expect(JSON.parse(readFileSync(cursor, "utf8"))).toEqual({ mcpServers: { mine: { command: "mine" } } });
  });

  test("an entry the person edited is cut alone (the exact undo no longer applies)", async () => {
    put('{\n  "a": 1\n}');
    await connect();
    const edited = readFileSync(cursor(), "utf8").replace('"inbox",', '"inbox" ,');
    writeFileSync(cursor(), edited);
    await planInboxAgentRemoval(dataDir, environment(), OURS).items[0]!.apply();
    expect(JSON.parse(readFileSync(cursor(), "utf8"))).toEqual({ a: 1, mcpServers: {} });
  });

  test("numeric keys keep their order; a duplicate key on the path is refused", async () => {
    put('{"2":1,"1":2,"mcpServers":{}}');
    await connect();
    expect(readFileSync(cursor(), "utf8").startsWith('{"2":1,"1":2,"mcpServers":{"plannotator-inbox"')).toBe(true);
  });

  test("two mcpServers blocks: refused, the file untouched", async () => {
    const before = '{"mcpServers":{"a":{"command":"x"}},"mcpServers":{"b":{"command":"y"}}}';
    put(before);
    const report = await connect();
    expect(report.failed[0]!.reason).toContain("twice");
    expect(readFileSync(cursor(), "utf8")).toBe(before);
  });
});

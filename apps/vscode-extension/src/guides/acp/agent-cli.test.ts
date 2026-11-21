/**
 * claude-agent-acp and codex-acp run their own bundled Claude / Codex unless
 * CLAUDE_CODE_EXECUTABLE / CODEX_PATH name another one. These start the FAKE
 * ACP agent (tests/helpers/fake-acp-agent.ts, never a real adapter) the way
 * Guides starts an adapter, and read back what the adapter process was given.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE, CODEX, GROK, KNOWN_AGENTS, loginCommands, OPENCODE, resolveAgentLaunch, type AgentDescriptor } from "@plannotator/acp-client/agents";
import { AcpClient } from "@plannotator/acp-client/client";
import { isSameProgram } from "@plannotator/acp-client/same-program";
import { AGENT_CLIS, agentLaunchFor, resolveGuidesLaunch, type CliChoice } from "./agent-cli";
import { planSignIn } from "./sign-in";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const dir = mkdtempSync(join(tmpdir(), "pn-agent-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLI_VARS = ["CLAUDE_CODE_EXECUTABLE", "CODEX_PATH"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // The adapter inherits this process's environment: start every test without the user's own values.
  saved = Object.fromEntries(CLI_VARS.map((k) => [k, process.env[k]]));
  for (const k of CLI_VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of CLI_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Programs "on PATH": the fake adapter for the adapter's command, `<prefix><name>` for the CLIs given. */
const onPath = (clis: string[], prefix = "/opt/me/bin/") => (name: string) => (name === process.execPath ? name : clis.includes(name) ? `${prefix}${name}` : null);

/** Resolve the agent as Guides does, with the fake adapter as its command. */
function resolve(agent: AgentDescriptor, find: (name: string) => string | null, platform: NodeJS.Platform = process.platform, choice: CliChoice = {}) {
  const launch = resolveGuidesLaunch(agent, { command: process.execPath, args: [FAKE_AGENT] }, find, () => null, platform, isSameProgram, choice);
  if (!launch.ok) throw new Error(launch.message);
  return launch;
}

let n = 0;
/** Start the fake adapter with that launch (and a script), and read what it logged. */
async function startFake(launch: ReturnType<typeof resolve>, script: Record<string, unknown> = { steps: [] }) {
  const scriptPath = join(dir, `script-${++n}.json`);
  const log = join(dir, `agent-${n}.log`);
  writeFileSync(scriptPath, JSON.stringify(script));
  const agentLaunch = agentLaunchFor(launch, dir);
  const client = await AcpClient.start(
    { ...agentLaunch, env: { ...agentLaunch.env, FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: log } },
    { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    { name: "plannotator-vscode", title: "Plannotator", version: "test" },
  );
  const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { client, cliEnv: () => entries().find((e) => e.event === "initialize")?.cliEnv };
}

async function adapterSees(agent: AgentDescriptor, clis: string[]) {
  const launch = resolve(agent, onPath(clis));
  const { client, cliEnv } = await startFake(launch);
  client.dispose();
  return { cliEnv: cliEnv(), launch };
}

describe("an adapter runs the user's own CLI, not the copy it bundles", () => {
  it("Claude Code: CLAUDE_CODE_EXECUTABLE is the `claude` on PATH, and the log names it", async () => {
    const seen = await adapterSees(CLAUDE_CODE, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: "/opt/me/bin/claude", CODEX_PATH: null });
    expect(seen.launch.cliLog).toContain("/opt/me/bin/claude");
  });

  it("Codex: CODEX_PATH is the `codex` on PATH", async () => {
    const seen = await adapterSees(CODEX, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: "/opt/me/bin/codex" });
  });

  it("keeps a CLAUDE_CODE_EXECUTABLE the user set themselves", async () => {
    process.env.CLAUDE_CODE_EXECUTABLE = "/my/own/claude";
    const seen = await adapterSees(CLAUDE_CODE, ["claude"]);
    expect(seen.cliEnv?.CLAUDE_CODE_EXECUTABLE).toBe("/my/own/claude");
    expect(seen.launch.startHint).toBeUndefined();
  });

  it("with no `claude` installed, still starts (the adapter's own copy) and logs why", async () => {
    const seen = await adapterSees(CLAUDE_CODE, []);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: null });
    expect(seen.launch.cliLog).toContain("comes with Claude Code's ACP adapter");
    expect(seen.launch.cliLog).not.toContain("sign in");
  });

  it("adds nothing for an agent that is its own CLI", async () => {
    const seen = await adapterSees(OPENCODE, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: null });
    expect(seen.launch.cliLog).toBeUndefined();
  });

  it("plannotator.guides.useInstalledCli off: the adapter's own copy", () => {
    const launch = resolve(CLAUDE_CODE, onPath(["claude"]), "darwin", { env: {}, useInstalled: false });
    expect(launch.env).toBeUndefined();
    expect(launch.startHint).toBeUndefined();
  });
});

describe("Windows: only an .exe, since the adapters start the path without a shell", () => {
  const npmDir = "C:\\Users\\me\\AppData\\Roaming\\npm\\";
  for (const agent of [CLAUDE_CODE, CODEX]) {
    const cli = AGENT_CLIS[agent.id];
    it(`${agent.label}: an npm .cmd shim keeps the adapter's own copy; an .exe is used`, () => {
      const cmd = resolve(agent, (name) => (name === process.execPath ? name : name === cli.command ? `${npmDir}${name}.cmd` : null), "win32", { env: {} });
      expect(cmd.env).toBeUndefined();
      expect(cmd.cliLog).toContain(".cmd is not an .exe");
      const exe = resolve(agent, (name) => (name === process.execPath ? name : name === cli.command ? `C:\\Users\\me\\.local\\bin\\${name}.EXE` : null), "win32", { env: {} });
      expect(exe.env).toEqual({ [cli.env]: `C:\\Users\\me\\.local\\bin\\${cli.command}.EXE` });
    });
  }
});

describe("scope: Guides only", () => {
  const found = (name: string) => `/bin/${name}`;
  it("Guides adds exactly one variable, and only for Claude Code and Codex", () => {
    for (const a of KNOWN_AGENTS) {
      const r = resolveGuidesLaunch(a, {}, found, () => null, "darwin", isSameProgram, { env: {} });
      if (!r.ok) throw new Error(r.message);
      const cli = AGENT_CLIS[a.id];
      expect(r.env).toEqual(cli ? { [cli.env]: `/bin/${cli.command}` } : undefined);
    }
    expect(Object.keys(AGENT_CLIS).sort()).toEqual([CLAUDE_CODE.id, CODEX.id].sort());
  });

  it("the shared resolver adds no CLI variable, and Grok has none either way", () => {
    for (const a of [CLAUDE_CODE, CODEX, GROK]) {
      const shared = resolveAgentLaunch(a, {}, found, () => null, "darwin");
      expect(shared.ok && shared.env).toBeFalsy();
    }
    const grok = resolveGuidesLaunch(GROK, {}, found, () => null, "darwin", isSameProgram, { env: {} });
    expect(grok.ok && (grok.env ?? grok.cliLog ?? grok.startHint)).toBeFalsy();
  });
});

describe("an older CLI: a start failure says which one Guides used", () => {
  it("adds the hint when session/new fails, and only before a session is ready", async () => {
    const launch = resolve(CLAUDE_CODE, onPath(["claude"]));
    const failing = await startFake(launch, { steps: [], newSessionError: "error: unknown option '--permission-prompts'" });
    const err = await failing.client.newSession(dir, []).catch((e: unknown) => e);
    failing.client.dispose();
    expect(err instanceof Error ? err.message : String(err)).toContain("Guided Reviews ran your claude at /opt/me/bin/claude");

    const working = await startFake(launch, { steps: [{ exit: 1 }] });
    const session = await working.client.newSession(dir, []);
    const later = await working.client.prompt(session.sessionId, "hi").catch((e: unknown) => e);
    const message = await working.client.describeFailure(later);
    working.client.dispose();
    expect(message).not.toContain("Guided Reviews ran your claude");
  });

  it("no hint when Guides did not choose the CLI", async () => {
    const launch = resolve(CLAUDE_CODE, onPath([]));
    const failing = await startFake(launch, { steps: [], newSessionError: "boom" });
    const err = await failing.client.newSession(dir, []).catch((e: unknown) => e);
    failing.client.dispose();
    expect(err instanceof Error ? err.message : String(err)).not.toContain("Guided Reviews ran your");
  });
});

describe("the terminal sign-in", () => {
  it("runs the adapter's own sign-in with the same CLAUDE_CODE_EXECUTABLE a guide runs", async () => {
    const launch = resolve(CLAUDE_CODE, onPath(["claude"]));
    const { client } = await startFake(launch);
    const logins = loginCommands(client.authMethods);
    client.dispose();
    const plan = planSignIn(CLAUDE_CODE, launch, logins[0], { spawnPlan: (command, args) => ({ command, args }) });
    expect(plan).toEqual({ ok: true, command: process.execPath, args: [FAKE_AGENT, "--cli", "auth", "login", "--claudeai"], env: { CLAUDE_CODE_EXECUTABLE: "/opt/me/bin/claude" } });
  });
});

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CODE,
  CODEX,
  COPILOT,
  CURSOR,
  KILO,
  KIRO,
  KNOWN_AGENTS,
  OPENCODE,
  PI,
  customAgent,
  detectAgents,
  engineLabel,
  findAgent,
  loginCommands,
  pickDefault,
  readAgentOptions,
  resolveAgentLaunch,
  type AgentDescriptor,
} from "@plannotator/acp-client/agents";
import { forgetSameProgramAnswers, isSameProgram, readVersionLine } from "@plannotator/acp-client/same-program";
import { planSpawn, shimEntry } from "@plannotator/acp-client/spawn-plan";

/** What `npm install -g` writes on Windows for a package bin. */
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*',
].join("\r\n");

describe("starting the adapter on Windows", () => {
  it("runs an npm .cmd shim's JavaScript entry with node, never through cmd.exe", () => {
    const plan = planSpawn("C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd", ["--x"], {
      platform: "win32",
      readShim: () => NPM_SHIM,
      findNode: () => "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(plan).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js", "--x"],
    });
  });

  it("falls back to VS Code's own runtime when no node is on PATH", () => {
    const plan = planSpawn("C:\\npm\\claude-agent-acp.cmd", [], { platform: "win32", readShim: () => NPM_SHIM, findNode: () => null, execPath: "C:\\VSCode\\Code.exe" });
    expect(plan).toEqual({ command: "C:\\VSCode\\Code.exe", args: ["C:\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  it("refuses a .cmd it cannot read as an npm shim, and a shim pointing outside its folder", () => {
    expect(() => planSpawn("C:\\x\\tool.cmd", [], { platform: "win32", readShim: () => "@echo off\r\nnode %*\r\n", findNode: () => "node" })).toThrow("not an npm command shim");
    expect(shimEntry("C:\\npm\\a.cmd", '"%dp0%\\..\\..\\evil.js" %*')).toBeNull();
  });

  it("spawns everything else as it is", () => {
    expect(planSpawn("/usr/local/bin/claude-agent-acp", ["a"], { platform: "darwin" })).toEqual({ command: "/usr/local/bin/claude-agent-acp", args: ["a"] });
    expect(planSpawn("C:\\bin\\claude-agent-acp.exe", [], { platform: "win32" })).toEqual({ command: "C:\\bin\\claude-agent-acp.exe", args: [] });
  });
});

describe("agent sign-in", () => {
  it("reads the terminal sign-ins the agent offers", () => {
    expect(loginCommands([
      { id: "claude-ai-login", name: "Claude Subscription", description: "Use Claude subscription", type: "terminal", args: ["--cli", "auth", "login", "--claudeai"] },
      { id: "gateway", name: "Custom gateway" } as never,
      { id: "bad", name: "Bad", type: "terminal", args: [1] } as never,
    ])).toEqual([{ label: "Claude Subscription", description: "Use Claude subscription", args: ["--cli", "auth", "login", "--claudeai"] }]);
    expect(loginCommands(undefined)).toEqual([]);
  });
});

const FOUND = (names: string[]) => (name: string) => (name.startsWith("/") ? name : names.includes(name) ? `/bin/${name}` : null);

describe("the agent registry", () => {
  it("lists the supported agents, each with an install command and an https source, and never npx", () => {
    expect(KNOWN_AGENTS.map((a) => a.id)).toEqual(["claude-code", "codex", "opencode", "copilot", "cursor", "kiro", "kilo", "pi"]);
    for (const a of KNOWN_AGENTS) {
      expect(a.installCommand.length).toBeGreaterThan(0);
      expect(a.docsUrl).toStartWith("https://");
      expect([a.command, ...a.args].join(" ")).not.toContain("npx");
    }
    expect(new Set(KNOWN_AGENTS.map((a) => a.engine)).size).toBe(KNOWN_AGENTS.length);
  });

  it("starts each agent the way its docs say", () => {
    const launch = (a: AgentDescriptor) => [a.command, ...a.args].join(" ");
    expect(launch(CLAUDE_CODE)).toBe("claude-agent-acp");
    expect(launch(CODEX)).toBe("codex-acp");
    expect(launch(OPENCODE)).toBe("opencode acp");
    expect(launch(COPILOT)).toBe("copilot --acp --stdio");
    expect(launch(CURSOR)).toBe("cursor-agent acp");
    expect(CURSOR.altCommands).toEqual(["agent"]);
    expect(launch(KIRO)).toBe("kiro-cli acp");
    expect(launch(KILO)).toBe("kilo acp");
    expect(KILO.altCommands).toEqual(["kilocode"]);
    expect(launch(PI)).toBe("pi-acp");
  });

  it("carries nothing that changes the user's agent config: no extra arguments, environment or session _meta", () => {
    for (const a of KNOWN_AGENTS) {
      const r = resolveAgentLaunch(a, {}, FOUND([a.command, ...(a.requires ? [a.requires.command] : [])]));
      expect(r).toEqual({ ok: true, command: `/bin/${a.command}`, args: [...a.args], source: "path" });
      expect(Object.keys(a).sort()).not.toContain("readOnly");
    }
  });

  it("uses an agent's own permissive mode only for automatic approval: Claude Code acceptEdits, Codex agent", () => {
    // The first is the mode Guides switches to; the rest are at least as permissive and are never downgraded.
    expect(CLAUDE_CODE.permissiveModes).toEqual(["acceptEdits", "auto", "bypassPermissions"]);
    expect(CODEX.permissiveModes).toEqual(["agent", "agent-full-access"]);
  });

  it("starts Pi like any other agent, with its capability gap as a note", () => {
    expect(resolveAgentLaunch(PI, {}, FOUND(["pi-acp", "pi"]))).toEqual({ ok: true, command: "/bin/pi-acp", args: [], source: "path" });
    expect(PI.note).toContain("Can't write guides yet");
    expect(PI.note).toContain("MCP");
  });
});

describe("starting an agent", () => {
  it("tries the program's other names", () => {
    const cursor = () => true;
    expect(resolveAgentLaunch(CURSOR, {}, FOUND(["agent"]), () => null, "darwin", cursor)).toEqual({ ok: true, command: "/bin/agent", args: ["acp"], source: "path" });
    expect(resolveAgentLaunch(KILO, {}, FOUND(["kilocode"]))).toEqual({ ok: true, command: "/bin/kilocode", args: ["acp"], source: "path" });
  });

  it("checks an `agent` only when `cursor-agent` is missing, and takes Cursor as not installed when it is another program", () => {
    const asked: string[] = [];
    const notCursor = (path: string) => (asked.push(path), false);
    expect(resolveAgentLaunch(CURSOR, {}, FOUND(["cursor-agent", "agent"]), () => null, "darwin", notCursor)).toEqual({ ok: true, command: "/bin/cursor-agent", args: ["acp"], source: "path" });
    expect(asked).toEqual([]);
    expect(resolveAgentLaunch(CURSOR, {}, FOUND(["agent"]), () => null, "darwin", notCursor)).toEqual({
      ok: false,
      reason: "agent",
      message: "Cursor is not installed: `cursor-agent` is not on PATH (the `agent` there is another program). Install it with `curl https://cursor.com/install -fsS | bash`, then try again.",
    });
    expect(asked).toEqual(["/bin/agent"]);
    const statuses = detectAgents(() => ({}), null, FOUND(["agent"]), () => null, false, notCursor);
    expect(statuses.find((s) => s.agent.id === "cursor")?.launch.ok).toBe(false);
  });

  it("says how to install a missing agent", () => {
    expect(resolveAgentLaunch(OPENCODE, {}, FOUND([]))).toEqual({ ok: false, reason: "agent", message: "OpenCode is not installed: `opencode` is not on PATH. Install it with `curl -fsSL https://opencode.ai/install | bash`, then try again." });
  });

  it("uses a command override with its own args, or the agent's", () => {
    expect(resolveAgentLaunch(OPENCODE, { command: "/opt/oc" }, FOUND([]))).toEqual({ ok: true, command: "/opt/oc", args: ["acp"], source: "setting" });
    expect(resolveAgentLaunch(CODEX, { command: "/opt/codex-acp", args: ["--x"] }, FOUND([]))).toEqual({ ok: true, command: "/opt/codex-acp", args: ["--x"], source: "setting" });
    expect(resolveAgentLaunch(CODEX, { command: "nope" }, FOUND([]))).toEqual({ ok: false, reason: "setting", message: "The configured command for Codex, `nope`, was not found." });
  });

  it("lists installed agents first, then the rest, and the custom agent when set", () => {
    const custom = customAgent({ command: "/opt/my-acp", args: ["acp"], label: "Mine" });
    const statuses = detectAgents(() => ({}), custom, FOUND(["opencode", "kiro-cli"]));
    expect(statuses.map((s) => [s.agent.id, s.launch.ok])).toEqual([
      ["opencode", true], ["kiro", true], ["custom", true],
      ["claude-code", false], ["codex", false], ["copilot", false], ["cursor", false], ["kilo", false], ["pi", false],
    ]);
    expect(custom?.label).toBe("Mine");
    expect(customAgent({ command: "  " })).toBeNull();
    expect(findAgent("custom", custom)).toBe(custom);
    expect(findAgent("kilo", null)).toBe(KILO);
    expect(findAgent("gone", null)).toBeNull();
  });

  it("names a saved guide's engine", () => {
    expect(engineLabel("claude")).toBe("Claude Code");
    expect(engineLabel("kilo")).toBe("Kilo Code");
    expect(engineLabel("acp")).toBe("acp");
    expect(engineLabel(undefined)).toBe("");
  });
});

describe("cheap defaults", () => {
  const select = { configId: "model", name: "Model", current: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] };
  it("prefers the remembered choice, then the agent's cheap default, then its current one", () => {
    expect(pickDefault(select, /sonnet/i, "opus")?.value).toBe("opus");
    expect(pickDefault(select, /sonnet/i)?.value).toBe("sonnet");
    expect(pickDefault(select, undefined)?.value).toBe("opus");
    expect(pickDefault(null, /x/)).toBeNull();
  });

  it("reads model and effort from the agent's config options, whatever the effort is called", () => {
    const opts = (effort: Record<string, unknown>) => [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
      { name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }], ...effort },
    ] as never;
    for (const effort of [{ id: "e", category: "thought_level" }, { id: "thinking", category: "thinking" }, { id: "effortLevel" }, { id: "reasoning_effort", category: "other" }]) {
      const o = readAgentOptions("x", opts(effort), 1);
      expect(o.model?.current).toBe("a");
      expect(o.effort?.options.map((c) => c.value)).toEqual(["low"]);
    }
  });
});

describe("installing an agent on Windows", () => {
  it("types the documented PowerShell command, the same npm command, or nothing (the docs instead)", async () => {
    const { installCommandFor } = await import("@plannotator/acp-client/agents");
    const win = (a: AgentDescriptor) => installCommandFor(a.installCommand, a.installCommandWindows, "win32");
    expect(win(CURSOR)).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(win(OPENCODE)).toBe("npm install -g opencode-ai");
    expect(win(COPILOT)).toBe("npm install -g @github/copilot");
    expect(win(KILO)).toBe("npm install -g @kilocode/cli");
    expect(win(KIRO)).toBeNull();
    for (const a of KNOWN_AGENTS) expect(win(a) ?? "").not.toContain("| bash");
    expect(installCommandFor(CURSOR.installCommand, CURSOR.installCommandWindows, "darwin")).toBe(CURSOR.installCommand);
    const kiro = resolveAgentLaunch(KIRO, {}, () => null, () => null, "win32");
    expect(!kiro.ok && kiro.message).toBe("Kiro CLI is not installed: `kiro-cli` is not on PATH. Install it as its docs say (https://kiro.dev/docs/cli/acp/), then try again.");
  });
});

describe("an `agent` on PATH that may not be Cursor's", () => {
  // Fake programs in a scratch folder: the real CLIs are never run.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guides-same-program-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "ran.log");
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> '${log}'\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ran = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const at = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;
  const posix = process.platform !== "win32";

  beforeEach(() => {
    forgetSameProgramAnswers();
    rmSync(log, { force: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.if(posix)("refuses Grok Build's `agent`, which prints its own version line", () => {
    const grok = script(join(bin, "agent-grok"), 'echo "grok 1.0.70 (f50904eaee6c) [stable]"');
    const r = resolveAgentLaunch(CURSOR, {}, at({ agent: grok }));
    expect(r).toMatchObject({ ok: false, reason: "agent" });
    expect(!r.ok && r.message).toContain("the `agent` there is another program");
    expect(ran()).toEqual([`${grok} --version`]);
    // Asked once per file: a second look reads the cached answer.
    resolveAgentLaunch(CURSOR, {}, at({ agent: grok }));
    expect(ran()).toHaveLength(1);
    // Never started with `acp`.
    expect(ran().some((l) => l.endsWith(" acp"))).toBe(false);
  });

  it.if(posix)("takes an `agent` that prints Cursor's dated build as Cursor", () => {
    const cursor = script(join(bin, "agent-cursor"), 'echo "2026.07.08-0c04a8a"');
    expect(resolveAgentLaunch(CURSOR, {}, at({ agent: cursor }))).toEqual({ ok: true, command: cursor, args: ["acp"], source: "path" });
    expect(ran()).toEqual([`${cursor} --version`]);
  });

  it.if(posix)("takes an `agent` linked to Cursor's install without running it", () => {
    const versions = join(root, "share", "cursor-agent", "versions", "2026.07.08-0c04a8a");
    mkdirSync(versions, { recursive: true });
    const real = script(join(versions, "cursor-agent"), "exit 1");
    const link = join(bin, "agent-linked");
    symlinkSync(real, link);
    expect(resolveAgentLaunch(CURSOR, {}, at({ agent: link }))).toEqual({ ok: true, command: link, args: ["acp"], source: "path" });
    expect(ran()).toEqual([]);
  });

  it.if(posix)("refuses an `agent` whose version line only looks dated, or that fails", () => {
    const sig = CURSOR.altCommandsSignature!;
    for (const [name, body] of [
      ["agent-semver", 'echo "1.2.3"'],
      ["agent-prefixed-line", 'echo "agent 2026.07.08-0c04a8a"'],
      ["agent-fails", 'echo "2026.07.08-0c04a8a"; exit 2'],
      ["agent-silent", "true"],
    ] as const) {
      expect(isSameProgram(script(join(bin, name), body), sig)).toBe(false);
    }
  });

  it.if(posix)("never waits on a program that does not answer", () => {
    const hang = script(join(bin, "agent-hang"), "exec sleep 30");
    const started = Date.now();
    expect(readVersionLine(hang, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

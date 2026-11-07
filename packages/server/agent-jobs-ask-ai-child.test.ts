/**
 * Every agent job the review server starts (code review, Code Tour, Guided
 * Review; Claude, Codex and the marker engines) runs with Plannotator's own
 * integration off, as Ask AI's agents do (packages/ai/providers/ask-ai-env.ts):
 * PLANNOTATOR_ASK_AI_CHILD=1 with the Inbox tool and agent tool switches at 0
 * in its env, the Codex `-c` override that turns the Inbox MCP server off, and
 * the Claude disallow of `mcp__plannotator-inbox`. Without them a job's agent
 * could load the person's Inbox MCP server or block on a plan or Stop hook.
 *
 * Each job is built by its real command builder and spawned through the real
 * POST /api/agents/jobs handler. Fake `claude`, `codex` and `opencode` on PATH
 * (never a real CLI) record the env and argv they get. The Pi mirror is
 * apps/pi-extension/server/agent-jobs-ask-ai-child.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { buildClaudeCommand } from "./claude-review";
import { buildCodexCommand, generateOutputPath } from "./codex-review";
import { buildGuideClaudeCommand, buildGuideCodexCommand, generateGuideOutputPath } from "./guide/guide-review";
import { buildMarkerCommand, MARKER_ENGINES } from "./marker-review";
import { buildTourClaudeCommand, buildTourCodexCommand, generateTourOutputPath } from "./tour/tour-review";
import { createAgentJobHandler, type AgentJobHandlerOptions } from "./agent-jobs";

const SWITCHES = ["PLANNOTATOR_ASK_AI_CHILD", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_AGENT_TOOL"] as const;
const SANDBOX_KEYS = ["PATH", "HOME", "CODEX_HOME", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_CONNECT", "NO_BROWSER", ...SWITCHES];

type Built = Awaited<ReturnType<NonNullable<AgentJobHandlerOptions["buildCommand"]>>>;
type JobRecord = { env: { [key: string]: string | null }; argv: string[] };

let root = "";
let saved: { [key: string]: string | undefined } = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-job-ask-ai-child-"));
  const bin = join(root, "bin");
  for (const dir of [bin, join(root, "home"), join(root, "codex-home"), join(root, "data"), join(root, "cwd")]) mkdirSync(dir);
  for (const name of ["claude", "codex", "opencode"]) {
    const fake = join(bin, name);
    writeFileSync(fake, [
      `#!${process.execPath}`,
      `const env = Object.fromEntries(${JSON.stringify(SWITCHES)}.map((k) => [k, process.env[k] ?? null]));`,
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "record.json"))}, JSON.stringify({ env, argv: process.argv.slice(2) }));`,
    ].join("\n"));
    chmodSync(fake, 0o755);
  }
  saved = Object.fromEntries(SANDBOX_KEYS.map((key) => [key, process.env[key]]));
  // Only the fakes and the system tools: no real agent CLI is reachable.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = join(root, "home");
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  process.env.NO_BROWSER = NO_BROWSER;
  // The person's own switches, which a job must override, not inherit.
  process.env.PLANNOTATOR_INBOX_TOOL = "1";
  process.env.PLANNOTATOR_AGENT_TOOL = "1";
  delete process.env.PLANNOTATOR_ASK_AI_CHILD;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Launch one job through the real handler; resolve with what the fake recorded. */
async function runJob(provider: string, build: (cwd: string) => Promise<Built>, engine?: string): Promise<JobRecord> {
  let done: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const handler = createAgentJobHandler({
    mode: "review",
    getServerUrl: () => "http://localhost:1234",
    getCwd: () => join(root, "cwd"),
    buildCommand: () => build(join(root, "cwd")),
    async onJobComplete() { done?.(); },
  });
  try {
    const res = await handler.handle(new Request("http://localhost/api/agents/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, ...(engine && { engine }) }),
    }), new URL("http://localhost/api/agents/jobs"));
    expect(res?.status).toBe(201);
    await completed;
    return JSON.parse(readFileSync(join(root, "record.json"), "utf8")) as JobRecord;
  } finally {
    handler.killAll();
  }
}

const claudeJob = (command: string[], stdinPrompt: string, cwd: string): Built => ({ command, stdinPrompt, cwd, captureStdout: true, engine: "claude" });

const JOBS: Array<{ name: string; provider: string; engine?: string; build: (cwd: string) => Promise<Built> }> = [
  { name: "code review, Claude", provider: "claude", build: async (cwd) => { const b = buildClaudeCommand("review"); return claudeJob(b.command, b.stdinPrompt, cwd); } },
  { name: "code review, Codex", provider: "codex", build: async (cwd) => { const outputPath = generateOutputPath(); return { command: await buildCodexCommand({ cwd, outputPath, prompt: "review" }), outputPath, cwd }; } },
  { name: "code review, OpenCode", provider: "opencode", build: async (cwd) => ({ command: buildMarkerCommand(MARKER_ENGINES.opencode, "review", undefined, cwd).command, cwd, captureStdout: true }) },
  { name: "Code Tour, Claude", provider: "tour", engine: "claude", build: async (cwd) => { const b = buildTourClaudeCommand("tour"); return claudeJob(b.command, b.stdinPrompt, cwd); } },
  { name: "Code Tour, Codex", provider: "tour", engine: "codex", build: async (cwd) => { const outputPath = generateTourOutputPath(); return { command: await buildTourCodexCommand({ cwd, outputPath, prompt: "tour" }), outputPath, cwd, engine: "codex" }; } },
  { name: "Guided Review, Claude", provider: "guide", engine: "claude", build: async (cwd) => { const b = buildGuideClaudeCommand("guide"); return claudeJob(b.command, b.stdinPrompt, cwd); } },
  { name: "Guided Review, Codex", provider: "guide", engine: "codex", build: async (cwd) => { const outputPath = generateGuideOutputPath(); return { command: await buildGuideCodexCommand({ cwd, outputPath, prompt: "guide" }), outputPath, cwd, engine: "codex" }; } },
  { name: "Guided Review, OpenCode", provider: "guide", engine: "opencode", build: async (cwd) => ({ command: buildMarkerCommand(MARKER_ENGINES.opencode, "guide", undefined, cwd).command, cwd, captureStdout: true, engine: "opencode" }) },
];

describe("agent jobs never load Plannotator's own integration", () => {
  for (const job of JOBS) {
    test(`${job.name}: the agent gets the marker and both switches off`, async () => {
      if (process.platform === "win32") return; // the fakes rely on a shebang
      const { env, argv } = await runJob(job.provider, job.build, job.engine);
      expect(env).toEqual({ PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" });
      // Only the job's env changed: the server's (the person's session) did not.
      expect(process.env.PLANNOTATOR_ASK_AI_CHILD).toBeUndefined();
      expect(process.env.PLANNOTATOR_INBOX_TOOL).toBe("1");

      if (job.name.endsWith("Codex")) {
        // Codex starts a stdio MCP server with none of this env, so the
        // Inbox server is turned off by a global `-c`, before `exec`.
        const at = argv.findIndex((arg) => arg.startsWith("mcp_servers.plannotator-inbox="));
        expect(at).toBeGreaterThan(0);
        expect(argv[at - 1]).toBe("-c");
        expect(argv[at]).toContain("enabled=false");
        expect(at).toBeLessThan(argv.indexOf("exec"));
      }
      if (job.name.endsWith("Claude")) {
        const disallowed = argv[argv.indexOf("--disallowedTools") + 1]!.split(",");
        expect(disallowed).toContain("mcp__plannotator-inbox");
        expect(argv).toContain("--strict-mcp-config");
      }
    });
  }

  test("Codex: an Inbox server with a url in $CODEX_HOME/config.toml is only disabled", async () => {
    if (process.platform === "win32") return;
    // A whole stub would give that entry both `command` and `url`, which Codex rejects.
    writeFileSync(join(root, "codex-home", "config.toml"), '[mcp_servers.plannotator-inbox]\nurl = "http://127.0.0.1:1/mcp"\n');
    const { argv } = await runJob("codex", JOBS[1]!.build);
    expect(argv).toContain("mcp_servers.plannotator-inbox.enabled=false");
    expect(argv.some((arg) => arg.startsWith("mcp_servers.plannotator-inbox={"))).toBe(false);
  });
});

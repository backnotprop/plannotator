/**
 * The `agentTool` setting through the Bun servers:
 *  - POST /api/config refuses a cross-origin write on every server (a page on
 *    another site must not be able to turn the tool on, or flip any other
 *    setting), accepts `agentTool` as a boolean only;
 *  - /api/plan's serverConfig advertises the tool only when the integration
 *    that started the server registers it: the pull-bridge host the Claude
 *    Code mod / OpenCode 2 plugin hands the CLI, or an in-process bridge's
 *    host. The agent origin alone is not enough (classic hook, OpenCode 1).
 * The Pi mirror is apps/pi-extension/agent-tool-config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionBridge } from "@plannotator/ai";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-tool-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  delete process.env.PLANNOTATOR_PORT;
  delete process.env.PLANNOTATOR_AGENT_TOOL;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const serverConfig = async (url: string) =>
  ((await (await fetch(`${url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;

/** A bridge as OpenCode 2's embedded plan review passes it in-process; only `host` is read here. */
const opencodeBridge = { host: "opencode", status: () => "ready", modes: { turn: true, transient: false }, ask: async () => undefined } as unknown as SessionBridge;

describe("POST /api/config on the Bun servers", () => {
  const servers = {
    plan: () => startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML }),
    review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
    annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
  };
  for (const [name, start] of Object.entries(servers)) {
    test(`${name}: a cross-origin write is refused and writes nothing; same-origin and Origin-less writes work`, async () => {
      const server = await start();
      try {
        // The text/plain shape a page can send without a CORS preflight.
        const forged = await fetch(`${server.url}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
          body: JSON.stringify({ agentTool: true, autoUpdate: true }),
        });
        expect(forged.status).toBe(403);
        expect(loadConfig()).toEqual({});

        expect((await post(server.url, { agentTool: true }, { Origin: new URL(server.url).origin })).status).toBe(200);
        expect(loadConfig().agentTool).toBe(true);
        expect((await post(server.url, { agentTool: false })).status).toBe(200);
        expect(loadConfig().agentTool).toBe(false);
        // Boolean only.
        expect((await post(server.url, { agentTool: "true" })).status).toBe(200);
        expect(loadConfig().agentTool).toBe(false);
      } finally {
        server.stop();
      }
    });
  }
});

describe("the agent tool advert on the Bun servers", () => {
  test("no tool integration started the server (classic hook): no agentTool fields, even with origin claude-code", async () => {
    const server = await startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      const config = await serverConfig(server.url);
      expect(Object.keys(config).filter((key) => key.startsWith("agentTool"))).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("an in-process OpenCode 2 bridge: the OpenCode view (off by default), a saved choice, an env override", async () => {
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "opencode", htmlContent: MINIMAL_HTML, sessionBridge: opencodeBridge, opencodeToolCapable: true });
    try {
      expect(await serverConfig(server.url)).toMatchObject({ agentTool: false, agentToolConfigured: false, agentToolHost: "opencode", agentToolEnabled: false });
      await post(server.url, { agentTool: true });
      expect(await serverConfig(server.url)).toMatchObject({ agentTool: true, agentToolConfigured: true, agentToolEnabled: true });
      process.env.PLANNOTATOR_AGENT_TOOL = "0";
      expect(await serverConfig(server.url)).toMatchObject({ agentTool: true, agentToolEnv: false, agentToolEnabled: false });
    } finally {
      server.stop();
    }
  });

  test("an OpenCode bridge whose host cannot register the tool: no agentTool fields", async () => {
    // A host without a tool domain, or a plugin release from before the tool,
    // still bridges the session; it must not be offered a switch for a tool
    // it cannot have.
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "opencode", htmlContent: MINIMAL_HTML, sessionBridge: opencodeBridge });
    try {
      const config = await serverConfig(server.url);
      expect([config.agentToolHost, config.agentToolEnabled]).toEqual([undefined, undefined]);
    } finally {
      server.stop();
    }
  });

  // The CLI reads the launching host once per process from the pull-bridge
  // env the mod / OpenCode 2 plugin set, so each case runs in its own process.
  async function launchingHost(env: Record<string, string>, discard = false, advert = false): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-launching-host-"));
    try {
      const runner = join(dir, "runner.ts");
      const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
      writeFileSync(runner, `
        import { agentToolHostForServer, discardEnvPullSessionBridgeConfig, launchingSessionHost } from ${JSON.stringify(runtimeUrl)};
        ${discard ? "discardEnvPullSessionBridgeConfig();" : ""}
        console.log(JSON.stringify((${advert ? "agentToolHostForServer()" : "launchingSessionHost()"}) ?? null));
      `);
      const base = { ...process.env };
      for (const key of ["PLANNOTATOR_SESSION_BRIDGE_TOKEN", "PLANNOTATOR_SESSION_BRIDGE_HOST", "PLANNOTATOR_SESSION_BRIDGE_MODES", "PLANNOTATOR_OPENCODE_TOOL_CAPABLE"]) delete base[key];
      const proc = Bun.spawn([process.execPath, runner], { cwd: import.meta.dir, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the launching host comes from the pull-bridge env; kept in remote mode and after a --tailscale discard", async () => {
    const mod = { PLANNOTATOR_SESSION_BRIDGE_TOKEN: "k".repeat(43), PLANNOTATOR_SESSION_BRIDGE_HOST: "claude-code" };
    expect(await launchingHost(mod)).toBe("claude-code");
    expect(await launchingHost({ ...mod, PLANNOTATOR_REMOTE: "1" })).toBe("claude-code");
    expect(await launchingHost(mod, true)).toBe("claude-code");
    // No integration (classic hook, OpenCode 1, a shell), or a malformed one.
    expect(await launchingHost({})).toBeNull();
    expect(await launchingHost({ ...mod, PLANNOTATOR_SESSION_BRIDGE_TOKEN: "short" })).toBeNull();
  }, 20_000);

  test("a CLI launched by an OpenCode plugin advertises the tool only with its capability marker", async () => {
    const opencode = { PLANNOTATOR_SESSION_BRIDGE_TOKEN: "k".repeat(43), PLANNOTATOR_SESSION_BRIDGE_HOST: "opencode" };
    expect(await launchingHost(opencode, false, true)).toBeNull();
    expect(await launchingHost({ ...opencode, PLANNOTATOR_OPENCODE_TOOL_CAPABLE: "1" }, false, true)).toBe("opencode");
  }, 20_000);
});

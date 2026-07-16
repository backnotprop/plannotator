import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_TERMINAL_WS_BASE_PATH } from "@plannotator/shared/agent-terminal";
import { createBunAgentTerminalBridge } from "./agent-terminal";

describe("bun agent terminal bridge", () => {
  test("node sidecar rebuilds spawn options from the server-owned launch plan", async () => {
    const nodePath = Bun.which("node");
    expect(nodePath).toBeTruthy();
    if (!nodePath) return;

    const tmp = mkdtempSync(join(tmpdir(), "plannotator-agent-sidecar-"));
    const normalizedPath = join(tmp, "normalized.json");
    const corePath = join(tmp, "webtui-core.mjs");
    const serverPath = join(tmp, "webtui-server.mjs");

    writeFileSync(corePath, `
export function listBuiltInAgents() {
  return ["claude"];
}
export function buildAgentLaunchPlan(options) {
  return {
    agent: options.agent,
    command: "claude",
    expectedProcess: "claude",
    env: { SERVER_VALUE: "safe" },
    followupPrompt: null,
    promptInjectionMode: "argv",
    preflightTrust: "codex",
    draftPasteReadySignal: null,
    promptDelivery: "none",
  };
}
`);
    writeFileSync(serverPath, `
import { writeFileSync } from "node:fs";

export class NodePtyBackend {
  async spawn(options) {
    writeFileSync(process.env.TEST_NORMALIZED_FILE, JSON.stringify(options));
    return {
      id: "test-session",
      write() {},
      resize() {},
      kill() {},
      onData() { return () => {}; },
      onExit() { return () => {}; },
    };
  }
}

export function createNodePtyWebSocketServer(options) {
  setTimeout(() => {
    void options.backend.spawn(JSON.parse(process.env.TEST_SPAWN_OPTIONS));
  }, 0);
  return {
    close: async () => {},
    address: () => null,
  };
}
`);

    const sidecarPath = join(import.meta.dir, "agent-terminal-node-sidecar.mjs");
    const proc = Bun.spawn([nodePath, sidecarPath], {
      cwd: tmp,
      env: {
        ...process.env,
        PLANNOTATOR_AGENT_CWD: "/server/cwd",
        PLANNOTATOR_AGENT_WS_PATH: "/api/agent-terminal/pty/test",
        PLANNOTATOR_AGENT_WEBTUI_CORE_URL: pathToFileURL(corePath).href,
        PLANNOTATOR_AGENT_WEBTUI_SERVER_URL: pathToFileURL(serverPath).href,
        TEST_NORMALIZED_FILE: normalizedPath,
        TEST_SPAWN_OPTIONS: JSON.stringify({
          agent: "claude",
          command: "node -e 'throw new Error(\"client command ran\")'",
          cwd: "/client/cwd",
          env: { CLIENT_VALUE: "must-not-pass-through" },
          cols: 2000,
          rows: -5,
          startupCommandMode: "shell-command",
          preflightTrust: "cursor",
        }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await readFirstLine(proc.stdout, 5_000);
      await waitForFile(normalizedPath);
      expect(JSON.parse(readFileSync(normalizedPath, "utf8"))).toEqual({
        agent: "claude",
        command: "claude",
        cwd: "/server/cwd",
        startupCommandMode: "shell-ready",
        cols: 1000,
        env: { SERVER_VALUE: "safe" },
        preflightTrust: "codex",
      });
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reports a disabled capability when annotate terminal support is off", async () => {
    const bridge = await createBunAgentTerminalBridge({
      enabled: false,
      cwd: "/tmp/plannotator-agent-cwd",
    });

    expect(bridge.capability).toEqual({
      enabled: false,
      reason: "not-annotate-mode",
    });
    bridge.dispose();
  });

  test("loads WebTUI and reports browser-safe capability metadata", async () => {
    const bridge = await createBunAgentTerminalBridge({
      enabled: true,
      cwd: "/tmp/plannotator-agent-cwd",
    });

    try {
      expect(bridge.capability).toMatchObject({
        enabled: true,
        cwd: "/tmp/plannotator-agent-cwd",
      });
      if (!bridge.capability.enabled) {
        throw new Error("Expected enabled agent terminal capability");
      }
      expect(bridge.capability.wsPath.startsWith(`${AGENT_TERMINAL_WS_BASE_PATH}/`)).toBe(true);
      expect(bridge.capability.wsPath).not.toBe(AGENT_TERMINAL_WS_BASE_PATH);
      expect(bridge.matches(bridge.capability.wsPath)).toBe(true);
      expect(bridge.matches(AGENT_TERMINAL_WS_BASE_PATH)).toBe(false);
      expect(bridge.capability.agents.length).toBeGreaterThan(0);
      expect(bridge.capability.agents[0]).toHaveProperty("id");
      expect(bridge.capability.agents[0]).toHaveProperty("name");
      expect(bridge.capability.agents[0]).toHaveProperty("available");
    } finally {
      bridge.dispose();
    }
  });

  test("reports disabled capability in remote mode without terminal opt-in", async () => {
    const previousRemote = process.env.PLANNOTATOR_REMOTE;
    const previousAgentRemote = process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE;
    process.env.PLANNOTATOR_REMOTE = "1";
    delete process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE;
    try {
      const bridge = await createBunAgentTerminalBridge({
        enabled: true,
        cwd: "/tmp/plannotator-agent-cwd",
      });

      expect(bridge.capability).toMatchObject({
        enabled: false,
        reason: "remote-disabled",
      });
      expect(bridge.matches(`${AGENT_TERMINAL_WS_BASE_PATH}/anything`)).toBe(false);
      bridge.dispose();
    } finally {
      if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
      else process.env.PLANNOTATOR_REMOTE = previousRemote;
      if (previousAgentRemote === undefined) delete process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE;
      else process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE = previousAgentRemote;
    }
  });

  test("allows terminal capability in remote mode with explicit opt-in", async () => {
    const previousRemote = process.env.PLANNOTATOR_REMOTE;
    const previousAgentRemote = process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE;
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE = "1";
    try {
      const bridge = await createBunAgentTerminalBridge({
        enabled: true,
        cwd: "/tmp/plannotator-agent-cwd",
      });

      try {
        expect(bridge.capability.enabled).toBe(true);
        if (!bridge.capability.enabled) {
          throw new Error("Expected enabled agent terminal capability");
        }
        expect(bridge.capability.wsPath.startsWith(`${AGENT_TERMINAL_WS_BASE_PATH}/`)).toBe(true);
        expect(bridge.matches(bridge.capability.wsPath)).toBe(true);
      } finally {
        bridge.dispose();
      }
    } finally {
      if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
      else process.env.PLANNOTATOR_REMOTE = previousRemote;
      if (previousAgentRemote === undefined) delete process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE;
      else process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE = previousAgentRemote;
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function readFirstLine(stream: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<string> {
  if (!stream) throw new Error("Missing stream");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => {
    void reader.cancel("Timed out waiting for first line").catch(() => {});
  }, timeoutMs);
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) return text.slice(0, newline).trim();
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  throw new Error("Stream ended before first line");
}

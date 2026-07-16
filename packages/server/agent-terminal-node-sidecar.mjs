// Runs under Node.js, not Bun: it hosts node-pty, a native addon Bun can't
// load. The parent Bun server spawns this sidecar (see agent-terminal-runtime.ts).
import { createServer } from "node:http";

const webtuiCoreUrl = process.env.PLANNOTATOR_AGENT_WEBTUI_CORE_URL || "@plannotator/webtui/core";
const webtuiServerUrl = process.env.PLANNOTATOR_AGENT_WEBTUI_SERVER_URL || "@plannotator/webtui/server";
const { buildAgentLaunchPlan, listBuiltInAgents } = await import(webtuiCoreUrl);
const { createNodePtyWebSocketServer, NodePtyBackend } = await import(webtuiServerUrl);

const cwd = process.env.PLANNOTATOR_AGENT_CWD || process.cwd();
const wsPath = process.env.PLANNOTATOR_AGENT_WS_PATH || "/api/agent-terminal/pty";
const allowedAgents = new Set(listBuiltInAgents());
const sessions = new Set();
let spawnInFlight = false;

const baseBackend = new NodePtyBackend();
const backend = {
  async spawn(options) {
    if (spawnInFlight || sessions.size > 0) {
      throw new Error("An agent terminal is already running.");
    }
    const normalized = normalizeSpawnOptions(options);
    spawnInFlight = true;
    try {
      const session = wrapPtySession(await baseBackend.spawn(normalized));
      sessions.add(session);
      session.onExit(() => sessions.delete(session));
      return session;
    } finally {
      spawnInFlight = false;
    }
  },
};

const server = createServer((_, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});
const ptyServer = createNodePtyWebSocketServer({ server, path: wsPath, backend });

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    writeReady({ ok: false, error: "Agent terminal sidecar did not bind a TCP port." });
    return;
  }
  writeReady({ ok: true, wsUrl: `ws://127.0.0.1:${address.port}${wsPath}` });
});

server.on("error", (err) => {
  writeReady({ ok: false, error: err instanceof Error ? err.message : String(err) });
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.resume();
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

function normalizeSpawnOptions(options) {
  if (!options.agent) {
    throw new Error("Agent terminal requires a built-in WebTUI agent.");
  }
  if (!allowedAgents.has(options.agent)) {
    throw new Error(`Unknown WebTUI agent: ${options.agent}`);
  }
  const launch = buildAgentLaunchPlan({
    agent: options.agent,
    allowEmptyPromptLaunch: true,
  });
  const normalized = {
    agent: launch.agent,
    command: launch.command,
    cwd,
    startupCommandMode: "shell-ready",
  };
  const cols = normalizeTerminalDimension(options.cols);
  if (cols !== undefined) normalized.cols = cols;
  const rows = normalizeTerminalDimension(options.rows);
  if (rows !== undefined) normalized.rows = rows;
  if (Object.keys(launch.env).length > 0) normalized.env = launch.env;
  if (launch.preflightTrust) normalized.preflightTrust = launch.preflightTrust;
  return normalized;
}

function normalizeTerminalDimension(value) {
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return Math.min(value, 1_000);
}

function wrapPtySession(session) {
  let exited = false;
  const exitListeners = new Set();
  let underlyingExitUnsubscribe = null;

  function markExited(exit) {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(exit);
    exitListeners.clear();
    underlyingExitUnsubscribe?.();
    underlyingExitUnsubscribe = null;
  }

  function markClosed() {
    markExited({ exitCode: null, signal: "closed" });
  }

  return {
    id: session.id,
    write(data) {
      if (exited) return;
      try {
        session.write(data);
      } catch {
        markClosed();
      }
    },
    resize(cols, rows) {
      if (exited) return;
      try {
        session.resize(cols, rows);
      } catch {
        markClosed();
      }
    },
    kill(signal) {
      if (exited) return;
      try {
        session.kill(signal);
      } catch {
        markClosed();
      }
    },
    onData(callback) {
      return session.onData(callback);
    },
    onExit(callback) {
      exitListeners.add(callback);
      if (!underlyingExitUnsubscribe) {
        underlyingExitUnsubscribe = session.onExit(markExited);
      }
      return () => exitListeners.delete(callback);
    },
    getForegroundProcess: session.getForegroundProcess
      ? async () => {
          if (exited || !session.getForegroundProcess) return null;
          try {
            return await session.getForegroundProcess();
          } catch {
            return null;
          }
        }
      : undefined,
    hasChildProcesses: session.hasChildProcesses
      ? async () => {
          if (exited || !session.hasChildProcesses) return false;
          try {
            return await session.hasChildProcesses();
          } catch {
            return false;
          }
        }
      : undefined,
  };
}

function writeReady(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function shutdown() {
  for (const session of sessions) {
    try {
      session.kill();
    } catch {
      // Best effort during process shutdown.
    }
  }
  sessions.clear();
  void ptyServer.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
}

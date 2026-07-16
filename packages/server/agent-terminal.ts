import { randomBytes } from "node:crypto";
import {
  buildAgentTerminalWsPath,
  type AgentTerminalAgent,
  type AgentTerminalCapability,
} from "@plannotator/shared/agent-terminal";
import { isRemoteSession } from "./remote";
import {
  isAgentTerminalRemoteEnabled,
  resolveAgentTerminalRuntime,
  type ResolvedAgentTerminalRuntime,
} from "./agent-terminal-runtime";

type AgentTerminalSocketData = {
  upstream: WebSocket | null;
  pending: string[];
};

const MAX_PENDING_MESSAGES = 100;

type WebTuiCore = typeof import("@plannotator/webtui/core");

type NodeAgentTerminalSidecar = {
  wsUrl: string;
  exited: Promise<void>;
  dispose(): void;
};

export type BunAgentTerminalBridge = {
  capability: AgentTerminalCapability;
  matches(pathname: string): boolean;
  upgrade(req: Request, server: Bun.Server<AgentTerminalSocketData>): boolean;
  websocket: Bun.WebSocketHandler<AgentTerminalSocketData>;
  dispose(): void;
};

export async function createBunAgentTerminalBridge(args: {
  enabled: boolean;
  cwd: string;
}): Promise<BunAgentTerminalBridge> {
  if (!args.enabled) {
    return createDisabledBridge({
      enabled: false,
      reason: "not-annotate-mode",
    });
  }

  if (isRemoteSession() && !isAgentTerminalRemoteEnabled()) {
    return createDisabledBridge({
      enabled: false,
      reason: "remote-disabled",
      message: "Agent terminal is disabled in remote mode. Set PLANNOTATOR_AGENT_TERMINAL_REMOTE=1 to enable it.",
    });
  }

  let core: WebTuiCore;
  try {
    core = await import("@plannotator/webtui/core");
  } catch (err) {
    return createDisabledBridge({
      enabled: false,
      reason: "webtui-unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const runtime = await resolveAgentTerminalRuntime();
  if (!runtime.ok) {
    return createDisabledBridge({
      enabled: false,
      reason: runtime.reason,
      message: runtime.message,
    });
  }
  const resolvedRuntime = runtime;

  const wsPath = buildAgentTerminalWsPath(randomBytes(18).toString("hex"));
  const upstreams = new Set<WebSocket>();
  let disposed = false;
  let connectingClients = 0;
  let sidecar: NodeAgentTerminalSidecar | null = null;
  let sidecarPromise: Promise<NodeAgentTerminalSidecar> | null = null;
  const capability: AgentTerminalCapability = {
    enabled: true,
    cwd: args.cwd,
    wsPath,
    agents: listAgents(core),
  };

  return {
    capability,
    matches(pathname) {
      return pathname === wsPath;
    },
    upgrade(req, server) {
      if (!isAllowedOrigin(req)) return false;
      return server.upgrade(req, {
        data: { upstream: null, pending: [] },
      });
    },
    websocket: {
      open(ws) {
        connectingClients += 1;
        void getSidecar().then((activeSidecar) => {
          connectingClients = Math.max(0, connectingClients - 1);
          if (disposed || ws.readyState !== WebSocket.OPEN) {
            releaseSidecarIfIdle(activeSidecar);
            return;
          }
          const upstream = new WebSocket(activeSidecar.wsUrl);
          ws.data.upstream = upstream;
          upstreams.add(upstream);

          upstream.addEventListener("open", () => {
            const queued = ws.data.pending;
            ws.data.pending = [];
            for (const payload of queued) upstream.send(payload);
          });

          upstream.addEventListener("message", (event) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(toWebSocketPayload(event.data));
            }
          });

          upstream.addEventListener("close", () => {
            upstreams.delete(upstream);
            if (ws.readyState === WebSocket.OPEN) ws.close();
            releaseSidecarIfIdle(activeSidecar);
          });

          upstream.addEventListener("error", () => {
            upstreams.delete(upstream);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: "Agent terminal backend failed." }));
              ws.close();
            }
            releaseSidecarIfIdle(activeSidecar);
          });
        }).catch((err) => {
          connectingClients = Math.max(0, connectingClients - 1);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            }));
            ws.close();
          }
        });
      },
      message(ws, raw) {
        const payload = typeof raw === "string" ? raw : raw.toString("utf8");
        const upstream = ws.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(payload);
          return;
        }
        if (ws.data.pending.length >= MAX_PENDING_MESSAGES) {
          ws.send(JSON.stringify({ type: "error", message: "Agent terminal backend is still starting." }));
          ws.close();
          return;
        }
        ws.data.pending.push(payload);
      },
      close(ws) {
        ws.data.pending = [];
        const upstream = ws.data.upstream;
        ws.data.upstream = null;
        if (upstream) {
          upstreams.delete(upstream);
          upstream.close();
        }
        releaseSidecarIfIdle();
      },
    },
    dispose() {
      disposed = true;
      for (const upstream of upstreams) upstream.close();
      upstreams.clear();
      sidecar?.dispose();
      void sidecarPromise?.then((activeSidecar) => activeSidecar.dispose()).catch(() => {});
    },
  };

  function getSidecar(): Promise<NodeAgentTerminalSidecar> {
    if (sidecar) return Promise.resolve(sidecar);
    if (!sidecarPromise) {
      let promise: Promise<NodeAgentTerminalSidecar>;
      promise = startNodeAgentTerminalSidecar(args.cwd, resolvedRuntime, wsPath).then((activeSidecar) => {
        if (disposed) {
          activeSidecar.dispose();
          throw new Error("Agent terminal bridge was disposed.");
        }
        sidecar = activeSidecar;
        void activeSidecar.exited.finally(() => {
          const wasCurrent = sidecar === activeSidecar || sidecarPromise === promise;
          if (sidecar === activeSidecar) sidecar = null;
          if (sidecarPromise === promise) sidecarPromise = null;
          if (wasCurrent) {
            for (const upstream of upstreams) upstream.close();
            upstreams.clear();
          }
        });
        return activeSidecar;
      }).catch((err) => {
        if (sidecarPromise === promise) sidecarPromise = null;
        throw err;
      });
      sidecarPromise = promise;
    }
    return sidecarPromise;
  }

  function releaseSidecarIfIdle(activeSidecar: NodeAgentTerminalSidecar | null = sidecar): void {
    if (!activeSidecar || disposed) return;
    if (connectingClients > 0 || upstreams.size > 0) return;
    if (sidecar === activeSidecar) sidecar = null;
    sidecarPromise = null;
    activeSidecar.dispose();
  }
}

function createDisabledBridge(
  capability: AgentTerminalCapability,
): BunAgentTerminalBridge {
  return {
    capability,
    matches() {
      return false;
    },
    upgrade() {
      return false;
    },
    websocket: {
      message() {},
    },
    dispose() {},
  };
}

async function startNodeAgentTerminalSidecar(
  cwd: string,
  runtime: ResolvedAgentTerminalRuntime,
  wsPath: string,
): Promise<NodeAgentTerminalSidecar> {
  const proc = Bun.spawn([runtime.nodePath, runtime.sidecarPath], {
    cwd: runtime.sidecarCwd,
    env: {
      ...process.env,
      PLANNOTATOR_AGENT_CWD: cwd,
      PLANNOTATOR_AGENT_WS_PATH: wsPath,
      PLANNOTATOR_AGENT_WEBTUI_CORE_URL: runtime.webtuiCoreUrl,
      PLANNOTATOR_AGENT_WEBTUI_SERVER_URL: runtime.webtuiServerUrl,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  try {
    const line = await withTimeout(readFirstLine(proc.stdout), 5_000);
    const ready = JSON.parse(line) as { ok?: boolean; wsUrl?: string; error?: string };
    if (!ready.ok || !ready.wsUrl) {
      throw new Error(ready.error ?? "Agent terminal sidecar did not report a WebSocket URL.");
    }
    let didDispose = false;
    return {
      wsUrl: ready.wsUrl,
      exited: proc.exited.then(() => {}, () => {}),
      dispose() {
        if (didDispose) return;
        didDispose = true;
        proc.kill();
      },
    };
  } catch (err) {
    proc.kill();
    throw err;
  }
}

async function readFirstLine(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) throw new Error("Agent terminal sidecar stdout was unavailable.");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
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
    reader.releaseLock();
  }
  throw new Error("Agent terminal sidecar exited before reporting ready.");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Agent terminal sidecar timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toWebSocketPayload(data: unknown): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (Buffer.isBuffer(data)) {
    return Uint8Array.from(data).buffer;
  }
  if (data instanceof Uint8Array) {
    return data.buffer instanceof ArrayBuffer
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : Uint8Array.from(data).buffer;
  }
  return String(data);
}

function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

function listAgents(core: WebTuiCore): AgentTerminalAgent[] {
  return core.listBuiltInAgents().map((id) => {
    const config = core.BUILT_IN_AGENTS[id];
    return {
      id,
      name: formatAgentName(id),
      available: !!Bun.which(config.detectCommand),
    };
  });
}

function formatAgentName(id: string): string {
  const overrides: Record<string, string> = {
    amp: "Amp",
    claude: "Claude",
    codex: "Codex",
    copilot: "GitHub Copilot",
    gemini: "Gemini",
    opencode: "OpenCode",
    pi: "Pi",
  };
  if (overrides[id]) return overrides[id];
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

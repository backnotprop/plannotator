import { getServerHostname, getServerPort, isRemoteSession } from "../remote";
import { openBrowser } from "../browser";
import { loadConfig } from "@plannotator/shared/config";
import { acquireDaemonLock, createDaemonState, createDaemonBrowserAuthUrl, removeDaemonState, writeDaemonState, type DaemonLock, type DaemonState, type DaemonStateOptions } from "./state";
import { DaemonSessionStore, listSnapshots, type DaemonSessionRecord } from "./session-store";
import { createDaemonFetchHandler, type DaemonFetchContext, type DaemonFetchHandler, type SessionBrowserAction } from "./server";
import type { DaemonCreateSessionRequest } from "@plannotator/shared/daemon-protocol";
import type { DaemonEventHub } from "./event-hub";

export interface StartDaemonRuntimeOptions extends DaemonStateOptions {
  shellHtmlContent: string;
  createSession: (
    request: DaemonCreateSessionRequest,
    context: DaemonFetchContext,
  ) => DaemonSessionRecord | Promise<DaemonSessionRecord>;
  onShutdown?: () => void | Promise<void>;
  hostname?: string;
  port?: number;
  binaryVersion?: string;
}

export interface DaemonRuntime {
  state: DaemonState;
  store: DaemonSessionStore;
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
}

function getRemoteSource(): DaemonState["remoteSource"] {
  if (process.env.PLANNOTATOR_REMOTE !== undefined) return "env";
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return "ssh";
  return "local";
}

export async function startDaemonRuntime(options: StartDaemonRuntimeOptions): Promise<DaemonRuntime> {
  const lockResult = acquireDaemonLock(options);
  if (!lockResult.ok) {
    throw new Error(lockResult.message);
  }

  let lock: DaemonLock | undefined = lockResult.lock;
  const store = new DaemonSessionStore();

  const isRemote = isRemoteSession();
  const hostname = options.hostname ?? getServerHostname();
  const requestedPort = options.port ?? getServerPort();
  let runtime: DaemonRuntime | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let handler: DaemonFetchHandler | undefined;
  let stopping = false;

  try {
    server = Bun.serve({
      hostname,
      port: requestedPort,
      fetch: (req, server) => {
        if (stopping) return new Response("Daemon is stopping", { status: 503 });
        if (!handler) return new Response("Daemon is starting", { status: 503 });
        return handler(req, {
          disableIdleTimeout: () => server.timeout(req, 0),
          upgradeWebSocket: (data) =>
            server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 }),
        });
      },
      websocket: {
        open: (socket) => handler?.websocket.open?.(socket as never),
        message: (socket, message) => handler?.websocket.message?.(socket as never, message),
        close: (socket, code, reason) => handler?.websocket.close?.(socket as never, code, reason),
      },
      error: (error) => {
        console.error("[Plannotator daemon] Unhandled request error:", error);
        return new Response("Internal Plannotator daemon error", { status: 500 });
      },
    });

    const state = createDaemonState({
      port: server.port!,
      hostname,
      isRemote,
      remoteSource: getRemoteSource(),
      binaryVersion: options.binaryVersion,
      requestedPort,
    });

    for (const snapshot of listSnapshots()) {
      if (store.get(snapshot.sessionId)) continue;
      store.create({
        id: snapshot.sessionId,
        mode: snapshot.mode,
        url: `${state.baseUrl}/s/${snapshot.sessionId}`,
        project: snapshot.meta.project,
        cwd: snapshot.meta.cwd,
        label: snapshot.meta.label,
        origin: snapshot.meta.origin,
        result: snapshot.result,
      });
    }

    async function presentSession(record: DaemonSessionRecord, eventHub: DaemonEventHub): Promise<SessionBrowserAction> {
      const config = loadConfig();
      const frontendState = eventHub.getFrontendState();
      if (!config.legacyTabMode && frontendState.connected && frontendState.anyVisible) {
        eventHub.publishDaemonEvent({
          type: "session-notify",
          at: new Date().toISOString(),
          session: store.summary(record),
        });
        return "notified";
      }
      const url = createDaemonBrowserAuthUrl(state, new URL(record.url).pathname);
      await openBrowser(url, { isRemote });
      return "opened";
    }

    handler = createDaemonFetchHandler({
      state,
      store,
      shellHtmlContent: options.shellHtmlContent,
      createSession: options.createSession,
      presentSession,
      onShutdown: async () => {
        await runtime?.stop();
        await options.onShutdown?.();
      },
    });
    writeDaemonState(state, options);
    cleanupTimer = setInterval(() => {
      void store.cleanupExpired();
    }, 60_000);

    const activeServer = server;
    runtime = {
      state,
      store,
      server: activeServer,
      stop: async () => {
        if (stopping) return;
        stopping = true;
        handler?.eventHub.closeAll();
        activeServer.stop();
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = undefined;
        }
        await store.cancelAll();
        lock?.release();
        lock = undefined;
        removeDaemonState(options);
      },
    };

    return runtime;
  } catch (err) {
    if (cleanupTimer) clearInterval(cleanupTimer);
    server?.stop();
    lock.release();
    throw err;
  }
}

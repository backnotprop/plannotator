import { getServerHostname, getServerPort, isRemoteSession } from "../remote";
import { acquireDaemonLock, createDaemonState, removeDaemonState, writeDaemonState, type DaemonLock, type DaemonState, type DaemonStateOptions } from "./state";
import { DaemonSessionStore, type DaemonSessionRecord } from "./session-store";
import { createDaemonFetchHandler, type DaemonFetchContext } from "./server";
import type { DaemonCreateSessionRequest } from "@plannotator/shared/daemon-protocol";

export interface StartDaemonRuntimeOptions extends DaemonStateOptions {
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
  let handler: ReturnType<typeof createDaemonFetchHandler> | undefined;
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
        });
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
    handler = createDaemonFetchHandler({
      state,
      store,
      createSession: options.createSession,
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

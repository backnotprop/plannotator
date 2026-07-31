import { PRESENTER_DISMISS_TIMEOUT_MS } from "@plannotator/shared/presenter";

export type FatalSignal = "SIGINT" | "SIGTERM";

export interface StoppableServer {
  stop: () => void | Promise<void>;
}

export interface ServerShutdownCoordinator {
  trackServerStart: <T extends StoppableServer>(
    serverStart: Promise<T>,
  ) => Promise<T>;
  handleSignal: (signal: FatalSignal) => Promise<void>;
}

export interface ServerShutdownCoordinatorOptions {
  exit: (code: number) => void;
  waitForServerCleanup: boolean;
  cleanupTimeoutMs?: number;
  onStopError?: (error: unknown) => void;
}

/**
 * Server cleanup ends with a presenter dismiss that is itself bounded by
 * PRESENTER_DISMISS_TIMEOUT_MS. The budget must exceed that bound, or a
 * dismiss that times out races the coordinator's force-exit instead of
 * resolving inside it — the 2s headroom covers the rest of the stop routine
 * (lease flush, socket teardown) around the worst-case dismiss.
 */
const DEFAULT_CLEANUP_TIMEOUT_MS = PRESENTER_DISMISS_TIMEOUT_MS + 2_000;

function exitCodeForSignal(signal: FatalSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Coordinates process signals with the one server owned by the hook CLI.
 *
 * When presenter cleanup is enabled, the first signal gives the active server
 * a bounded window to stop. Without a presenter, the first signal preserves
 * the CLI's immediate-exit behavior. A second signal always force-exits.
 */
export function createServerShutdownCoordinator({
  exit,
  waitForServerCleanup,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  onStopError = () => {},
}: ServerShutdownCoordinatorOptions): ServerShutdownCoordinator {
  let activeServer: Promise<StoppableServer> | undefined;
  let shutdownStarted = false;
  let forceExited = false;

  return {
    trackServerStart<T extends StoppableServer>(
      serverStart: Promise<T>,
    ): Promise<T> {
      // Track the pending start, rather than only its result. A presenter can
      // open from onReady before the start promise resolves, so a signal in
      // that window must wait for the server object and then stop it.
      activeServer = serverStart;
      return serverStart;
    },

    async handleSignal(signal: FatalSignal): Promise<void> {
      const exitCode = exitCodeForSignal(signal);

      if (shutdownStarted) {
        forceExited = true;
        exit(exitCode);
        return;
      }

      shutdownStarted = true;
      if (!waitForServerCleanup) {
        exit(exitCode);
        return;
      }

      const server = activeServer;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        const cleanup = (async () => {
          const startedServer = await server;
          await startedServer?.stop();
        })();
        const outcome = await Promise.race([
          cleanup.then(
            () => ({ status: "completed" as const }),
            (error: unknown) => ({ status: "failed" as const, error }),
          ),
          new Promise<{ status: "timed-out" }>((resolve) => {
            cleanupTimer = setTimeout(
              () => resolve({ status: "timed-out" }),
              cleanupTimeoutMs,
            );
          }),
        ]);

        if (outcome.status === "failed") {
          onStopError(outcome.error);
        } else if (outcome.status === "timed-out") {
          onStopError(
            new Error(`server cleanup timed out after ${cleanupTimeoutMs}ms`),
          );
        }
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        // With a real process, the force-exit call above never returns. The
        // guard also keeps injected test exits from producing a second exit.
        if (!forceExited) {
          exit(exitCode);
        }
      }
    },
  };
}

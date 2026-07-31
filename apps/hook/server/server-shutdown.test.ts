import { describe, expect, test } from "bun:test";
import { createServerShutdownCoordinator } from "./server-shutdown";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createServerShutdownCoordinator", () => {
  test("awaits the active server before exiting on the first signal", async () => {
    const events: string[] = [];
    const stop = createDeferred();
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: true,
    });

    void coordinator.trackServerStart(Promise.resolve({
      stop: async () => {
        events.push("stop:start");
        await stop.promise;
        events.push("stop:done");
      },
    }));

    const shutdown = coordinator.handleSignal("SIGINT");
    await Promise.resolve();
    expect(events).toEqual(["stop:start"]);

    stop.resolve();
    await shutdown;
    expect(events).toEqual(["stop:start", "stop:done", "exit:130"]);
  });

  test("reports stop failures and still exits with the signal code", async () => {
    const events: string[] = [];
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: true,
      onStopError: (error) => {
        events.push(`error:${error instanceof Error ? error.message : error}`);
      },
    });

    void coordinator.trackServerStart(Promise.resolve({
      stop: async () => {
        events.push("stop");
        throw new Error("dismiss failed");
      },
    }));

    await coordinator.handleSignal("SIGTERM");
    expect(events).toEqual([
      "stop",
      "error:dismiss failed",
      "exit:143",
    ]);
  });

  test("tracks startup so signals during onReady still stop the server", async () => {
    const events: string[] = [];
    const start = createDeferred();
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: true,
    });

    const serverStart = start.promise.then(() => ({
      stop: async () => {
        events.push("stop");
      },
    }));
    void coordinator.trackServerStart(serverStart);

    const shutdown = coordinator.handleSignal("SIGINT");
    await Promise.resolve();
    expect(events).toEqual([]);

    start.resolve();
    await shutdown;
    expect(events).toEqual(["stop", "exit:130"]);
  });

  test("uses a second signal as an immediate force exit", async () => {
    const events: string[] = [];
    const stop = createDeferred();
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: true,
    });

    void coordinator.trackServerStart(Promise.resolve({
      stop: async () => {
        events.push("stop:start");
        await stop.promise;
        events.push("stop:done");
      },
    }));

    const gracefulShutdown = coordinator.handleSignal("SIGINT");
    await Promise.resolve();
    await coordinator.handleSignal("SIGTERM");

    expect(events).toEqual(["stop:start", "exit:143"]);

    stop.resolve();
    await gracefulShutdown;
    expect(events).toEqual(["stop:start", "exit:143", "stop:done"]);
  });

  test("exits immediately when no presenter cleanup is needed", async () => {
    const events: string[] = [];
    const start = createDeferred();
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: false,
    });

    void coordinator.trackServerStart(start.promise.then(() => ({
      stop: () => {
        events.push("stop");
      },
    })));

    await coordinator.handleSignal("SIGINT");
    expect(events).toEqual(["exit:130"]);
    start.resolve();
  });

  test("forces exit when graceful cleanup reaches its deadline", async () => {
    const events: string[] = [];
    const coordinator = createServerShutdownCoordinator({
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      waitForServerCleanup: true,
      cleanupTimeoutMs: 10,
      onStopError: (error) => {
        events.push(`error:${error instanceof Error ? error.message : error}`);
      },
    });

    void coordinator.trackServerStart(new Promise(() => {}));
    await coordinator.handleSignal("SIGTERM");

    expect(events).toEqual([
      "error:server cleanup timed out after 10ms",
      "exit:143",
    ]);
  });
});

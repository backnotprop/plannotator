import { describe, expect, test } from "bun:test";
import { CallFlowInstallCoordinator, callFlowInstallOriginAllowed } from "./call-flow-install";
import type { CallFlowInstallStage, CallFlowRuntimeInstallResult } from "./call-flow";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const installed: CallFlowRuntimeInstallResult = {
  ok: true,
  status: "installed",
  runtimeDir: "/tmp/runtime",
  message: "installed",
};

describe("CallFlowInstallCoordinator", () => {
  test("concurrent starts join one in-flight install", async () => {
    let installs = 0;
    const gate = deferred<CallFlowRuntimeInstallResult>();
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: () => {
        installs++;
        return gate.promise;
      },
    });

    const [first, second, third] = await Promise.all([
      coordinator.start(),
      coordinator.start(),
      coordinator.start(),
    ]);
    expect(first).toEqual({ state: "running", stage: "downloading" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(installs).toBe(1);

    // Still running: a later POST joins rather than restarting.
    expect(await coordinator.start()).toEqual({ state: "running", stage: "downloading" });
    expect(installs).toBe(1);

    gate.resolve(installed);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done" });
  });

  test("stage callbacks advance the running status in order", async () => {
    let emit: ((stage: CallFlowInstallStage) => void) | undefined;
    const gate = deferred<CallFlowRuntimeInstallResult>();
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: (onStage) => {
        emit = onStage;
        return gate.promise;
      },
    });

    await coordinator.start();
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "downloading" });
    emit?.("verifying");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "verifying" });
    emit?.("installing-deps");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "installing-deps" });
    emit?.("building");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "building" });

    gate.resolve(installed);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done" });
    // A late stage callback can never resurrect a settled status.
    emit?.("downloading");
    expect(coordinator.getStatus()).toEqual({ state: "done" });
  });

  test("a failed Node preflight reports a distinct error before any install work", async () => {
    let installs = 0;
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: false, reason: "node-unavailable", message: "Node.js was not found." }),
      install: async () => {
        installs++;
        return installed;
      },
    });

    const status = await coordinator.start();
    expect(status).toEqual({ state: "error", error: "Node.js was not found.", reason: "node-unavailable" });
    expect(installs).toBe(0);
    // The error persists until the next start retries.
    expect(coordinator.getStatus()).toEqual(status);
  });

  test("an install failure persists as error and the next start retries", async () => {
    let installs = 0;
    const settled: boolean[] = [];
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: async () => {
        installs++;
        if (installs === 1) {
          return { ok: false, status: "failed", runtimeDir: "/tmp/runtime", message: "npm ci failed" };
        }
        return installed;
      },
      onSettled: (ok) => settled.push(ok),
    });

    await coordinator.start();
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "error", error: "npm ci failed" });
    expect(settled).toEqual([false]);

    await coordinator.start();
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done" });
    expect(installs).toBe(2);
    expect(settled).toEqual([false, true]);
  });

  test("a throwing install settles as error instead of leaving running forever", async () => {
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: async () => {
        throw new Error("unexpected crash");
      },
    });
    await coordinator.start();
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "error", error: "unexpected crash" });
  });
});

describe("callFlowInstallOriginAllowed", () => {
  test("permits same-origin and missing Origin, rejects everything else", () => {
    expect(callFlowInstallOriginAllowed(null, "127.0.0.1:4321")).toBe(true);
    expect(callFlowInstallOriginAllowed(undefined, "127.0.0.1:4321")).toBe(true);
    expect(callFlowInstallOriginAllowed("http://127.0.0.1:4321", "127.0.0.1:4321")).toBe(true);
    expect(callFlowInstallOriginAllowed("http://localhost:4321", "localhost:4321")).toBe(true);
    expect(callFlowInstallOriginAllowed("https://evil.example", "127.0.0.1:4321")).toBe(false);
    expect(callFlowInstallOriginAllowed("http://127.0.0.1:9999", "127.0.0.1:4321")).toBe(false);
    expect(callFlowInstallOriginAllowed("null", "127.0.0.1:4321")).toBe(false);
    expect(callFlowInstallOriginAllowed("not a url", "127.0.0.1:4321")).toBe(false);
  });
});

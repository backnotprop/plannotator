import { describe, expect, test } from "bun:test";
import { CallFlowInstallCoordinator, callFlowInstallOriginAllowed } from "./call-flow-install";
import type { CallFlowInstallStage, CallFlowRuntimeInstallResult } from "./call-flow";
import type { CallFlowLanguageId } from "./call-flow-languages";

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
  languageId: "python",
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
      coordinator.start(["python"]),
      coordinator.start(["python"]),
      coordinator.start(["python"]),
    ]);
    expect(first).toEqual({ state: "running", stage: "downloading", languageIds: ["python"] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(installs).toBe(1);

    // Still running: a later POST joins rather than restarting.
    expect(await coordinator.start(["python"])).toEqual({ state: "running", stage: "downloading", languageIds: ["python"] });
    expect(installs).toBe(1);

    gate.resolve(installed);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["python"] });
    expect(installs).toBe(1);
  });

  test("stage callbacks advance the running status in order", async () => {
    let emit: ((stage: CallFlowInstallStage) => void) | undefined;
    const gate = deferred<CallFlowRuntimeInstallResult>();
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: (_id, onStage) => {
        emit = onStage;
        return gate.promise;
      },
    });

    await coordinator.start(["python"]);
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "downloading", languageIds: ["python"] });
    emit?.("verifying");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "verifying", languageIds: ["python"], currentLanguageId: "python" });
    emit?.("installing-deps");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "installing-deps", languageIds: ["python"], currentLanguageId: "python" });
    emit?.("building");
    expect(coordinator.getStatus()).toEqual({ state: "running", stage: "building", languageIds: ["python"], currentLanguageId: "python" });

    gate.resolve(installed);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["python"] });
    // A late stage callback can never resurrect a settled status.
    emit?.("downloading");
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["python"] });
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

    const status = await coordinator.start(["python"]);
    expect(status).toEqual({ state: "error", error: "Node.js was not found.", reason: "node-unavailable", languageIds: ["python"] });
    expect(installs).toBe(0);
    // The error persists until the next start retries.
    expect(coordinator.getStatus()).toEqual(status);
  });

  test("a failed preflight cannot leak an old review's languages into a later retry", async () => {
    let preflights = 0;
    const installedIds: CallFlowLanguageId[] = [];
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ++preflights === 1
        ? { ok: false, reason: "node-unavailable", message: "Node.js was not found." }
        : { ok: true },
      install: async (id) => {
        installedIds.push(id);
        return { ...installed, languageId: id };
      },
    });

    await coordinator.start(["python"]);
    await coordinator.start(["go"]);
    await Bun.sleep(0);

    expect(installedIds).toEqual(["go"]);
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["go"] });
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

    await coordinator.start(["python"]);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "error", error: "npm ci failed", languageIds: ["python"], currentLanguageId: "python" });
    expect(settled).toEqual([false]);

    await coordinator.start(["python"]);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["python"] });
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
    await coordinator.start(["python"]);
    await Bun.sleep(0);
    expect(coordinator.getStatus()).toEqual({ state: "error", error: "unexpected crash", languageIds: ["python"], currentLanguageId: "python" });
  });

  test("queues a second language onto the active single flight", async () => {
    const calls: string[] = [];
    const first = deferred<CallFlowRuntimeInstallResult>();
    const coordinator = new CallFlowInstallCoordinator({
      preflight: async () => ({ ok: true }),
      install: async (id) => {
        calls.push(id);
        if (id === "python") return first.promise;
        return { ...installed, languageId: id };
      },
    });

    await coordinator.start(["python"]);
    await coordinator.start(["go"]);
    expect(coordinator.getStatus()).toMatchObject({ state: "running", languageIds: ["python", "go"] });
    first.resolve(installed);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls).toEqual(["python", "go"]);
    expect(coordinator.getStatus()).toEqual({ state: "done", languageIds: ["python", "go"] });
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withCallFlowInstallLock } from "./call-flow-install-lock";

let testDir: string | undefined;

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

function lockPath(): string {
  testDir ??= mkdtempSync(join(tmpdir(), "plannotator-call-flow-lock-"));
  return join(testDir, "runtime", ".install.lock");
}

describe("withCallFlowInstallLock", () => {
  test("serializes concurrent installers that share a runtime store", async () => {
    const path = lockPath();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered: (() => void) | undefined;
    const firstDidEnter = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = withCallFlowInstallLock(async () => {
      order.push("first-enter");
      firstEntered?.();
      await firstCanFinish;
      order.push("first-exit");
    }, { lockPath: path, pollIntervalMs: 1, waitTimeoutMs: 1_000 });
    await firstDidEnter;
    const second = withCallFlowInstallLock(async () => {
      order.push("second-enter");
    }, { lockPath: path, pollIntervalMs: 1, waitTimeoutMs: 1_000 });

    await Bun.sleep(10);
    expect(order).toEqual(["first-enter"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  test("recovers a stale lease left by a crashed server", async () => {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "dead-process", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);

    let ran = false;
    await withCallFlowInstallLock(async () => { ran = true; }, {
      lockPath: path,
      staleAfterMs: 1_000,
      waitTimeoutMs: 100,
      pollIntervalMs: 1,
    });
    expect(ran).toBe(true);
  });

  test("does not break a fresh lease", async () => {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "live-process", "utf8");

    await expect(withCallFlowInstallLock(async () => {}, {
      lockPath: path,
      staleAfterMs: 60_000,
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
    })).rejects.toThrow("Timed out waiting for another Call flow runtime install");
  });
});

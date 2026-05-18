import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireDaemonLock,
  createDaemonState,
  getDaemonPaths,
  readDaemonState,
  removeDaemonFiles,
  removeDaemonState,
  writeDaemonState,
} from "./state";

let dirs: string[] = [];

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-daemon-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("daemon state", () => {
  test("reads missing state", () => {
    expect(readDaemonState({ baseDir: tempBase() })).toEqual({ kind: "missing" });
  });

  test("writes and reads active state", () => {
    const baseDir = tempBase();
    const state = createDaemonState({
      pid: 123,
      port: 19432,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    writeDaemonState(state, { baseDir });

    expect(readDaemonState({ baseDir, isAlive: (pid) => pid === 123 })).toEqual({
      kind: "active",
      path: getDaemonPaths({ baseDir }).statePath,
      state,
    });
  });

  test("uses localhost URLs for local daemon sessions", () => {
    const state = createDaemonState({
      pid: 123,
      port: 19432,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
    });

    expect(state.baseUrl).toBe("http://localhost:19432");
  });

  test("classifies dead daemon state as stale", () => {
    const baseDir = tempBase();
    const state = createDaemonState({
      pid: 123,
      port: 19432,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
    });
    writeDaemonState(state, { baseDir });

    const result = readDaemonState({ baseDir, isAlive: () => false });
    expect(result.kind).toBe("stale");
  });

  test("classifies malformed JSON", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeFileSync(paths.statePath, "{ nope", "utf-8");
    const result = readDaemonState({ baseDir });
    expect(result.kind).toBe("malformed");
  });

  test("classifies incompatible protocol state", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeFileSync(paths.statePath, JSON.stringify({ protocol: "old" }), "utf-8");
    const result = readDaemonState({ baseDir });
    expect(result.kind).toBe("incompatible");
  });

  test("removes state", () => {
    const baseDir = tempBase();
    writeDaemonState(createDaemonState({
      pid: 123,
      port: 19432,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
    }), { baseDir });
    removeDaemonState({ baseDir });
    expect(readDaemonState({ baseDir })).toEqual({ kind: "missing" });
  });

  test("removes state and lock files together", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(createDaemonState({
      pid: 123,
      port: 19432,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
    }), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");
    removeDaemonFiles({ baseDir });
    expect(readDaemonState({ baseDir })).toEqual({ kind: "missing" });
    expect(acquireDaemonLock({ baseDir }).ok).toBe(true);
  });
});

describe("daemon lock", () => {
  test("acquires and releases lock", () => {
    const baseDir = tempBase();
    const result = acquireDaemonLock({ baseDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.path).toBe(getDaemonPaths({ baseDir }).lockPath);
    result.lock.release();
    expect(acquireDaemonLock({ baseDir }).ok).toBe(true);
  });

  test("release does not remove a replacement lock", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    const result = acquireDaemonLock({ baseDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    writeFileSync(paths.lockPath, "999\n", "utf-8");
    result.lock.release();

    const next = acquireDaemonLock({ baseDir, isAlive: (pid) => pid === 999 });
    expect(next.ok).toBe(false);
    if (next.ok) return;
    expect(next.code).toBe("locked");
    expect(next.pid).toBe(999);
  });

  test("rejects live lock", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeFileSync(paths.lockPath, "999\n", "utf-8");
    const result = acquireDaemonLock({ baseDir, isAlive: (pid) => pid === 999 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("locked");
    expect(result.pid).toBe(999);
  });

  test("clears stale lock", () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeFileSync(paths.lockPath, "999\n", "utf-8");
    const result = acquireDaemonLock({ baseDir, isAlive: () => false });
    expect(result.ok).toBe(true);
  });
});

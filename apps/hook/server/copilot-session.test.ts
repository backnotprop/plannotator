/**
 * Copilot Session Lock Detection Tests
 *
 * Run: bun test apps/hook/server/copilot-session.test.ts
 *
 * Uses temp dirs mirroring the real ~/.copilot/session-state/<uuid>/
 * layout with synthetic inuse.<pid>.lock files.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchCopilotSessionLockToPids,
  findCopilotSessionByAncestorPids,
} from "./copilot-session";

// --- Fixture Helpers ---

let tempDirs: string[] = [];

function makeSessionStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function addSession(
  sessionStateDir: string,
  name: string,
  files: string[] = [],
): string {
  const dir = join(sessionStateDir, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Tests ---

describe("matchCopilotSessionLockToPids", () => {
  test("matches a pid in the chain against its session lock", () => {
    const stateDir = makeSessionStateDir();
    const session = addSession(stateDir, "aaaa-1111", [
      "inuse.4242.lock",
      "events.jsonl",
      "workspace.yaml",
    ]);

    const result = matchCopilotSessionLockToPids(stateDir, [100, 4242]);
    expect(result).toEqual({ sessionDir: session, pid: 4242 });
  });

  test("returns null when no pid owns a lock", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.5555.lock"]);

    expect(matchCopilotSessionLockToPids(stateDir, [100, 200])).toBeNull();
  });

  test("returns null for an empty pid list", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.100.lock"]);

    expect(matchCopilotSessionLockToPids(stateDir, [])).toBeNull();
  });

  test("returns null when the session-state dir does not exist", () => {
    const stateDir = makeSessionStateDir();
    const missing = join(stateDir, "no-such-dir");

    expect(matchCopilotSessionLockToPids(missing, [100])).toBeNull();
  });

  test("picks the correct session among several active ones", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.100.lock"]);
    const wanted = addSession(stateDir, "bbbb-2222", ["inuse.200.lock"]);
    addSession(stateDir, "cccc-3333", ["inuse.300.lock"]);

    const result = matchCopilotSessionLockToPids(stateDir, [200]);
    expect(result).toEqual({ sessionDir: wanted, pid: 200 });
  });

  test("pid order decides when several chain pids hold locks", () => {
    const stateDir = makeSessionStateDir();
    const first = addSession(stateDir, "aaaa-1111", ["inuse.100.lock"]);
    const second = addSession(stateDir, "bbbb-2222", ["inuse.300.lock"]);

    expect(matchCopilotSessionLockToPids(stateDir, [100, 200, 300])).toEqual({
      sessionDir: first,
      pid: 100,
    });
    expect(matchCopilotSessionLockToPids(stateDir, [300, 200, 100])).toEqual({
      sessionDir: second,
      pid: 300,
    });
  });

  test("ignores malformed lock names and unrelated files", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", [
      "inuse.lock",
      "inuse.abc.lock",
      "inuse.12x34.lock",
      "notinuse.100.lock",
      "events.jsonl",
    ]);
    expect(matchCopilotSessionLockToPids(stateDir, [100])).toBeNull();

    const valid = addSession(stateDir, "bbbb-2222", ["inuse.100.lock"]);
    expect(matchCopilotSessionLockToPids(stateDir, [100])).toEqual({
      sessionDir: valid,
      pid: 100,
    });
  });
});

describe("findCopilotSessionByAncestorPids", () => {
  test("resolves the session locked by a copilot ancestor", () => {
    const stateDir = makeSessionStateDir();
    const session = addSession(stateDir, "aaaa-1111", ["inuse.300.lock"]);
    const parents: Record<number, number> = { 100: 200, 200: 300 };
    const names: Record<number, string> = { 300: "/usr/local/bin/copilot" };

    const result = findCopilotSessionByAncestorPids({
      startPid: 100,
      sessionStateDir: stateDir,
      getParentPid: (p) => parents[p] ?? null,
      getProcessName: (p) => names[p] ?? null,
    });
    expect(result).toBe(session);
  });

  test("returns null when no ancestor holds a lock", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.9999.lock"]);
    const parents: Record<number, number> = { 100: 200 };

    const result = findCopilotSessionByAncestorPids({
      startPid: 100,
      sessionStateDir: stateDir,
      getParentPid: (p) => parents[p] ?? null,
      getProcessName: () => "copilot",
    });
    expect(result).toBeNull();
  });

  test("rejects a lock whose owner is not a copilot process", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.300.lock"]);
    const parents: Record<number, number> = { 100: 200, 200: 300 };

    const result = findCopilotSessionByAncestorPids({
      startPid: 100,
      sessionStateDir: stateDir,
      getParentPid: (p) => parents[p] ?? null,
      getProcessName: () => "node",
    });
    expect(result).toBeNull();
  });

  test("rejects every match when the process name lookup fails", () => {
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.100.lock"]);

    const result = findCopilotSessionByAncestorPids({
      startPid: 100,
      sessionStateDir: stateDir,
      getParentPid: () => null,
      getProcessName: () => null,
    });
    expect(result).toBeNull();
  });

  test("skips a stale lock and keeps walking the chain", () => {
    // Pid 100 was reused after its copilot session died; its stale lock
    // must not shadow the live session locked by pid 300.
    const stateDir = makeSessionStateDir();
    addSession(stateDir, "aaaa-1111", ["inuse.100.lock"]);
    const live = addSession(stateDir, "bbbb-2222", ["inuse.300.lock"]);
    const parents: Record<number, number> = { 100: 200, 200: 300 };
    const names: Record<number, string> = { 100: "bash", 300: "copilot" };

    const result = findCopilotSessionByAncestorPids({
      startPid: 100,
      sessionStateDir: stateDir,
      getParentPid: (p) => parents[p] ?? null,
      getProcessName: (p) => names[p] ?? null,
    });
    expect(result).toBe(live);
  });

  test("respects COPILOT_HOME for the default session-state dir", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-copilot-home-"));
    tempDirs.push(home);
    const stateDir = join(home, "session-state");
    mkdirSync(stateDir, { recursive: true });
    const session = addSession(stateDir, "aaaa-1111", ["inuse.300.lock"]);
    const parents: Record<number, number> = { 100: 200, 200: 300 };

    const prev = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    try {
      const result = findCopilotSessionByAncestorPids({
        startPid: 100,
        getParentPid: (p) => parents[p] ?? null,
        getProcessName: () => "copilot",
      });
      expect(result).toBe(session);
    } finally {
      if (prev === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prev;
    }
  });
});

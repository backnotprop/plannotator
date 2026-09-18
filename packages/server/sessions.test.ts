import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessions,
  registerSession,
  sessionKey,
  unregisterSession,
  type SessionInfo,
} from "./sessions";

let tempDir: string;
let savedDataDir: string | undefined;

function baseInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    pid: process.pid,
    port: 19432,
    url: "http://127.0.0.1:19432",
    mode: "plan",
    project: "demo",
    startedAt: new Date().toISOString(),
    label: "plan-demo",
    ...overrides,
  };
}

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "plannotator-sessions-test-"));
  process.env.PLANNOTATOR_DATA_DIR = tempDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session registry", () => {
  test("sessionKey prefers an explicit id over the pid", () => {
    expect(sessionKey({ pid: 42 })).toBe("42");
    expect(sessionKey({ id: "42-19432", pid: 42 })).toBe("42-19432");
  });

  test("registers a pid-keyed session when no id is given", () => {
    registerSession(baseInfo());
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].port).toBe(19432);
  });

  test("keeps concurrent sessions from one process separate", () => {
    registerSession(baseInfo({ id: `${process.pid}-19432`, port: 19432, label: "plan-a" }));
    registerSession(baseInfo({ id: `${process.pid}-19433`, port: 19433, label: "plan-b" }));

    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.port).sort()).toEqual([19432, 19433]);
  });

  test("unregisterSession removes only the matching key", () => {
    registerSession(baseInfo({ id: `${process.pid}-19432`, port: 19432 }));
    registerSession(baseInfo({ id: `${process.pid}-19433`, port: 19433 }));

    unregisterSession(`${process.pid}-19432`);

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].port).toBe(19433);
  });

  test("unregisterSession defaults to the pid key", () => {
    registerSession(baseInfo());
    unregisterSession();
    expect(listSessions()).toHaveLength(0);
  });

  test("listSessions drops entries whose process is gone", () => {
    registerSession(baseInfo({ id: "dead", pid: 2147483646 }));
    expect(listSessions()).toHaveLength(0);
  });
});

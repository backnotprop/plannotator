import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorSecretMatches, pickDoorRoute, readDoorSession, removeDoorSession, writeDoorSession } from "./cf-access-door";

const SESSIONS = "inbox-s.example.test";
const A = "aaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbb";
const live = (key: string) => key === A || key === B;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which live session a request through the door belongs to", () => {
  test("the path prefix names it, and is stripped", () => {
    expect(pickDoorRoute("sessions", `/s/${A}/api/diff`, null, SESSIONS, live)).toEqual({ kind: "session", key: A, path: "/api/diff", via: "prefix" });
    expect(pickDoorRoute("sessions", `/s/${B}`, null, SESSIONS, live)).toEqual({ kind: "session", key: B, path: "/", via: "prefix" });
  });

  test("a same-origin Referer from a session page is the fallback", () => {
    expect(pickDoorRoute("sessions", "/api/diff", `https://${SESSIONS}/s/${B}/`, SESSIONS, live)).toEqual({ kind: "session", key: B, path: "/api/diff", via: "referer" });
    expect(pickDoorRoute("sessions", "/api/diff", `https://evil.example.test/s/${B}/`, SESSIONS, live)).toEqual({ kind: "ended" });
  });

  test("with two sessions open, a request with neither prefix nor Referer reaches neither, and never the Inbox", () => {
    expect(pickDoorRoute("sessions", "/api/diff", null, SESSIONS, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("sessions", "/api/plan", null, SESSIONS, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("sessions", "/api/inbox/threads", null, SESSIONS, live)).toEqual({ kind: "wrong_origin" });
    expect(pickDoorRoute("sessions", "/", null, SESSIONS, live)).toEqual({ kind: "wrong_origin" });
  });

  test("the Inbox's name never reaches a session, and a navigation ignores the Referer", () => {
    expect(pickDoorRoute("inbox", `/s/${A}/api/diff`, null, SESSIONS, live)).toEqual({ kind: "wrong_origin" });
    expect(pickDoorRoute("inbox", "/api/diff", `https://${SESSIONS}/s/${A}/`, SESSIONS, live)).toEqual({ kind: "inbox" });
    expect(pickDoorRoute("sessions", "/other", `https://${SESSIONS}/s/${A}/`, SESSIONS, live, true)).toEqual({ kind: "ended" });
  });

  test("an ended session's key never falls through to another session or the Inbox", () => {
    const gone = "cccccccccccccccccccccc";
    expect(pickDoorRoute("sessions", `/s/${gone}/`, null, SESSIONS, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("sessions", "/api/diff", `https://${SESSIONS}/s/${gone}/`, SESSIONS, live)).toEqual({ kind: "ended" });
  });
});

describe("session registrations", () => {
  test("written owner-only, read back only while the process lives, pruned after", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-door-"));
    dirs.push(dataDir);
    writeDoorSession(dataDir, { key: A, port: 45678, pid: 4242, secret: "s".repeat(32) });
    const file = join(dataDir, "cloudflare-access", "sessions", `${A}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDoorSession(dataDir, A, () => true)?.port).toBe(45678);
    expect(readDoorSession(dataDir, "../../etc", () => true)).toBeNull();
    expect(readDoorSession(dataDir, A, () => false)).toBeNull();
    expect(readDoorSession(dataDir, A, () => true)).toBeNull();
    writeDoorSession(dataDir, { key: B, port: 45679, pid: 1, secret: "s".repeat(32) });
    removeDoorSession(dataDir, B);
    expect(readDoorSession(dataDir, B, () => true)).toBeNull();
  });

  test("the door secret compares whole and exact", () => {
    expect(doorSecretMatches("secret-value-123", "secret-value-123")).toBe(true);
    expect(doorSecretMatches("secret-value-123", "secret-value-124")).toBe(false);
    expect(doorSecretMatches("secret-value-123", "secret-value-12")).toBe(false);
    expect(doorSecretMatches("secret-value-123", null)).toBe(false);
  });
});

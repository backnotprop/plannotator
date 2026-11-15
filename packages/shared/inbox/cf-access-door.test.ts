import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorSecretMatches, pickDoorRoute, readDoorSession, removeDoorSession, writeDoorSession } from "./cf-access-door";

const HOST = "inbox.example.test";
const A = "aaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbb";
const live = (key: string) => key === A || key === B;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which live session a request through the door belongs to", () => {
  test("the path prefix names it, and is stripped", () => {
    expect(pickDoorRoute(`/s/${A}/api/diff`, null, HOST, live)).toEqual({ kind: "session", key: A, path: "/api/diff", via: "prefix" });
    expect(pickDoorRoute(`/s/${B}`, null, HOST, live)).toEqual({ kind: "session", key: B, path: "/", via: "prefix" });
  });

  test("a same-origin Referer from a session page is the fallback", () => {
    expect(pickDoorRoute("/api/diff", `https://${HOST}/s/${B}/`, HOST, live)).toEqual({ kind: "session", key: B, path: "/api/diff", via: "referer" });
    expect(pickDoorRoute("/api/diff", `https://evil.example.test/s/${B}/`, HOST, live)).toEqual({ kind: "ended" });
  });

  test("with two sessions open, a request with neither prefix nor Referer reaches the Inbox only on an Inbox route", () => {
    expect(pickDoorRoute("/api/diff", null, HOST, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("/api/plan", null, HOST, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("/api/inbox/threads", null, HOST, live)).toEqual({ kind: "inbox" });
    expect(pickDoorRoute("/", null, HOST, live)).toEqual({ kind: "inbox" });
  });

  test("an ended session's key never falls through to another session or the Inbox", () => {
    const gone = "cccccccccccccccccccccc";
    expect(pickDoorRoute(`/s/${gone}/`, null, HOST, live)).toEqual({ kind: "ended" });
    expect(pickDoorRoute("/api/inbox/threads", `https://${HOST}/s/${gone}/`, HOST, live)).toEqual({ kind: "ended" });
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

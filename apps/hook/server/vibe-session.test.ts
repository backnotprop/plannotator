/**
 * Vibe Session Discovery Tests
 *
 * Run: bun test apps/hook/server/vibe-session.test.ts
 *
 * Uses synthetic fixtures matching Vibe's $VIBE_HOME/logs/session layout:
 *   session_<ts>_<id>/messages.jsonl
 *   .session_index.json  — { "<dirName>": { session_id, cwd, mtime_ns } }
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveVibeSessionLogForCwd,
  getRecentVibeMessages,
  getLastVibeRenderedMessage,
} from "./session-log";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeVibeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "vibe-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, "logs", "session"), { recursive: true });
  return home;
}

function writeSession(
  home: string,
  dirName: string,
  messages: string,
  mtimeSec?: number,
): string {
  const sessionDir = join(home, "logs", "session", dirName);
  mkdirSync(sessionDir, { recursive: true });
  const messagesPath = join(sessionDir, "messages.jsonl");
  writeFileSync(messagesPath, messages);
  if (mtimeSec !== undefined) utimesSync(messagesPath, mtimeSec, mtimeSec);
  return messagesPath;
}

function vibeLine(
  role: string,
  content: string,
  messageId: string,
): string {
  return JSON.stringify({ role, content, message_id: messageId, injected: false });
}

describe("resolveVibeSessionLogForCwd", () => {
  test("picks the newest session whose cwd matches via the index", () => {
    const home = makeVibeHome();
    const cwd = "/Users/test/project";
    writeSession(home, "session_1_old", vibeLine("assistant", "old", "m1"), 1);
    writeSession(home, "session_2_new", vibeLine("assistant", "new", "m2"), 100);

    writeFileSync(
      join(home, "logs", "session", ".session_index.json"),
      JSON.stringify({
        "session_1_old": { session_id: "s1", cwd, mtime_ns: 1_000_000 },
        "session_2_new": { session_id: "s2", cwd, mtime_ns: 100_000_000 },
      }),
    );

    const log = resolveVibeSessionLogForCwd(cwd, { vibeHome: home });
    expect(log).toBeTruthy();
    expect(log!.endsWith("session_2_new/messages.jsonl")).toBe(true);
  });

  test("skips sessions whose cwd differs", () => {
    const home = makeVibeHome();
    writeSession(home, "session_a", vibeLine("assistant", "x", "m1"), 100);
    writeFileSync(
      join(home, "logs", "session", ".session_index.json"),
      JSON.stringify({
        "session_a": { session_id: "a", cwd: "/elsewhere", mtime_ns: 100_000_000 },
      }),
    );
    expect(resolveVibeSessionLogForCwd("/Users/test/project", { vibeHome: home })).toBeNull();
  });

  test("falls back to directory scan when the index is absent", () => {
    const home = makeVibeHome();
    const cwd = "/Users/test/project";
    writeSession(home, "session_old", vibeLine("assistant", "old", "m1"), 1);
    writeSession(home, "session_new", vibeLine("assistant", "new", "m2"), 100);
    // No .session_index.json — should pick the newest by file mtime.
    const log = resolveVibeSessionLogForCwd(cwd, { vibeHome: home });
    expect(log).toBeTruthy();
    expect(log!.endsWith("session_new/messages.jsonl")).toBe(true);
  });

  test("returns null when no sessions exist", () => {
    const home = makeVibeHome();
    expect(resolveVibeSessionLogForCwd("/Users/test/project", { vibeHome: home })).toBeNull();
  });
});

describe("getRecentVibeMessages", () => {
  test("extracts the last assistant message with text content", () => {
    const home = makeVibeHome();
    const messagesPath = writeSession(
      home,
      "session_1",
      [
        vibeLine("user", "hello", "u1"),
        vibeLine("assistant", "first reply", "a1"),
        vibeLine("assistant", "second reply", "a2"),
      ].join("\n"),
    );
    const last = getLastVibeRenderedMessage(messagesPath);
    expect(last).not.toBeNull();
    expect(last!.text).toBe("second reply");
    expect(last!.messageId).toBe("a2");
  });

  test("skips reasoning-only and tool-call-only assistant turns", () => {
    const home = makeVibeHome();
    const messagesPath = writeSession(
      home,
      "session_1",
      [
        vibeLine("assistant", "real reply", "a1"),
        JSON.stringify({
          role: "assistant",
          content: "",
          reasoning_content: "thinking...",
          message_id: "a2",
          tool_calls: [{ id: "t1", function: { name: "bash", arguments: "{}" } }],
        }),
      ].join("\n"),
    );
    const last = getLastVibeRenderedMessage(messagesPath);
    expect(last).not.toBeNull();
    expect(last!.text).toBe("real reply");
  });

  test("returns empty list when no assistant text exists", () => {
    const home = makeVibeHome();
    const messagesPath = writeSession(home, "session_1", vibeLine("user", "hi", "u1"));
    expect(getRecentVibeMessages(messagesPath, 5)).toEqual([]);
  });

  test("concatenates chunks sharing a message id", () => {
    const home = makeVibeHome();
    const messagesPath = writeSession(
      home,
      "session_1",
      [
        vibeLine("assistant", "part one", "a1"),
        vibeLine("assistant", "part two", "a1"),
      ].join("\n"),
    );
    const msgs = getRecentVibeMessages(messagesPath, 5);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("part one\npart two");
  });

  test("respects the limit, keeping the newest messages", () => {
    const home = makeVibeHome();
    const messagesPath = writeSession(
      home,
      "session_1",
      [
        vibeLine("assistant", "oldest", "a1"),
        vibeLine("assistant", "middle", "a2"),
        vibeLine("assistant", "newest", "a3"),
      ].join("\n"),
    );
    const msgs = getRecentVibeMessages(messagesPath, 2);
    expect(msgs).toHaveLength(2);
    // newest-first
    expect(msgs[0].text).toBe("newest");
    expect(msgs[1].text).toBe("middle");
  });
});

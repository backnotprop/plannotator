/**
 * Qwen Code session log tests (`plannotator last` under Qwen Code).
 *
 * Ported from the NonoElRobot fork (commit c6a02a0), with credit, plus the
 * active-branch cases. Synthetic fixtures in temp folders follow Qwen's layout
 * `<projects>/<sanitized cwd>/chats/<session id>.jsonl`; nothing reads the
 * real ~/.qwen.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QWEN_ASK_AI_SESSION_PREFIX } from "../../../packages/ai/providers/qwen-events.ts";
import {
  QWEN_ASK_AI_CHAT_PREFIX,
  findQwenSessionLog,
  getQwenProjectsDir,
  getRecentQwenMessages,
  sanitizeQwenCwd,
} from "./qwen-session";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProjectsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "qwen-projects-"));
  tempDirs.push(root);
  return root;
}

function writeChatLog(projectsDir: string, slug: string, name: string, content: string): string {
  const chatsDir = join(projectsDir, slug, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const path = join(chatsDir, name);
  writeFileSync(path, content);
  return path;
}

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: "sess-1", timestamp: "2026-10-07T21:26:34.260Z", ...fields });
}

function assistantLine(uuid: string, parts: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return record({ uuid, type: "assistant", message: { role: "model", parts }, ...extra });
}

function userLine(uuid: string, text: string, extra: Record<string, unknown> = {}): string {
  return record({ uuid, type: "user", message: { role: "user", parts: [{ text }] }, ...extra });
}

describe("sanitizeQwenCwd", () => {
  test("Windows: lowercases and replaces every non-alphanumeric character", () => {
    expect(sanitizeQwenCwd("C:\\Users\\Nono\\Project", "win32")).toBe("c--users-nono-project");
  });

  test("POSIX: replaces characters but keeps case", () => {
    expect(sanitizeQwenCwd("/Users/NONO/proj", "linux")).toBe("-Users-NONO-proj");
  });
});

describe("getQwenProjectsDir", () => {
  test("QWEN_RUNTIME_DIR wins over QWEN_HOME", () => {
    expect(getQwenProjectsDir({ env: { QWEN_RUNTIME_DIR: "/rt", QWEN_HOME: "/home-q" } })).toBe(join("/rt", "projects"));
  });

  test("QWEN_HOME is the Qwen folder itself, not its parent", () => {
    expect(getQwenProjectsDir({ env: { QWEN_HOME: "/home-q" } })).toBe(join("/home-q", "projects"));
  });

  test("defaults to ~/.qwen/projects", () => {
    // A made-up home: the test never names the real one.
    const home = join(tmpdir(), "qwen-session-home");
    expect(getQwenProjectsDir({ env: {}, home })).toBe(join(home, ".qwen", "projects"));
  });

  test("a leading ~ in QWEN_HOME is the home folder", () => {
    const home = join(tmpdir(), "qwen-session-home");
    expect(getQwenProjectsDir({ env: { QWEN_HOME: "~/qwen" }, home })).toBe(join(home, "qwen", "projects"));
  });
});

describe("findQwenSessionLog", () => {
  test("the session variables name the log directly", () => {
    const projectsDir = makeProjectsDir();
    const slug = "-work-project";
    const other = writeChatLog(projectsDir, slug, "newer.jsonl", assistantLine("x", [{ text: "x" }]));
    const log = writeChatLog(projectsDir, slug, "abc-123.jsonl", assistantLine("u1", [{ text: "hi" }]));
    utimesSync(log, 100, 100);
    utimesSync(other, 200, 200);
    const found = findQwenSessionLog({
      env: { QWEN_CODE_PROJECT_DIR: join(projectsDir, slug), QWEN_CODE_SESSION_ID: "abc-123" },
      cwd: "/elsewhere",
      projectsDir,
    });
    expect(found).toBe(log);
  });

  test("a missing named log falls back to the newest chat of the cwd's project", () => {
    const projectsDir = makeProjectsDir();
    const slug = sanitizeQwenCwd("/work/project");
    const old = writeChatLog(projectsDir, slug, "old.jsonl", assistantLine("u1", [{ text: "old" }]));
    utimesSync(old, 100, 100);
    const fresh = writeChatLog(projectsDir, slug, "fresh.jsonl", assistantLine("u2", [{ text: "new" }]));
    utimesSync(fresh, 200, 200);
    const found = findQwenSessionLog({
      env: { QWEN_CODE_PROJECT_DIR: join(projectsDir, slug), QWEN_CODE_SESSION_ID: "does-not-exist" },
      cwd: "/work/project",
      projectsDir,
    });
    expect(found).toBe(fresh);
  });

  test("a path-shaped session id never leaves the chats folder", () => {
    const projectsDir = makeProjectsDir();
    const slug = sanitizeQwenCwd("/work/project");
    const a = writeChatLog(projectsDir, slug, "a.jsonl", assistantLine("u1", [{ text: "a" }]));
    // A log the escaping id would name, outside the chats folder.
    writeFileSync(join(projectsDir, slug, "evil.jsonl"), assistantLine("e", [{ text: "evil" }]));
    const found = findQwenSessionLog({
      env: { QWEN_CODE_PROJECT_DIR: join(projectsDir, slug), QWEN_CODE_SESSION_ID: "../evil" },
      cwd: "/work/project",
      projectsDir,
    });
    expect(found).toBe(a);
  });

  test("the fallback skips Ask AI chats, even when one is newer", () => {
    const projectsDir = makeProjectsDir();
    const slug = sanitizeQwenCwd("/work/project");
    const own = writeChatLog(projectsDir, slug, "1f0e2d3c-0000-4000-8000-000000000001.jsonl", assistantLine("u1", [{ text: "mine" }]));
    utimesSync(own, 100, 100);
    const ask = writeChatLog(projectsDir, slug, `${QWEN_ASK_AI_SESSION_PREFIX}-0000-4000-8000-000000000002.jsonl`, assistantLine("u2", [{ text: "ask" }]));
    utimesSync(ask, 200, 200);
    expect(findQwenSessionLog({ env: {}, cwd: "/work/project", projectsDir })).toBe(own);
    // The hook's copy of the prefix is the one the Ask AI provider uses.
    expect(QWEN_ASK_AI_CHAT_PREFIX).toBe(QWEN_ASK_AI_SESSION_PREFIX);
  });

  test("returns null when the project has no chat", () => {
    const projectsDir = makeProjectsDir();
    expect(findQwenSessionLog({ env: {}, cwd: "/nowhere", projectsDir })).toBeNull();
  });
});

describe("getRecentQwenMessages", () => {
  function writeLog(...lines: string[]): string {
    return writeChatLog(makeProjectsDir(), "p", "s.jsonl", lines.join("\n") + "\n");
  }

  test("assistant text newest first, skipping thoughts, tool-call-only turns and noise", () => {
    const log = writeLog(
      userLine("u0", "prompt", { parentUuid: null }),
      assistantLine("a1", [
        { text: "thinking...", thought: true },
        { text: "First answer." },
        { functionCall: { id: "c1", name: "run_shell_command", args: {} } },
      ], { parentUuid: "u0", timestamp: "2026-10-07T21:00:00.000Z" }),
      "not json {",
      record({ uuid: "s1", parentUuid: "a1", type: "system", subtype: "ui_telemetry", systemPayload: {} }),
      assistantLine("a2", [{ functionCall: { id: "c2", name: "run_shell_command", args: {} } }], { parentUuid: "s1" }),
      assistantLine("a3", [{ text: "Still thinking", thought: true }], { parentUuid: "a2" }),
      assistantLine("a4", [{ text: "Last answer." }], { parentUuid: "a3", timestamp: "2026-10-07T21:10:00.000Z" }),
    );
    const recent = getRecentQwenMessages(log, 25);
    expect(recent.map((m) => m.messageId)).toEqual(["a4", "a1"]);
    expect(recent[0].text).toBe("Last answer.");
    expect(recent[0].timestamp).toBe("2026-10-07T21:10:00.000Z");
    expect(recent[1].text).toBe("First answer.");
  });

  test("after /rewind, a reply on the abandoned branch is never offered", () => {
    // u1 -> a1 -> u2 -> a2 (rewound away); the rewind record re-roots at a1,
    // then u3 -> a3 continue the active branch.
    const log = writeLog(
      userLine("u1", "first", { parentUuid: null }),
      assistantLine("a1", [{ text: "Kept answer." }], { parentUuid: "u1" }),
      userLine("u2", "second", { parentUuid: "a1" }),
      assistantLine("a2", [{ text: "Rewound answer." }], { parentUuid: "u2" }),
      record({ uuid: "r1", parentUuid: "a1", type: "system", subtype: "rewind" }),
      userLine("u3", "third", { parentUuid: "r1" }),
      assistantLine("a3", [{ text: "New answer." }], { parentUuid: "u3" }),
    );
    expect(getRecentQwenMessages(log, 25).map((m) => m.text)).toEqual(["New answer.", "Kept answer."]);
  });

  test("right after /rewind, the newest message is the one before the rewind point", () => {
    const log = writeLog(
      userLine("u1", "first", { parentUuid: null }),
      assistantLine("a1", [{ text: "Kept answer." }], { parentUuid: "u1" }),
      userLine("u2", "second", { parentUuid: "a1" }),
      assistantLine("a2", [{ text: "Rewound answer." }], { parentUuid: "u2" }),
      record({ uuid: "r1", parentUuid: "a1", type: "system", subtype: "rewind" }),
    );
    expect(getRecentQwenMessages(log, 25).map((m) => m.text)).toEqual(["Kept answer."]);
  });

  test("records without uuids are read in file order, newest first", () => {
    const log = writeLog(
      JSON.stringify({ type: "assistant", message: { parts: [{ text: "one" }] } }),
      JSON.stringify({ type: "assistant", message: { parts: [{ text: "two" }] } }),
    );
    const recent = getRecentQwenMessages(log, 5);
    expect(recent.map((m) => m.text)).toEqual(["two", "one"]);
    expect(recent[0].messageId).toBe("qwen-line-2");
  });

  test("joins the text parts of one record", () => {
    const log = writeLog(assistantLine("a1", [{ text: "part one" }, { text: "part two" }], { parentUuid: null }));
    expect(getRecentQwenMessages(log, 1)[0].text).toBe("part one\npart two");
  });

  test("honors the limit; an empty or missing log gives nothing", () => {
    const log = writeLog(
      assistantLine("a1", [{ text: "one" }], { parentUuid: null }),
      assistantLine("a2", [{ text: "two" }], { parentUuid: "a1" }),
      assistantLine("a3", [{ text: "three" }], { parentUuid: "a2" }),
    );
    expect(getRecentQwenMessages(log, 2).map((m) => m.messageId)).toEqual(["a3", "a2"]);
    expect(getRecentQwenMessages(log, 0)).toEqual([]);
    expect(getRecentQwenMessages(writeLog(), 5)).toEqual([]);
    expect(getRecentQwenMessages(join(makeProjectsDir(), "missing.jsonl"), 5)).toEqual([]);
  });

  test("a parent cycle ends the walk instead of looping", () => {
    const log = writeLog(
      assistantLine("a1", [{ text: "one" }], { parentUuid: "a2" }),
      assistantLine("a2", [{ text: "two" }], { parentUuid: "a1" }),
    );
    expect(getRecentQwenMessages(log, 25).map((m) => m.text)).toEqual(["two", "one"]);
  });
});

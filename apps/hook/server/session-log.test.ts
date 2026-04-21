/**
 * Session Log Parser Tests
 *
 * Run: bun test apps/hook/server/session-log.test.ts
 *
 * Uses synthetic JSONL fixtures modeled after real Claude Code session logs.
 * Each test builds a minimal log and verifies the extraction logic.
 */

import { describe, expect, test } from "bun:test";
import {
  parseSessionLog,
  isHumanPrompt,
  findAnchorIndex,
  extractLastRenderedMessage,
  projectSlugFromCwd,
  findSessionLogsByAncestorWalk,
  findSessionLogsForCwd,
  getAncestorPids,
  normalizeCwdForCompare,
  parseProcessTableCsv,
  parseProcessTablePs,
  resolveSessionLogByAncestorPids,
  resolveSessionLogByCwdScan,
  type SessionLogEntry,
} from "./session-log";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

// --- Fixture Helpers ---

/** Minimal assistant entry with text content */
function assistantText(
  msgId: string,
  text: string,
  opts: { stopReason?: string | null } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: opts.stopReason ?? null,
    },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** Assistant entry with only a tool_use block (no text) */
function assistantToolUse(
  msgId: string,
  toolName: string,
  opts: { stopReason?: string } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${crypto.randomUUID().slice(0, 12)}`,
          name: toolName,
          input: {},
        },
      ],
      stop_reason: opts.stopReason ?? "tool_use",
    },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** Assistant entry with both text and tool_use */
function assistantTextAndToolUse(
  msgId: string,
  text: string,
  toolName: string
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      role: "assistant",
      content: [
        { type: "text", text },
        {
          type: "tool_use",
          id: `toolu_${crypto.randomUUID().slice(0, 12)}`,
          name: toolName,
          input: {},
        },
      ],
      stop_reason: "tool_use",
    },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** Human user prompt (string content) */
function userPrompt(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
    promptId: crypto.randomUUID(),
  });
}

/** Tool result (array content — NOT a human prompt) */
function userToolResult(toolUseId: string, output: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { tool_use_id: toolUseId, type: "tool_result", content: output },
      ],
    },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** Progress entry (sub-agent noise) */
function progress(subtype: string = "agent_progress"): string {
  return JSON.stringify({
    type: "progress",
    data: { type: subtype },
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** System entry (hook summary, etc.) */
function systemEntry(subtype: string = "stop_hook_summary"): string {
  return JSON.stringify({
    type: "system",
    subtype,
    uuid: crypto.randomUUID(),
    parentUuid: crypto.randomUUID(),
  });
}

/** File history snapshot */
function fileSnapshot(): string {
  return JSON.stringify({
    type: "file-history-snapshot",
    uuid: crypto.randomUUID(),
  });
}

/** Queue operation (background agent completed) */
function queueOp(): string {
  return JSON.stringify({
    type: "queue-operation",
    uuid: crypto.randomUUID(),
  });
}

function buildLog(...lines: string[]): string {
  return lines.join("\n");
}

// --- Tests ---

describe("projectSlugFromCwd", () => {
  test("converts Unix absolute path to slug", () => {
    expect(projectSlugFromCwd("/Users/ramos/cupcake/cupcake-rego/feat-annotate-last")).toBe(
      "-Users-ramos-cupcake-cupcake-rego-feat-annotate-last"
    );
  });

  test("handles root path", () => {
    expect(projectSlugFromCwd("/")).toBe("-");
  });

  test("converts Windows backslashes to dashes", () => {
    expect(projectSlugFromCwd("C:\\Users\\alexey\\Documents\\project")).toBe(
      "C--Users-alexey-Documents-project"
    );
  });

  test("converts non-ASCII characters (Cyrillic) to dashes", () => {
    expect(projectSlugFromCwd("C:\\Users\\alexey\\Documents\\1С_конфигурации\\ERP_Medicine")).toBe(
      "C--Users-alexey-Documents-1---------------ERP-Medicine"
    );
  });

  test("converts underscores to dashes", () => {
    expect(projectSlugFromCwd("/home/user/my_project")).toBe(
      "-home-user-my-project"
    );
  });

  test("preserves hyphens and alphanumeric characters", () => {
    expect(projectSlugFromCwd("/home/user/my-project-123")).toBe(
      "-home-user-my-project-123"
    );
  });

  test("converts spaces and special characters to dashes", () => {
    expect(projectSlugFromCwd("/home/user/my project (v2)")).toBe(
      "-home-user-my-project--v2-"
    );
  });

  test("replaces dots in path components (e.g. .worktrees)", () => {
    expect(projectSlugFromCwd("/Users/alex/project/.worktrees/my-branch")).toBe(
      "-Users-alex-project--worktrees-my-branch"
    );
  });

  test("replaces underscores in path components (e.g. feat_branch)", () => {
    expect(projectSlugFromCwd("/Users/alex/project/.worktrees/feat_aiccn-1234-desc")).toBe(
      "-Users-alex-project--worktrees-feat-aiccn-1234-desc"
    );
  });

  test("handles path with mixed special characters", () => {
    expect(projectSlugFromCwd("/Users/alex/Code/org/apa/.worktrees/feat_aiccn-2506-agent-scaffolding")).toBe(
      "-Users-alex-Code-org-apa--worktrees-feat-aiccn-2506-agent-scaffolding"
    );
  });
});

describe("isHumanPrompt", () => {
  test("identifies human prompt (string content)", () => {
    const entry = JSON.parse(userPrompt("hello"));
    expect(isHumanPrompt(entry)).toBe(true);
  });

  test("rejects tool result (array content)", () => {
    const entry = JSON.parse(userToolResult("toolu_123", "output"));
    expect(isHumanPrompt(entry)).toBe(false);
  });

  test("rejects assistant entries", () => {
    const entry = JSON.parse(assistantText("msg_1", "hello"));
    expect(isHumanPrompt(entry)).toBe(false);
  });
});

describe("findAnchorIndex", () => {
  test("finds anchor by text content", () => {
    const log = buildLog(
      userPrompt("first message"),
      assistantText("msg_1", "response 1"),
      userPrompt("second message with ANCHOR_TEXT"),
      assistantText("msg_2", "response 2")
    );
    const entries = parseSessionLog(log);
    expect(findAnchorIndex(entries, "ANCHOR_TEXT")).toBe(2);
  });

  test("returns last human prompt when no anchorText", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "r1"),
      userPrompt("second"),
      assistantText("msg_2", "r2"),
      userPrompt("third")
    );
    const entries = parseSessionLog(log);
    expect(findAnchorIndex(entries)).toBe(4);
  });

  test("skips tool results when searching for anchor", () => {
    const log = buildLog(
      userPrompt("human message"),
      assistantToolUse("msg_1", "Bash"),
      userToolResult("toolu_123", "output with ANCHOR_TEXT"),
      userPrompt("the actual ANCHOR_TEXT prompt")
    );
    const entries = parseSessionLog(log);
    expect(findAnchorIndex(entries, "ANCHOR_TEXT")).toBe(3);
  });

  test("returns -1 when anchor not found", () => {
    const log = buildLog(
      userPrompt("hello"),
      assistantText("msg_1", "hi")
    );
    const entries = parseSessionLog(log);
    expect(findAnchorIndex(entries, "NONEXISTENT")).toBe(-1);
  });
});

describe("extractLastRenderedMessage", () => {
  test("pure text response", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Simple response", { stopReason: null }),
      systemEntry(),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Simple response");
  });

  test("grabs last message.id only, not earlier text in the turn", () => {
    // Text before tool call, then text after — only the LAST bubble matters
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Let me check that."),
      assistantToolUse("msg_1", "Bash"),
      userToolResult("toolu_1", "tool output"),
      assistantText("msg_2", "Here's what I found."),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("msg_2");
    expect(result!.text).toBe("Here's what I found.");
  });

  test("grabs last message.id even with mixed text+tool_use earlier", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantTextAndToolUse("msg_1", "I'll read the file now", "Read"),
      userToolResult("toolu_read", "file contents"),
      assistantText("msg_2", "Here's what I found"),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("msg_2");
    expect(result!.text).toBe("Here's what I found");
  });

  test("grabs last message.id in multi-tool turn", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Let me investigate."),
      assistantToolUse("msg_1", "Read"),
      userToolResult("t1", "code"),
      assistantToolUse("msg_2", "Grep"),
      userToolResult("t2", "matches"),
      assistantText("msg_3", "Found some clues."),
      assistantToolUse("msg_3", "Bash"),
      userToolResult("t3", "output"),
      assistantText("msg_4", "The fix is in handler.ts."),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("msg_4");
    expect(result!.text).toBe("The fix is in handler.ts.");
  });

  test("stops at previous human prompt (turn boundary)", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_old", "Old turn response"),
      userPrompt("second"),
      assistantText("msg_new", "New turn response"),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("New turn response");
  });

  test("skips back-to-back user messages to find previous turn", () => {
    // User sent multiple messages without assistant response between them
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "The actual response"),
      userPrompt("second user message"),
      fileSnapshot(),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("The actual response");
  });

  test("skips multiple empty turns to find assistant text", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Deep response"),
      userPrompt("second"),
      userPrompt("third"),
      userPrompt("fourth"),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Deep response");
  });

  test("skips progress and system noise", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "The real message"),
      progress(),
      progress("hook_progress"),
      systemEntry(),
      systemEntry("turn_duration"),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("The real message");
  });

  test("skips tool-only assistant entries (no text to collect)", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantToolUse("msg_1", "Read"),
      userToolResult("toolu_read", "file contents"),
      assistantToolUse("msg_2", "Edit"),
      userToolResult("toolu_edit", "done"),
      assistantText("msg_3", "All done."),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("All done.");
  });

  test("collects multiple text chunks with same message.id", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_multi", "Part one."),
      assistantText("msg_multi", "Part two."),
      assistantText("msg_multi", "Part three.", { stopReason: "end_turn" }),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Part one.\nPart two.\nPart three.");
    expect(result!.lineNumbers).toEqual([2, 3, 4]);
  });

  test("handles empty text blocks gracefully", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Real content"),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_empty",
          role: "assistant",
          content: [{ type: "text", text: "   \n  " }],
          stop_reason: "end_turn",
        },
        uuid: crypto.randomUUID(),
        parentUuid: crypto.randomUUID(),
      }),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Real content");
  });

  test("returns null when no assistant messages exist before anchor", () => {
    const log = buildLog(userPrompt("ANCHOR"));
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).toBeNull();
  });

  test("returns null when only tool-use assistants in turn (no text at all)", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantToolUse("msg_1", "Bash"),
      userToolResult("toolu_1", "output"),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).toBeNull();
  });

  test("skips file-history-snapshot entries", () => {
    const log = buildLog(
      fileSnapshot(),
      userPrompt("first"),
      assistantText("msg_1", "Response"),
      fileSnapshot(),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Response");
  });

  test("skips queue-operation entries", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Response before queue op"),
      queueOp(),
      queueOp(),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Response before queue op");
  });
});

describe("extractLastRenderedMessage — edge cases", () => {
  test("thinking block does not interfere with text extraction", () => {
    // Thinking blocks have type:"thinking" — not text, not tool_use
    const thinkingEntry = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_think",
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm...", signature: "sig" }],
        stop_reason: null,
      },
      uuid: crypto.randomUUID(),
      parentUuid: crypto.randomUUID(),
    });
    const log = buildLog(
      userPrompt("first"),
      thinkingEntry,
      assistantText("msg_think", "Here is my response."),
      userPrompt("ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Here is my response.");
  });
});

describe("parseSessionLog", () => {
  test("skips malformed lines", () => {
    const log = '{"type":"user"}\nnot json\n{"type":"assistant"}';
    const entries = parseSessionLog(log);
    expect(entries).toHaveLength(2);
  });

  test("handles empty input", () => {
    expect(parseSessionLog("")).toHaveLength(0);
  });
});

describe("findSessionLogsByAncestorWalk", () => {
  // These tests use the real ~/.claude/projects/ directory structure.
  // They verify the ancestor walk logic without needing mocks.

  test("returns empty array for root directory (no parents to walk)", () => {
    const result = findSessionLogsByAncestorWalk("/");
    expect(result).toEqual([]);
  });

  test("walks up to find parent directory session logs", () => {
    // Create a temporary project slug structure
    const testId = `plannotator-test-${Date.now()}`;
    const testDir = join(tmpdir(), testId, "sub", "deep");
    const slugDir = join(
      homedir(),
      ".claude",
      "projects",
      // Slug for the parent (tmpdir/testId)
      `${join(tmpdir(), testId)}`.replace(/[^a-zA-Z0-9-]/g, "-")
    );

    try {
      // Set up: create a fake session log at the parent slug
      mkdirSync(slugDir, { recursive: true });
      const fakeLog = join(slugDir, "fake-session.jsonl");
      writeFileSync(fakeLog, '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]}}\n');

      // Walk from the deep subdirectory — should find the parent's logs
      const result = findSessionLogsByAncestorWalk(testDir);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBe(fakeLog);
    } finally {
      // Cleanup
      rmSync(slugDir, { recursive: true, force: true });
    }
  });

  test("does not return results for the exact CWD (caller already tried it)", () => {
    // Create a temp slug for the exact CWD
    const testId = `plannotator-test-exact-${Date.now()}`;
    const testDir = join(tmpdir(), testId);
    const slugDir = join(
      homedir(),
      ".claude",
      "projects",
      testDir.replace(/[^a-zA-Z0-9-]/g, "-")
    );

    try {
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(
        join(slugDir, "fake.jsonl"),
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hi"}]}}\n'
      );

      // Ancestor walk skips the exact CWD — the caller already tried it
      const result = findSessionLogsByAncestorWalk(testDir);
      // Should not find the CWD's own slug; only parents
      expect(result.every((p) => !p.includes(slugDir))).toBe(true);
    } finally {
      rmSync(slugDir, { recursive: true, force: true });
    }
  });
});

// --- Resolver Tests (new) ---

describe("getAncestorPids", () => {
  test("returns empty array for invalid startPid", () => {
    expect(getAncestorPids(0, 5, () => null)).toEqual([]);
    expect(getAncestorPids(1, 5, () => null)).toEqual([]);
  });

  test("returns startPid when there is no parent", () => {
    expect(getAncestorPids(100, 5, () => null)).toEqual([100]);
  });

  test("walks up the PID chain until root", () => {
    const parents: Record<number, number> = { 100: 200, 200: 300, 300: 1 };
    expect(
      getAncestorPids(100, 10, (p) => parents[p] ?? null)
    ).toEqual([100, 200, 300]);
  });

  test("respects maxHops limit", () => {
    const parents: Record<number, number> = { 100: 200, 200: 300, 300: 400 };
    expect(
      getAncestorPids(100, 2, (p) => parents[p] ?? null)
    ).toEqual([100, 200]);
  });

  test("breaks on PID cycles", () => {
    const parents: Record<number, number> = { 100: 200, 200: 100 };
    const chain = getAncestorPids(100, 50, (p) => parents[p] ?? null);
    expect(chain).toEqual([100, 200]);
  });

  test("breaks when getParent returns startPid (self-loop)", () => {
    const chain = getAncestorPids(100, 50, () => 100);
    expect(chain).toEqual([100]);
  });
});

/** Build an isolated sessions + projects dir under tmpdir for a test. */
function makeTempDirs(label: string): {
  sessionsDir: string;
  projectsDir: string;
  cleanup: () => void;
} {
  const base = join(tmpdir(), `plannotator-resolver-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sessionsDir = join(base, "sessions");
  const projectsDir = join(base, "projects");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return {
    sessionsDir,
    projectsDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Write a session metadata file for a PID. */
function writeSessionMeta(
  sessionsDir: string,
  pid: number,
  meta: { sessionId: string; cwd: string; startedAt?: number }
): void {
  writeFileSync(
    join(sessionsDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt ?? Date.now(),
    })
  );
}

/** Create a session jsonl for a given cwd + sessionId. */
function writeSessionLog(
  projectsDir: string,
  cwd: string,
  sessionId: string,
  content = '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hi"}]}}\n'
): string {
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

describe("resolveSessionLogByAncestorPids", () => {
  test("returns null when no ancestor PID has session metadata", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("no-ancestor");
    try {
      const result = resolveSessionLogByAncestorPids({
        startPid: 100,
        getParentPid: () => null,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("finds session at direct parent (1 hop)", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("direct-parent");
    try {
      const cwd = "/tmp/fake-project-direct";
      const sessionId = "abcd-1234";
      writeSessionMeta(sessionsDir, 999, { sessionId, cwd });
      const logPath = writeSessionLog(projectsDir, cwd, sessionId);

      const result = resolveSessionLogByAncestorPids({
        startPid: 999,
        getParentPid: () => null,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(logPath);
    } finally {
      cleanup();
    }
  });

  test("walks past bash subshell to find Claude Code ancestor", () => {
    // Simulates: plannotator (ppid=500 = sh) → sh (ppid=400 = claude)
    // Claude Code's session file is at pid 400, NOT 500.
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("walks-past");
    try {
      const cwd = "/tmp/fake-project-walk";
      const sessionId = "walk-1234";
      writeSessionMeta(sessionsDir, 400, { sessionId, cwd });
      const logPath = writeSessionLog(projectsDir, cwd, sessionId);

      const parents: Record<number, number> = { 500: 400, 400: 1 };
      const result = resolveSessionLogByAncestorPids({
        startPid: 500,
        getParentPid: (p) => parents[p] ?? null,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(logPath);
    } finally {
      cleanup();
    }
  });

  test("skips metadata when matching jsonl does not exist", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("skip-missing");
    try {
      const cwd = "/tmp/fake-project-skip";
      // Metadata exists but the log file does not
      writeSessionMeta(sessionsDir, 400, { sessionId: "missing-id", cwd });

      const result = resolveSessionLogByAncestorPids({
        startPid: 400,
        getParentPid: () => null,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null when sessionsDir doesn't exist", () => {
    const { projectsDir, cleanup } = makeTempDirs("no-sessions");
    try {
      const result = resolveSessionLogByAncestorPids({
        startPid: 100,
        getParentPid: () => null,
        sessionsDir: "/nonexistent/sessions/dir/xyz",
        projectsDir,
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("resolveSessionLogByCwdScan", () => {
  test("returns null when sessionsDir is empty", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("empty");
    try {
      const result = resolveSessionLogByCwdScan({
        cwd: "/tmp/any",
        sessionsDir,
        projectsDir,
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null when no session metadata matches cwd", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("no-match");
    try {
      writeSessionMeta(sessionsDir, 100, {
        sessionId: "other-id",
        cwd: "/tmp/other-project",
      });
      const result = resolveSessionLogByCwdScan({
        cwd: "/tmp/my-project",
        sessionsDir,
        projectsDir,
      });
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("picks most recent startedAt when multiple sessions match cwd", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("pick-recent");
    try {
      const cwd = "/tmp/multi-project";
      // Two concurrent sessions with the same cwd
      writeSessionMeta(sessionsDir, 111, {
        sessionId: "old-session",
        cwd,
        startedAt: 1_000,
      });
      writeSessionMeta(sessionsDir, 222, {
        sessionId: "new-session",
        cwd,
        startedAt: 2_000,
      });
      writeSessionLog(projectsDir, cwd, "old-session");
      const newLog = writeSessionLog(projectsDir, cwd, "new-session");

      const result = resolveSessionLogByCwdScan({
        cwd,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(newLog);
    } finally {
      cleanup();
    }
  });

  test("falls through to older session if newest has no matching jsonl", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("fallthrough");
    try {
      const cwd = "/tmp/fallthrough-project";
      writeSessionMeta(sessionsDir, 111, {
        sessionId: "old-session",
        cwd,
        startedAt: 1_000,
      });
      writeSessionMeta(sessionsDir, 222, {
        sessionId: "new-session-no-log",
        cwd,
        startedAt: 2_000,
      });
      const oldLog = writeSessionLog(projectsDir, cwd, "old-session");
      // Note: no jsonl for new-session-no-log

      const result = resolveSessionLogByCwdScan({
        cwd,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(oldLog);
    } finally {
      cleanup();
    }
  });

  test("ignores malformed session metadata files", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("malformed");
    try {
      const cwd = "/tmp/malformed-project";
      writeFileSync(join(sessionsDir, "999.json"), "not valid json");
      writeSessionMeta(sessionsDir, 111, { sessionId: "good", cwd });
      const goodLog = writeSessionLog(projectsDir, cwd, "good");

      const result = resolveSessionLogByCwdScan({
        cwd,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(goodLog);
    } finally {
      cleanup();
    }
  });
});

// --- Process Table Parser Tests ---

describe("parseProcessTablePs", () => {
  test("parses well-formed ps output", () => {
    const stdout = [
      "    1     0",
      "  123     1",
      " 4567   123",
    ].join("\n");
    const table = parseProcessTablePs(stdout);
    expect(table.get(1)).toBe(0);
    expect(table.get(123)).toBe(1);
    expect(table.get(4567)).toBe(123);
    expect(table.size).toBe(3);
  });

  test("skips blank and malformed lines", () => {
    const stdout = [
      "",
      "   ",
      "not a row",
      "  100   200",
      "only-one",
    ].join("\n");
    const table = parseProcessTablePs(stdout);
    expect(table.get(100)).toBe(200);
    expect(table.size).toBe(1);
  });

  test("returns empty map for empty input", () => {
    expect(parseProcessTablePs("").size).toBe(0);
  });
});

describe("parseProcessTableCsv", () => {
  test("parses ConvertTo-Csv output with quoted fields", () => {
    const stdout = [
      '"ProcessId","ParentProcessId"',
      '"4","0"',
      '"1234","4"',
      '"5678","1234"',
    ].join("\r\n");
    const table = parseProcessTableCsv(stdout);
    expect(table.get(4)).toBe(0);
    expect(table.get(1234)).toBe(4);
    expect(table.get(5678)).toBe(1234);
    expect(table.size).toBe(3);
  });

  test("tolerates unquoted numeric rows", () => {
    const stdout = [
      "ProcessId,ParentProcessId",
      "100,200",
      "300,100",
    ].join("\n");
    const table = parseProcessTableCsv(stdout);
    expect(table.get(100)).toBe(200);
    expect(table.get(300)).toBe(100);
  });

  test("skips malformed rows", () => {
    const stdout = [
      '"ProcessId","ParentProcessId"',
      'garbage',
      '"100","200"',
      '"abc","def"',
      '',
    ].join("\r\n");
    const table = parseProcessTableCsv(stdout);
    expect(table.size).toBe(1);
    expect(table.get(100)).toBe(200);
  });

  test("returns empty map for empty input", () => {
    expect(parseProcessTableCsv("").size).toBe(0);
  });
});

describe("normalizeCwdForCompare", () => {
  // normalizeCwdForCompare branches on process.platform. Rather than mock the
  // platform, assert the invariant that identical cwds always normalize equal,
  // and that on the current platform the function is idempotent.
  test("is idempotent", () => {
    const cwd = process.platform === "win32"
      ? "C:\\Users\\me\\project"
      : "/home/me/project";
    expect(normalizeCwdForCompare(normalizeCwdForCompare(cwd))).toBe(
      normalizeCwdForCompare(cwd)
    );
  });

  test("on Windows: case and slash differences are normalized", () => {
    if (process.platform !== "win32") return;
    expect(normalizeCwdForCompare("C:\\Users\\Admin\\Project"))
      .toBe(normalizeCwdForCompare("c:/users/admin/project"));
  });

  test("on Unix: preserves exact string (case-sensitive)", () => {
    if (process.platform === "win32") return;
    expect(normalizeCwdForCompare("/home/me/Project"))
      .not.toBe(normalizeCwdForCompare("/home/me/project"));
  });
});

describe("resolveSessionLogByCwdScan (cross-platform cwd matching)", () => {
  test("matches when Claude-stored cwd casing differs on Windows", () => {
    if (process.platform !== "win32") return;
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("win-case");
    try {
      // Claude writes C:\Users\... but process.cwd() may return c:\users\...
      const storedCwd = "C:\\Users\\Admin\\proj";
      const queryCwd = "c:\\users\\admin\\proj";
      writeSessionMeta(sessionsDir, 111, { sessionId: "s1", cwd: storedCwd });
      const log = writeSessionLog(projectsDir, storedCwd, "s1");

      const result = resolveSessionLogByCwdScan({
        cwd: queryCwd,
        sessionsDir,
        projectsDir,
      });
      expect(result).toBe(log);
    } finally {
      cleanup();
    }
  });
});

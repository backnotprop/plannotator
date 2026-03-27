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

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
  extractRecentRenderedMessages,
  getRecentRenderedMessages,
  resolveActiveBranchIndices,
  findDroidSessionLogsForCwd,
  resolveDroidSessionLogForCwd,
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
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
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

/** Bookkeeping entry with no id at all — Claude Code often writes these last. */
function lastPromptEntry(lastPrompt: string, leafUuid: string): string {
  return JSON.stringify({ type: "last-prompt", lastPrompt, leafUuid });
}

/**
 * Link fixture lines into one parent chain, the way Claude Code records a
 * conversation. The individual helpers assign random `parentUuid`s, which would
 * otherwise leave every entry an orphan and make branch resolution untestable.
 * Entries with no `uuid` (bookkeeping types) are passed through untouched.
 */
function linkChain(lines: string[], parentUuid: string | null = null): string[] {
  let previous = parentUuid;
  return lines.map((line) => {
    const entry = JSON.parse(line);
    if (typeof entry.uuid !== "string") {
      return JSON.stringify(entry);
    }
    entry.parentUuid = previous;
    previous = entry.uuid;
    return JSON.stringify(entry);
  });
}

/** Last `uuid` in a set of already-linked lines. */
function tailUuid(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = JSON.parse(lines[i]);
    if (typeof entry.uuid === "string") {
      return entry.uuid;
    }
  }
  throw new Error("no id-bearing entry in lines");
}

function buildLog(...lines: string[]): string {
  return linkChain(lines).join("\n");
}

/**
 * A log recording a `/rewind`. `kept` runs to the rewind target, `abandoned` is
 * orphaned by the rewind but stays in the file, and `resumed` re-parents back to
 * the target. File order stays kept → abandoned → resumed, because the
 * transcript is append-only and the rewind itself writes nothing.
 */
function buildRewoundLog(opts: {
  kept: string[];
  abandoned: string[];
  resumed: string[];
}): string {
  const kept = linkChain(opts.kept);
  const forkPoint = tailUuid(kept);
  return [
    ...kept,
    ...linkChain(opts.abandoned, forkPoint),
    ...linkChain(opts.resumed, forkPoint),
  ].join("\n");
}

function droidMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  opts: { visibility?: string; visibilityPlacement?: "message" | "entry" } = {},
): string {
  const message = {
    role,
    content: [{ type: "text", text }],
    ...(opts.visibility && opts.visibilityPlacement !== "entry"
      ? { visibility: opts.visibility }
      : {}),
  };
  return JSON.stringify({
    type: "message",
    id,
    timestamp: new Date().toISOString(),
    message,
    ...(opts.visibility && opts.visibilityPlacement === "entry"
      ? { visibility: opts.visibility }
      : {}),
  });
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

  test("accepts visible Droid user messages", () => {
    const entry = JSON.parse(droidMessage("m_user", "user", "real human prompt"));
    expect(isHumanPrompt(entry)).toBe(true);
  });

  test("accepts Droid messages with visible transcript visibility", () => {
    expect(
      isHumanPrompt(JSON.parse(droidMessage("m_both", "user", "visible to both", { visibility: "both" })))
    ).toBe(true);
    expect(
      isHumanPrompt(JSON.parse(droidMessage("m_user_only", "user", "visible to user", { visibility: "user_only" })))
    ).toBe(true);
  });

  test("rejects Droid system reminders and command notifications", () => {
    expect(
      isHumanPrompt(JSON.parse(droidMessage("m_sys", "user", "<system-reminder>\ninternal")))
    ).toBe(false);
    expect(
      isHumanPrompt(JSON.parse(droidMessage("m_note", "user", "<system-notification>\ncommand output")))
    ).toBe(false);
  });

  test("rejects hidden Droid user messages", () => {
    const entry = JSON.parse(
      droidMessage("m_hidden", "user", "hidden", { visibility: "llm_only" })
    );
    expect(isHumanPrompt(entry)).toBe(false);
  });

  test("rejects hidden Droid user messages with top-level visibility", () => {
    const entry = JSON.parse(
      droidMessage("m_hidden_top", "user", "hidden", {
        visibility: "llm_only",
        visibilityPlacement: "entry",
      })
    );
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

  test("handles Droid transcript entries and ignores slash-command notifications", () => {
    const log = buildLog(
      droidMessage("ctx", "user", "<system-reminder>\ncontext", { visibility: "llm_only" }),
      droidMessage("u1", "user", "Tell me a story."),
      droidMessage("a1", "assistant", "Once upon a time."),
      droidMessage("cmd", "user", "<system-notification>\nCommand file: /tmp/plannotator-last.js"),
      droidMessage("u2", "user", "ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("a1");
    expect(result!.text).toBe("Once upon a time.");
  });

  test("uses top-level Droid message ids when message.id is absent", () => {
    const log = buildLog(
      droidMessage("u1", "user", "Hi"),
      droidMessage("a-top-level-id", "assistant", "Factory answer"),
      droidMessage("u2", "user", "ANCHOR")
    );
    const entries = parseSessionLog(log);
    const anchor = findAnchorIndex(entries, "ANCHOR")!;
    const result = extractLastRenderedMessage(entries, anchor);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe("a-top-level-id");
    expect(result!.text).toBe("Factory answer");
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

describe("extractRecentRenderedMessages (picker)", () => {
  test("returns newest-first across turn boundaries", () => {
    // Multiple turns — picker must surface assistant bubbles from all of them,
    // not stop at the most recent turn boundary like extractLastRenderedMessage does.
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "First response"),
      userPrompt("second"),
      assistantText("msg_2", "Second response"),
      userPrompt("third"),
      assistantText("msg_3", "Third response"),
    );
    const entries = parseSessionLog(log);
    const result = extractRecentRenderedMessages(entries, entries.length, 5);
    expect(result.map((m) => m.text)).toEqual([
      "Third response",
      "Second response",
      "First response",
    ]);
    expect(result.map((m) => m.messageId)).toEqual(["msg_3", "msg_2", "msg_1"]);
  });

  test("honors limit", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("a", "A"),
      userPrompt("second"),
      assistantText("b", "B"),
      userPrompt("third"),
      assistantText("c", "C"),
    );
    const entries = parseSessionLog(log);
    const result = extractRecentRenderedMessages(entries, entries.length, 2);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.text)).toEqual(["C", "B"]);
  });

  test("first entry matches extractLastRenderedMessage default", () => {
    // The picker's default selection (index 0) must match today's annotate-last
    // behavior — otherwise the no-interaction case would silently change.
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Old"),
      userPrompt("second"),
      assistantText("msg_2", "New"),
    );
    const entries = parseSessionLog(log);
    const last = extractLastRenderedMessage(entries, entries.length)!;
    const recent = extractRecentRenderedMessages(entries, entries.length, 5);
    expect(recent[0].messageId).toBe(last.messageId);
    expect(recent[0].text).toBe(last.text);
  });

  test("empty log → empty list", () => {
    const result = extractRecentRenderedMessages([], 0, 5);
    expect(result).toEqual([]);
  });

  test("limit of zero → empty list", () => {
    const log = buildLog(userPrompt("first"), assistantText("a", "A"));
    const entries = parseSessionLog(log);
    expect(extractRecentRenderedMessages(entries, entries.length, 0)).toEqual([]);
  });

  test("skips assistant entries with no text (tool_use only)", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "Hello"),
      assistantToolUse("msg_tool", "Bash"),
      userPrompt("second"),
      assistantText("msg_2", "World"),
    );
    const entries = parseSessionLog(log);
    const result = extractRecentRenderedMessages(entries, entries.length, 5);
    expect(result.map((m) => m.text)).toEqual(["World", "Hello"]);
  });
});

describe("resolveActiveBranchIndices", () => {
  test("a linear log puts every id-bearing entry on the branch", () => {
    const log = buildLog(
      userPrompt("first"),
      assistantText("msg_1", "First response"),
      userPrompt("second"),
      assistantText("msg_2", "Second response"),
    );
    const entries = parseSessionLog(log);
    expect(resolveActiveBranchIndices(entries)).toEqual(new Set([0, 1, 2, 3]));
  });

  test("a rewind drops the orphaned entries", () => {
    const log = buildRewoundLog({
      kept: [userPrompt("keep me"), assistantText("msg_keep", "Kept")],
      abandoned: [userPrompt("rewound away"), assistantText("msg_gone", "Orphaned")],
      resumed: [userPrompt("after rewind")],
    });
    const entries = parseSessionLog(log);
    // Lines 2 and 3 are the abandoned branch; they stay in the file but are
    // not part of the conversation any more.
    expect(resolveActiveBranchIndices(entries)).toEqual(new Set([0, 1, 4]));
  });

  test("walks back from a tail that carries no id", () => {
    // Claude Code frequently writes a `last-prompt` entry as the final line.
    const linked = linkChain([
      userPrompt("first"),
      assistantText("msg_1", "Response"),
    ]);
    const log = [...linked, lastPromptEntry("first", tailUuid(linked))].join("\n");
    const entries = parseSessionLog(log);
    expect(resolveActiveBranchIndices(entries)).toEqual(new Set([0, 1]));
  });

  test("null when entries carry no ids at all", () => {
    const entries = parseSessionLog(
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m", role: "assistant", content: [{ type: "text", text: "yo" }] },
        }),
      ].join("\n"),
    );
    expect(resolveActiveBranchIndices(entries)).toBeNull();
  });

  test("null when the chain dead-ends instead of reaching the root", () => {
    // Unlinked lines: each helper assigns a random parentUuid that matches
    // nothing in the file. A partial walk must not be mistaken for a branch.
    const log = [userPrompt("first"), assistantText("msg_1", "Response")].join("\n");
    const entries = parseSessionLog(log);
    expect(resolveActiveBranchIndices(entries)).toBeNull();
  });

  test("null on a cycle", () => {
    const a = JSON.stringify({ type: "user", message: { role: "user", content: "a" }, uuid: "u-a", parentUuid: "u-b" });
    const b = JSON.stringify({ type: "user", message: { role: "user", content: "b" }, uuid: "u-b", parentUuid: "u-a" });
    expect(resolveActiveBranchIndices(parseSessionLog([a, b].join("\n")))).toBeNull();
  });

  test("empty log → null", () => {
    expect(resolveActiveBranchIndices([])).toBeNull();
  });
});

describe("extractRecentRenderedMessages — after a rewind", () => {
  const rewoundLog = () =>
    buildRewoundLog({
      kept: [
        userPrompt("are the remotes named weirdly?"),
        assistantText("msg_target", "They're inverted from the GitHub convention."),
      ],
      abandoned: [
        userPrompt("nah, use the standard convention"),
        assistantText("msg_orphan", "Pushed. All three are on 68c1291c."),
      ],
      resumed: [userPrompt("/plannotator-last")],
    });

  test("the default pick is the live message, not the orphan", () => {
    const entries = parseSessionLog(rewoundLog());
    const result = extractRecentRenderedMessages(entries, entries.length, 25, {
      branchIndices: resolveActiveBranchIndices(entries),
    });
    expect(result[0].messageId).toBe("msg_target");
    expect(result.map((m) => m.messageId)).not.toContain("msg_orphan");
  });

  test("orphaned messages are absent from the picker list", () => {
    const entries = parseSessionLog(rewoundLog());
    const result = extractRecentRenderedMessages(entries, entries.length, 25, {
      branchIndices: resolveActiveBranchIndices(entries),
    });
    expect(result).toHaveLength(1);
  });

  test("without branchIndices the orphan still wins (unchanged file-order read)", () => {
    // Documents the behavior the Droid path keeps, and the bug this fixes.
    const entries = parseSessionLog(rewoundLog());
    const result = extractRecentRenderedMessages(entries, entries.length, 25);
    expect(result[0].messageId).toBe("msg_orphan");
  });

  test("line numbers still point at real file positions", () => {
    const entries = parseSessionLog(rewoundLog());
    const result = extractRecentRenderedMessages(entries, entries.length, 25, {
      branchIndices: resolveActiveBranchIndices(entries),
    });
    // msg_target is file line 2 (index 1), even though lines 3-4 were skipped.
    expect(result[0].lineNumbers).toEqual([2]);
  });

  test("an untrustworthy chain degrades to the file-order read", () => {
    // resolveActiveBranchIndices returns null here; passing it through must not
    // filter everything out.
    const log = [userPrompt("first"), assistantText("msg_1", "Response")].join("\n");
    const entries = parseSessionLog(log);
    const result = extractRecentRenderedMessages(entries, entries.length, 25, {
      branchIndices: resolveActiveBranchIndices(entries),
    });
    expect(result.map((m) => m.messageId)).toEqual(["msg_1"]);
  });
});

describe("getRecentRenderedMessages — after a /compact", () => {
  // A compact boundary is written with `parentUuid: null`, so it is a tree
  // root: the active branch stops there and pre-compaction entries are cut.
  const compactedLog = () => {
    const preCompact = linkChain([
      userPrompt("early question"),
      assistantText("msg_pre", "Pre-compaction answer"),
    ]);
    const boundary = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      uuid: "u-compact",
      parentUuid: null,
    });
    const postPrompt = JSON.stringify({
      type: "user",
      message: { role: "user", content: "/plannotator-last" },
      uuid: "u-after",
      parentUuid: "u-compact",
    });
    return [...preCompact, boundary, postPrompt].join("\n");
  };

  test("the active branch stops at the compact boundary", () => {
    const entries = parseSessionLog(compactedLog());
    expect(resolveActiveBranchIndices(entries)).toEqual(new Set([2, 3]));
  });

  test("an empty active branch falls back to the file-order read", () => {
    // Right after a compaction the branch holds no assistant messages. An
    // empty result must not escape: callers treat it as "wrong log file" and
    // walk off to an older session. Fail open to the file-order read instead.
    const dir = join(tmpdir(), `plannotator-compact-test-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "session.jsonl");
    try {
      writeFileSync(logPath, compactedLog());
      const result = getRecentRenderedMessages(logPath, 25, {
        activeBranchOnly: true,
      });
      expect(result.map((m) => m.messageId)).toEqual(["msg_pre"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a post-compaction assistant message is preferred once one exists", () => {
    // Once the compacted conversation has its own assistant message, the
    // branch read stands on its own and the pre-compaction orphan stays out.
    const log = [
      compactedLog(),
      linkChain([assistantText("msg_post", "Post-compaction answer")], "u-after").join("\n"),
    ].join("\n");
    const dir = join(tmpdir(), `plannotator-compact-test2-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "session.jsonl");
    try {
      writeFileSync(logPath, log);
      const result = getRecentRenderedMessages(logPath, 25, {
        activeBranchOnly: true,
      });
      expect(result.map((m) => m.messageId)).toEqual(["msg_post"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test("returns empty array for root directory (no parents to walk)", () => {
    const result = findSessionLogsByAncestorWalk("/");
    expect(result).toEqual([]);
  });

  test("walks up to find parent directory session logs", () => {
    const { projectsDir, cleanup } = makeTempDirs("ancestor-walk");
    try {
      const testId = `plannotator-test-${Date.now()}`;
      const testDir = join(tmpdir(), testId, "sub", "deep");
      const parentSlug = join(tmpdir(), testId).replace(/[^a-zA-Z0-9-]/g, "-");
      const slugDir = join(projectsDir, parentSlug);
      mkdirSync(slugDir, { recursive: true });
      const fakeLog = join(slugDir, "fake-session.jsonl");
      writeFileSync(fakeLog, '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]}}\n');

      const result = findSessionLogsByAncestorWalk(testDir, projectsDir);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBe(fakeLog);
    } finally {
      cleanup();
    }
  });

  test("does not return results for the exact CWD (caller already tried it)", () => {
    const { projectsDir, cleanup } = makeTempDirs("ancestor-exact");
    try {
      const testId = `plannotator-test-exact-${Date.now()}`;
      const testDir = join(tmpdir(), testId);
      const cwdSlug = testDir.replace(/[^a-zA-Z0-9-]/g, "-");
      const slugDir = join(projectsDir, cwdSlug);
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(
        join(slugDir, "fake.jsonl"),
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hi"}]}}\n'
      );

      const result = findSessionLogsByAncestorWalk(testDir, projectsDir);
      expect(result.every((p) => !p.includes(slugDir))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("findDroidSessionLogsForCwd", () => {
  test("finds session logs under the Factory sessions directory layout", () => {
    const { projectsDir: sessionsDir, cleanup } = makeTempDirs("droid-cwd");
    try {
      const cwd = "/Users/example/project";
      const logPath = writeSessionLog(sessionsDir, cwd, "droid-session-1");
      const result = findDroidSessionLogsForCwd(cwd, sessionsDir);
      expect(result[0]).toBe(logPath);
    } finally {
      cleanup();
    }
  });
});

describe("resolveDroidSessionLogForCwd", () => {
  test("returns the newest exact-cwd session candidate", () => {
    const { projectsDir: sessionsDir, cleanup } = makeTempDirs("droid-current");
    try {
      const cwd = "/Users/example/project";
      const older = writeSessionLog(
        sessionsDir,
        cwd,
        "older-session",
        buildLog(
          droidMessage("u1", "user", "old prompt"),
          droidMessage("a1", "assistant", "old reply"),
        ),
      );
      const newer = writeSessionLog(
        sessionsDir,
        cwd,
        "newer-session",
        '{"type":"session_start","id":"newer-session"}\n',
      );

      const now = Date.now() / 1000;
      utimesSync(older, now - 10, now - 10);
      utimesSync(newer, now, now);

      expect(resolveDroidSessionLogForCwd(cwd, sessionsDir)).toBe(newer);
    } finally {
      cleanup();
    }
  });

  test("falls back to the newest ancestor session candidate when exact cwd has no logs", () => {
    const { projectsDir: sessionsDir, cleanup } = makeTempDirs("droid-ancestor");
    try {
      const sessionRoot = "/Users/example/project";
      const subdir = `${sessionRoot}/src/nested`;
      const older = writeSessionLog(
        sessionsDir,
        sessionRoot,
        "older-session",
        buildLog(droidMessage("a1", "assistant", "old reply")),
      );
      const newer = writeSessionLog(
        sessionsDir,
        sessionRoot,
        "newer-session",
        '{"type":"session_start","id":"newer-session"}\n',
      );

      const now = Date.now() / 1000;
      utimesSync(older, now - 10, now - 10);
      utimesSync(newer, now, now);

      expect(resolveDroidSessionLogForCwd(subdir, sessionsDir)).toBe(newer);
    } finally {
      cleanup();
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

  test("prefers newer ghost session over stale metadata match (after /clear)", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("ghost-clear");
    try {
      const cwd = "/tmp/fake-project-ghost";
      const oldSessionId = "old-session-before-clear";
      const newSessionId = "new-session-after-clear";

      // Metadata still points to old session (stale after /clear)
      writeSessionMeta(sessionsDir, 400, { sessionId: oldSessionId, cwd });

      // Both logs exist; force mtime ordering via utimes
      const { utimesSync } = require("node:fs");
      const oldLog = writeSessionLog(projectsDir, cwd, oldSessionId, buildLog(
        userPrompt("hello"),
        assistantText("msg_old", "Doing well, thanks!")
      ));
      const past = new Date(Date.now() - 5000);
      utimesSync(oldLog, past, past);

      const newLog = writeSessionLog(projectsDir, cwd, newSessionId, buildLog(
        userPrompt("Why is the sky blue?"),
        assistantText("msg_new", "Rayleigh scattering")
      ));

      const result = resolveSessionLogByAncestorPids({
        startPid: 400,
        getParentPid: () => null,
        sessionsDir,
        projectsDir,
      });

      // Should prefer the ghost session (newer, unregistered)
      expect(result).toBe(newLog);
    } finally {
      cleanup();
    }
  });

  test("keeps PID-based result when newer log belongs to a concurrent session", () => {
    const { sessionsDir, projectsDir, cleanup } = makeTempDirs("concurrent");
    try {
      const cwd = "/tmp/fake-project-concurrent";
      const sessionA = "session-terminal-1";
      const sessionB = "session-terminal-2";

      // Both sessions have their own metadata (different PIDs)
      writeSessionMeta(sessionsDir, 400, { sessionId: sessionA, cwd });
      writeSessionMeta(sessionsDir, 500, { sessionId: sessionB, cwd });

      // Terminal 1's log (older)
      const { utimesSync } = require("node:fs");
      const logA = writeSessionLog(projectsDir, cwd, sessionA, buildLog(
        userPrompt("hello from terminal 1"),
        assistantText("msg_a", "Response in terminal 1")
      ));
      const past = new Date(Date.now() - 5000);
      utimesSync(logA, past, past);

      // Terminal 2's log (more recently modified)
      const logB = writeSessionLog(projectsDir, cwd, sessionB, buildLog(
        userPrompt("hello from terminal 2"),
        assistantText("msg_b", "Response in terminal 2")
      ));

      // From terminal 1's process tree, should get terminal 1's log
      const result = resolveSessionLogByAncestorPids({
        startPid: 400,
        getParentPid: () => null,
        sessionsDir,
        projectsDir,
      });

      // Should keep the PID-based result (session B is registered, not a ghost)
      expect(result).toBe(logA);
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

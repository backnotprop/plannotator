/**
 * Codex Session Parser Tests
 *
 * Run: bun test apps/hook/server/codex-session.test.ts
 *
 * Uses synthetic JSONL fixtures matching the real Codex rollout format.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCodexRolloutByThreadId,
  findCodexRolloutsByThreadId,
  getCodexStopSkipReason,
  getLastCodexMessage,
  getLatestCodexPlan,
  logCodexStopSkip,
  getRecentCodexMessages,
} from "./codex-session";

// --- Fixture Helpers ---

function rolloutLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    payload,
  });
}

function assistantMessage(text: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  });
}

function userMessage(text: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
}

function developerMessage(text: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  });
}

function functionCall(name: string, args: string): string {
  return rolloutLine("response_item", {
    type: "function_call",
    name,
    arguments: args,
    call_id: `call_${crypto.randomUUID().slice(0, 12)}`,
  });
}

function functionOutput(callId: string, output: string): string {
  return rolloutLine("response_item", {
    type: "function_call_output",
    call_id: callId,
    output,
  });
}

function sessionMeta(): string {
  return rolloutLine("session_meta", {
    id: crypto.randomUUID(),
    cwd: "/tmp/test",
    model_provider: "openai",
  });
}

function turnContext(turnId?: string): string {
  return rolloutLine("turn_context", {
    cwd: "/tmp/test",
    model: "o3",
    ...(turnId && { turn_id: turnId }),
  });
}

function eventMsg(type: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type },
  });
}

function turnStarted(turnId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
    },
  });
}

function turnCompleted(turnId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId,
    },
  });
}

function completedPlanItem(text: string, turnId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: turnId,
      item: {
        type: "Plan",
        id: `plan_${crypto.randomUUID().slice(0, 12)}`,
        text,
      },
    },
  });
}

function hookPrompt(text: string): string {
  return rolloutLine("response_item", {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<hook_prompt hook_run_id="${crypto.randomUUID()}">${text}</hook_prompt>`,
      },
    ],
  });
}

function buildRollout(...lines: string[]): string {
  return lines.join("\n");
}

// --- Temp file helpers ---

let tempFiles: string[] = [];

function writeTempRollout(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-codex-test-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, content);
  tempFiles.push(dir);
  return path;
}

afterEach(() => {
  for (const dir of tempFiles.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Tests ---

describe("findCodexRolloutByThreadId", () => {
  test("respects CODEX_HOME for session discovery (#852)", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-codex-home-"));
    tempFiles.push(home);
    const threadId = "0196f8a2-aaaa-bbbb-cccc-1234567890ab";
    const dayDir = join(home, "sessions", "2026", "06", "04");
    mkdirSync(dayDir, { recursive: true });
    const rollout = join(dayDir, `rollout-2026-06-04T10-00-00-${threadId}.jsonl`);
    writeFileSync(rollout, buildRollout(sessionMeta(), assistantMessage("hi")));

    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(findCodexRolloutByThreadId(threadId)).toBe(rollout);
      expect(findCodexRolloutByThreadId("no-such-thread")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

// --- Multi-rollout threads (#1367) ---

/**
 * One Codex thread can span several rollout files. Fallback semantics differ
 * by consumer: annotate-last asks a THREAD-level question and walks the
 * candidates newest-first until one yields a message (the newest segment may
 * be empty or aborted), while the Stop hook asks a TURN-level question and
 * takes only the first existing candidate — the current turn cannot live in
 * an older segment, so a fallback file's plan is stale by construction.
 * These tests pin both contracts.
 */
describe("multi-rollout threads (#1367)", () => {
  const THREAD_ID = "0196f8a2-1111-2222-3333-1234567890ab";

  function withCodexHome<T>(home: string, fn: () => T): T {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  }

  function sessionsHome(): string {
    const home = mkdtempSync(join(tmpdir(), "plannotator-codex-home-"));
    tempFiles.push(home);
    return home;
  }

  /**
   * Write a rollout segment into <home>/sessions/<date>/ with an exact mtime.
   * Segmented threads use issue-realistic `_<segment>`-suffixed filenames:
   *   rollout-<timestamp>-<thread-id>_<segment>.jsonl (#1367)
   */
  function writeSegment(
    home: string,
    date: { year: string; month: string; day: string },
    stamp: string,
    content: string,
    mtimeIso: string,
    segment?: number
  ): string {
    const dayDir = join(home, "sessions", date.year, date.month, date.day);
    mkdirSync(dayDir, { recursive: true });
    const suffix = segment === undefined ? "" : `_${segment}`;
    const path = join(dayDir, `rollout-${stamp}-${THREAD_ID}${suffix}.jsonl`);
    writeFileSync(path, content);
    const mtime = new Date(mtimeIso);
    utimesSync(path, mtime, mtime);
    return path;
  }

  /** Mirrors the annotate-last selection in index.ts. */
  function resolveLastMessage(home: string): string | null {
    return withCodexHome(home, () => {
      for (const rollout of findCodexRolloutsByThreadId(THREAD_ID)) {
        const recent = getRecentCodexMessages(rollout, 25, { beforeActiveTurn: true });
        if (recent.length > 0) return recent[0].text;
      }
      return null;
    });
  }

  /**
   * Mirrors the Stop-hook plan selection in index.ts: the Stop hook asks a
   * TURN-level question, and the current turn can only live in the newest
   * segment, so only the first EXISTING candidate is consulted — never a
   * fallback across segments (a fallback file's plan is stale by
   * construction and would reopen already-decided plan reviews).
   */
  function resolvePlan(
    home: string,
    options: { turnId?: string; stopHookActive?: boolean } = {}
  ): string | null {
    return withCodexHome(home, () => {
      const rollout =
        findCodexRolloutsByThreadId(THREAD_ID).find((path) => existsSync(path)) ?? null;
      if (!rollout) return null;
      const plan = getLatestCodexPlan(rollout, {
        turnId: options.turnId,
        stopHookActive: !!options.stopHookActive,
      });
      return plan?.text ?? null;
    });
  }

  test("same day: falls back to an older segment when the newest is empty", () => {
    const home = sessionsHome();
    const day = { year: "2026", month: "06", day: "04" };
    const older = writeSegment(
      home,
      day,
      "2026-06-04T10-00-00",
      buildRollout(sessionMeta(), userMessage("Hello"), assistantMessage("Older segment answer")),
      "2026-06-04T10:00:00Z"
    );
    const newer = writeSegment(
      home,
      day,
      "2026-06-04T11-00-00",
      buildRollout(sessionMeta(), userMessage("Hello")),
      "2026-06-04T11:00:00Z",
      1
    );

    withCodexHome(home, () => {
      expect(findCodexRolloutsByThreadId(THREAD_ID)).toEqual([newer, older]);
      expect(findCodexRolloutByThreadId(THREAD_ID)).toBe(newer);
    });
    expect(resolveLastMessage(home)).toBe("Older segment answer");
  });

  test("newest-first ordering follows mtime, not directory or filename order", () => {
    const home = sessionsHome();
    // The newer-mtime segment sits in the EARLIER day directory with the
    // lexicographically SMALLER filename, so both the reverse directory walk
    // and any filename/readdir ordering would put it LAST. Only the mtime
    // sort ranks it first — this fixture fails if that sort is neutered.
    const newerMtime = writeSegment(
      home,
      { year: "2026", month: "06", day: "04" },
      "2026-06-04T08-00-00",
      buildRollout(sessionMeta(), assistantMessage("Newest by mtime")),
      "2026-06-06T12:00:00Z"
    );
    const olderMtime = writeSegment(
      home,
      { year: "2026", month: "06", day: "05" },
      "2026-06-05T09-00-00",
      buildRollout(sessionMeta(), assistantMessage("Older by mtime")),
      "2026-06-05T09:00:00Z",
      1
    );

    withCodexHome(home, () => {
      expect(findCodexRolloutsByThreadId(THREAD_ID)).toEqual([newerMtime, olderMtime]);
      expect(findCodexRolloutByThreadId(THREAD_ID)).toBe(newerMtime);
    });
    expect(resolveLastMessage(home)).toBe("Newest by mtime");
  });

  test("0-byte newest segment falls back for annotate-last", () => {
    const home = sessionsHome();
    const day = { year: "2026", month: "06", day: "04" };
    writeSegment(
      home,
      day,
      "2026-06-04T10-00-00",
      buildRollout(sessionMeta(), assistantMessage("Answer before the crash")),
      "2026-06-04T10:00:00Z"
    );
    // An aborted segment can be created and never written to.
    writeSegment(home, day, "2026-06-04T11-00-00", "", "2026-06-04T11:00:00Z", 1);

    expect(resolveLastMessage(home)).toBe("Answer before the crash");
  });

  test("multi day: falls back across day directories", () => {
    const home = sessionsHome();
    const older = writeSegment(
      home,
      { year: "2026", month: "06", day: "04" },
      "2026-06-04T22-00-00",
      buildRollout(sessionMeta(), assistantMessage("Reply from the previous day")),
      "2026-06-04T22:00:00Z"
    );
    const newer = writeSegment(
      home,
      { year: "2026", month: "06", day: "05" },
      "2026-06-05T09-00-00",
      buildRollout(sessionMeta(), userMessage("Resumed")),
      "2026-06-05T09:00:00Z",
      1
    );

    withCodexHome(home, () => {
      expect(findCodexRolloutsByThreadId(THREAD_ID)).toEqual([newer, older]);
    });
    expect(resolveLastMessage(home)).toBe("Reply from the previous day");
  });

  test("single rollout thread is unchanged", () => {
    const home = sessionsHome();
    const only = writeSegment(
      home,
      { year: "2026", month: "06", day: "04" },
      "2026-06-04T10-00-00",
      buildRollout(sessionMeta(), assistantMessage("Only answer")),
      "2026-06-04T10:00:00Z"
    );

    withCodexHome(home, () => {
      expect(findCodexRolloutsByThreadId(THREAD_ID)).toEqual([only]);
      expect(findCodexRolloutByThreadId(THREAD_ID)).toBe(only);
      expect(findCodexRolloutsByThreadId("no-such-thread")).toEqual([]);
    });
    expect(resolveLastMessage(home)).toBe("Only answer");
  });

  test("single empty rollout still reports no message", () => {
    const home = sessionsHome();
    writeSegment(
      home,
      { year: "2026", month: "06", day: "04" },
      "2026-06-04T10-00-00",
      buildRollout(sessionMeta(), userMessage("Hello")),
      "2026-06-04T10:00:00Z"
    );

    expect(resolveLastMessage(home)).toBeNull();
  });

  test("Stop hook takes only the newest existing segment — never resurrects an older segment's plan", () => {
    const home = sessionsHome();
    const day = { year: "2026", month: "06", day: "04" };
    // The older segment ends with an already-decided proposed plan — the
    // normal shape after a plan is approved and the session resumes. The
    // current turn lives in the newest segment and produced no plan, so the
    // Stop hook must report no plan rather than fall back and reopen the
    // settled review (getLatestCodexPlan's turn gate degrades to
    // last-turn-in-file when the turn_id is absent from a file, which is
    // exactly what happens in every fallback file).
    writeSegment(
      home,
      day,
      "2026-06-04T10-00-00",
      buildRollout(
        sessionMeta(),
        turnStarted("turn-1"),
        assistantMessage("<proposed_plan>\nAlready-decided plan\n</proposed_plan>")
      ),
      "2026-06-04T10:00:00Z"
    );
    writeSegment(
      home,
      day,
      "2026-06-04T11-00-00",
      buildRollout(sessionMeta(), turnStarted("turn-2"), assistantMessage("No plan here.")),
      "2026-06-04T11:00:00Z",
      1
    );

    expect(resolvePlan(home, { turnId: "turn-2", stopHookActive: false })).toBeNull();
  });

  test("Stop hook still reads the plan from the newest segment", () => {
    const home = sessionsHome();
    const day = { year: "2026", month: "06", day: "04" };
    writeSegment(
      home,
      day,
      "2026-06-04T10-00-00",
      buildRollout(sessionMeta(), turnStarted("turn-1"), assistantMessage("Earlier work.")),
      "2026-06-04T10:00:00Z"
    );
    writeSegment(
      home,
      day,
      "2026-06-04T11-00-00",
      buildRollout(
        sessionMeta(),
        turnStarted("turn-2"),
        assistantMessage("<proposed_plan>\nCurrent turn plan\n</proposed_plan>")
      ),
      "2026-06-04T11:00:00Z",
      1
    );

    expect(resolvePlan(home, { turnId: "turn-2", stopHookActive: false })).toBe(
      "Current turn plan"
    );
  });
});

describe("getLastCodexMessage", () => {
  test("finds last assistant message", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        userMessage("Hello"),
        assistantMessage("Hi there!"),
        userMessage("Thanks"),
        assistantMessage("You're welcome.")
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("You're welcome.");
  });

  test("skips function_call entries", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        userMessage("Fix the bug"),
        assistantMessage("Let me look into that."),
        functionCall("exec_command", '{"cmd":"ls"}'),
        functionOutput("call_123", "file1.ts\nfile2.ts"),
        assistantMessage("Found the issue.")
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Found the issue.");
  });

  test("skips developer and user messages", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        developerMessage("System instructions..."),
        userMessage("Do something"),
        assistantMessage("The actual response"),
        developerMessage("More instructions"),
        userMessage("Another user message")
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("The actual response");
  });

  test("extracts multiple output_text blocks", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        rolloutLine("response_item", {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "First part." },
            { type: "output_text", text: "Second part." },
          ],
        })
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("First part.\nSecond part.");
  });

  test("ignores non-output assistant text blocks", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        assistantMessage("Renderable response"),
        rolloutLine("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", text: "Hidden refusal text" }],
        })
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Renderable response");
  });

  test("skips event_msg and turn_context entries", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnContext(),
        userMessage("Hello"),
        assistantMessage("Response here"),
        eventMsg("task_started"),
        turnContext(),
        eventMsg("token_count")
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Response here");
  });

  test("skips assistant messages with empty text", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        assistantMessage("Good response"),
        rolloutLine("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "   " }],
        })
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Good response");
  });

  test("returns null when no assistant messages exist", () => {
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        developerMessage("Instructions"),
        userMessage("Hello"),
        functionCall("exec_command", '{"cmd":"pwd"}')
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).toBeNull();
  });

  test("returns null for empty file", () => {
    const path = writeTempRollout("");
    const result = getLastCodexMessage(path);
    expect(result).toBeNull();
  });

  test("skips malformed JSON lines", () => {
    const path = writeTempRollout(
      buildRollout(
        assistantMessage("Valid message"),
        "not valid json",
        "{broken"
      )
    );
    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Valid message");
  });

  test("can ignore assistant messages from the active Codex turn", () => {
    const previousTurnId = "turn-previous";
    const activeTurnId = "turn-active";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(previousTurnId),
        userMessage("Explain the thing"),
        assistantMessage("Substantive final answer"),
        turnCompleted(previousTurnId),
        turnStarted(activeTurnId),
        userMessage("[$plannotator-last]"),
        assistantMessage("I’ll open Plannotator on my last response.")
      )
    );

    const result = getLastCodexMessage(path, { beforeActiveTurn: true });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Substantive final answer");
  });

  test("keeps default latest-message behavior inside an active turn", () => {
    const turnId = "turn-active";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        assistantMessage("Previous answer"),
        turnStarted(turnId),
        assistantMessage("Current status update")
      )
    );

    const result = getLastCodexMessage(path);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Current status update");
  });
});

describe("getLatestCodexPlan", () => {
  test("prefers the latest persisted plan item for the current turn", () => {
    const turnId = "turn-plan-item";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        assistantMessage("<proposed_plan>\nFallback text\n</proposed_plan>"),
        completedPlanItem("Authoritative plan item", turnId)
      )
    );

    const result = getLatestCodexPlan(path, { turnId });
    expect(result).toEqual({
      text: "Authoritative plan item",
      source: "plan-item",
    });

  });

  test("falls back to raw proposed_plan blocks for plan-only assistant replies", () => {
    const turnId = "turn-plan-only";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        assistantMessage("<proposed_plan>\n- First\n- Second\n</proposed_plan>")
      )
    );

    const result = getLatestCodexPlan(path, { turnId });
    expect(result).toEqual({
      text: "- First\n- Second",
      source: "assistant-message",
    });
  });

  describe("Codex Stop skip diagnostics", () => {
    test("classifies a missing Stop turn id without reading stale plan content", () => {
      expect(getCodexStopSkipReason("not-read.jsonl")).toBe("missing-turn-id");
      expect(getCodexStopSkipReason("not-read.jsonl", "   ")).toBe("missing-turn-id");
    });

    test("requires an id-carrying rollout turn marker", () => {
      const turnId = "turn-without-marker";
      const path = writeTempRollout(
        buildRollout(
          sessionMeta(),
          turnStarted("other-turn"),
          completedPlanItem("Plan item without matching start marker", turnId),
        ),
      );

      expect(getCodexStopSkipReason(path, turnId)).toBe("missing-turn-marker");
    });

    test("writes the exact skip breadcrumb only when debug is enabled", () => {
      const messages: string[] = [];
      const write = (message: string) => messages.push(message);

      logCodexStopSkip("missing-turn-id", { debug: "", write });
      expect(messages).toEqual([]);

      logCodexStopSkip("missing-turn-id", { debug: "1", write });
      logCodexStopSkip("missing-turn-marker", { debug: "1", write });
      expect(messages).toEqual([
        "[DEBUG] Codex Stop plan review skipped: missing Stop payload turn_id.",
        "[DEBUG] Codex Stop plan review skipped: missing id-carrying rollout turn marker.",
      ]);
    });
  });

  test("extracts plan blocks surrounded by assistant prose", () => {
    const turnId = "turn-prose";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        assistantMessage(
          [
            "Here is the plan I recommend.",
            "",
            "<proposed_plan>",
            "1. Inspect hook payloads",
            "2. Launch Plannotator",
            "</proposed_plan>",
            "",
            "I can revise it if needed.",
          ].join("\n")
        )
      )
    );

    const result = getLatestCodexPlan(path, { turnId });
    expect(result).toEqual({
      text: "1. Inspect hook payloads\n2. Launch Plannotator",
      source: "assistant-message",
    });
  });

  test("ignores plans from older turns when the current turn has none", () => {
    const oldTurnId = "turn-old";
    const currentTurnId = "turn-current";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(oldTurnId),
        completedPlanItem("Old plan", oldTurnId),
        turnCompleted(oldTurnId),
        turnStarted(currentTurnId),
        assistantMessage("Just answering a regular question.")
      )
    );

    const result = getLatestCodexPlan(path, { turnId: currentTurnId });
    expect(result).toBeNull();
  });

  test("does not scrape a proposed plan from a later task when the requested turn has none", () => {
    const requestedTurnId = "turn-requested";
    const laterTurnId = "turn-later";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(requestedTurnId),
        assistantMessage("I have no plan to submit for this task."),
        turnCompleted(requestedTurnId),
        turnStarted(laterTurnId),
        assistantMessage("<proposed_plan>\nPlan from the later task\n</proposed_plan>"),
      )
    );

    expect(getLatestCodexPlan(path, { turnId: requestedTurnId })).toBeNull();
  });

  test("does not scrape an assistant proposed plan for a Stop event without a turn id", () => {
    const completedTurnId = "turn-completed";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(completedTurnId),
        assistantMessage("<proposed_plan>\nPrevious turn plan\n</proposed_plan>"),
        turnCompleted(completedTurnId),
      ),
    );

    expect(getLatestCodexPlan(path, { stopHookActive: true })).toBeNull();
  });

  test("keeps the active task id when a turn context has no id", () => {
    const turnId = "turn-with-context";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        turnContext(),
        eventMsg("task_started"),
        assistantMessage("<proposed_plan>\nCurrent turn plan\n</proposed_plan>"),
      ),
    );

    expect(getLatestCodexPlan(path, { turnId })).toEqual({
      text: "Current turn plan",
      source: "assistant-message",
    });
  });

  test("returns null when Stop re-entry has no revised plan after the hook prompt", () => {
    const turnId = "turn-stop-no-revision";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        completedPlanItem("Original plan", turnId),
        hookPrompt("Please revise the plan."),
        assistantMessage("I will think through the feedback.")
      )
    );

    const result = getLatestCodexPlan(path, {
      turnId,
      stopHookActive: true,
    });
    expect(result).toBeNull();
  });

  test("returns null when Stop re-entry repeats the same plan", () => {
    const turnId = "turn-stop-duplicate";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        completedPlanItem("Original plan", turnId),
        hookPrompt("Please revise the plan."),
        completedPlanItem("Original plan", turnId)
      )
    );

    const result = getLatestCodexPlan(path, {
      turnId,
      stopHookActive: true,
    });
    expect(result).toBeNull();
  });

  test("returns the revised plan after a denied Stop review", () => {
    const turnId = "turn-stop-revised";
    const path = writeTempRollout(
      buildRollout(
        sessionMeta(),
        turnStarted(turnId),
        completedPlanItem("Original plan", turnId),
        hookPrompt("Please revise the plan."),
        assistantMessage("<proposed_plan>\nRevised fallback plan\n</proposed_plan>"),
        completedPlanItem("Revised authoritative plan", turnId)
      )
    );

    const result = getLatestCodexPlan(path, {
      turnId,
      stopHookActive: true,
    });
    expect(result).toEqual({
      text: "Revised authoritative plan",
      source: "plan-item",
    });
  });
});

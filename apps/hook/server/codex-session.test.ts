/**
 * Codex Session Parser Tests
 *
 * Run: bun test apps/hook/server/codex-session.test.ts
 *
 * Uses synthetic JSONL fixtures matching the real Codex rollout format.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLastCodexMessage, getLatestCodexPlan } from "./codex-session";

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

function turnContext(): string {
  return rolloutLine("turn_context", {
    cwd: "/tmp/test",
    model: "o3",
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

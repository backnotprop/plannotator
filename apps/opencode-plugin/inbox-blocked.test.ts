/**
 * OpenCode 2's word on a prompt up in its terminal (`noteOpenCodePrompt`, `openCodeBlocked`), which the shared link
 * sends as INBOX_BLOCKED_FIELD (packages/shared/inbox/agent-link-blocked.test.ts). The failures these guard: a reply
 * to another request clearing a permission, a form outliving a later form event for it, the turn's end leaving
 * anything blocked, a permission not winning over a question; a question under the SDK's names (`question.*`) missed;
 * a prompt held after the plugin found the session not running (a lost end event: review M2).
 */
import { describe, expect, test } from "bun:test";
import { endOpenCodePrompts, noteOpenCodePrompt, openCodeBlocked } from "./inbox";

describe("OpenCode 2's prompts (permission.asked / replied, form.created)", () => {
  test("a permission until its own reply; a form until a later form event for it; the turn's end clears both", () => {
    const state = { running: true, lastEventAt: 0 } as Parameters<typeof noteOpenCodePrompt>[0];
    expect(noteOpenCodePrompt(state, "permission.asked", { id: "per_1", sessionID: "ses", action: "shell", resources: ["rm -rf build"] })).toBe(true);
    expect(openCodeBlocked(state)).toBe("permission");
    noteOpenCodePrompt(state, "permission.replied", { requestID: "per_other", sessionID: "ses" });
    expect(openCodeBlocked(state)).toBe("permission");
    noteOpenCodePrompt(state, "form.created", { id: "frm_1", sessionID: "ses", title: "Which database?" });
    noteOpenCodePrompt(state, "permission.replied", { requestID: "per_1", sessionID: "ses" });
    expect(openCodeBlocked(state)).toBe("question");
    noteOpenCodePrompt(state, "form.replied", { id: "frm_1", sessionID: "ses" });
    expect(openCodeBlocked(state)).toBeNull();
    noteOpenCodePrompt(state, "permission.asked", { id: "per_2", sessionID: "ses" });
    noteOpenCodePrompt(state, "form.created", { formID: "frm_2", sessionID: "ses" });
    expect(noteOpenCodePrompt(state, "session.execution.interrupted", { sessionID: "ses" })).toBe(false);
    expect(openCodeBlocked(state)).toBeNull();
  });
});

describe("OpenCode 2's questions under the SDK's names, and a turn whose end event was lost", () => {
  test("question.asked until question.replied or rejected for that request (requestID); another request's reply leaves it", () => {
    const state = { running: true, lastEventAt: 0 } as Parameters<typeof noteOpenCodePrompt>[0];
    expect(noteOpenCodePrompt(state, "question.asked", { id: "que_1", sessionID: "ses", questions: [{ question: "Which database?" }] })).toBe(true);
    expect(openCodeBlocked(state)).toBe("question");
    noteOpenCodePrompt(state, "question.replied", { requestID: "que_other", sessionID: "ses", answers: [] });
    expect(openCodeBlocked(state)).toBe("question");
    noteOpenCodePrompt(state, "question.replied", { requestID: "que_1", sessionID: "ses", answers: [] });
    expect(openCodeBlocked(state)).toBeNull();
    noteOpenCodePrompt(state, "question.asked", { id: "que_2", sessionID: "ses" });
    noteOpenCodePrompt(state, "question.rejected", { requestID: "que_2", sessionID: "ses" });
    expect(openCodeBlocked(state)).toBeNull();
  });

  test("found not running (a lost end event, the session gone): nothing waits, whatever was asked", () => {
    const state = { running: true, lastEventAt: 0 } as Parameters<typeof noteOpenCodePrompt>[0];
    noteOpenCodePrompt(state, "permission.asked", { id: "per_1", sessionID: "ses" });
    noteOpenCodePrompt(state, "question.asked", { id: "que_1", sessionID: "ses" });
    endOpenCodePrompts(state);
    expect(openCodeBlocked(state)).toBeNull();
  });
});

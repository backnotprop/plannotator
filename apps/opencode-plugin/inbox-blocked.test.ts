/**
 * OpenCode 2's word on a prompt up in its terminal (`noteOpenCodePrompt`, `openCodeBlocked`), which the shared link
 * sends as INBOX_BLOCKED_FIELD (packages/shared/inbox/agent-link-blocked.test.ts). The failures these guard: a reply
 * to another request clearing a permission, a form outliving a later form event for it, the turn's end leaving
 * anything blocked, a permission not winning over a question.
 */
import { describe, expect, test } from "bun:test";
import { noteOpenCodePrompt, openCodeBlocked } from "./inbox";

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

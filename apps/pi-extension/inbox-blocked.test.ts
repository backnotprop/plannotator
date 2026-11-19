/**
 * Pi's word on a prompt up in its terminal (`ui_prompt_start` / `ui_prompt_end`, Pi 0.84+; `PiTerminalPrompts`),
 * which the shared link sends as INBOX_BLOCKED_FIELD (packages/shared/inbox/agent-link-blocked.test.ts). The failures
 * these guard: a nested prompt ending the first one's mark, a prompt end without a start going below none, a settled
 * run or a gone session leaving it blocked, anything but "question" said (Pi itself asks no permission).
 */
import { describe, expect, test } from "bun:test";
import { PiTerminalPrompts } from "./inbox.ts";

describe("Pi's prompts (ui_prompt_start / ui_prompt_end)", () => {
  test("a question while any prompt is up, nested ones included; none once all ended or the run settled", () => {
    const prompts = new PiTerminalPrompts();
    expect(prompts.blocked()).toBeNull();
    prompts.up();
    prompts.up();
    prompts.down();
    expect(prompts.blocked()).toBe("question");
    prompts.down();
    prompts.down();
    expect(prompts.blocked()).toBeNull();
    // An end with no start never goes below none: the next start still counts.
    prompts.up();
    expect(prompts.blocked()).toBe("question");
    prompts.clear();
    prompts.up();
    prompts.clear();
    expect(prompts.blocked()).toBeNull();
  });
});

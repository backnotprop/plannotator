import { describe, expect, test } from "bun:test";
import type { AgentWatch } from "./review-agent-watch";
import { reviewT3Reviver } from "./review-t3-wake";

const env = { CLAUDE_CODE_ENTRYPOINT: "t3-code", T3CODE_THREAD_ID: "mcp:review-thread" };

describe("a T3 review whose Claude stopped", () => {
  test("resumes its own thread and waits until the review watcher is back", async () => {
    let presence: "gone" | "here" = "gone";
    const watch: AgentWatch = { kind: "mod", presence: () => presence, ended: () => false };
    const sent: string[] = [];
    const revive = reviewT3Reviver(watch, env, {
      has: async (id) => id === env.T3CODE_THREAD_ID,
      send: async (id, text) => { sent.push(id, text); presence = "here"; return { sent: true }; },
    })!;
    await revive();
    expect(sent[0]).toBe(env.T3CODE_THREAD_ID);
    expect(sent[1]).toContain("review feedback");
    expect(watch.presence()).toBe("here");
  });

  test("does not wake an unavailable thread, a different host, or a non-mod review", async () => {
    const watch: AgentWatch = { kind: "mod", presence: () => "gone", ended: () => true };
    let sent = 0;
    const local = { has: async () => false, send: async () => { sent++; return { sent: true as const }; } };
    await reviewT3Reviver(watch, env, local)!();
    expect(sent).toBe(0);
    expect(reviewT3Reviver(watch, { ...env, CLAUDE_CODE_ENTRYPOINT: "cli" }, local)).toBeUndefined();
    expect(reviewT3Reviver({ ...watch, kind: "parent" }, env, local)).toBeUndefined();
    expect(reviewT3Reviver(watch, { ...env, T3CODE_THREAD_ID: "" }, local)).toBeUndefined();
  });
});

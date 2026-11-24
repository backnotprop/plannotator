/**
 * `plannotator inbox capability` (inbox-capability-command.ts): its parse into the `capability` tool's fields, and its
 * help. What regresses: a turn sent as the wrong field or the wrong way; a typo turning something on; bad usage
 * starting the Inbox; the help losing the rule that a turn is the person's request.
 */
import { expect, test } from "bun:test";
import { INBOX_CAPABILITY_USAGE, parseCapabilityCommand, runInboxCapabilityCommand } from "./inbox-capability-command";

test("a turn is the tool's capability and on, with the computer and the thread; nothing is a list", () => {
  expect(parseCapabilityCommand(["routines", "on", "--computer", "Studio", "--thread", "msg_1"])).toEqual({ ok: true, call: { capability: "routines", on: true, computer: "Studio", thread_id: "msg_1" }, session: null });
  expect(parseCapabilityCommand(["board", "off", "--session", "ses_1"])).toEqual({ ok: true, call: { capability: "board", on: false }, session: "ses_1" });
  expect(parseCapabilityCommand(["--computer", "Studio"])).toEqual({ ok: true, call: { computer: "Studio" }, session: null });
});

test("a capability it does not know, a state that is not on or off, or a lone name is bad usage", () => {
  for (const argv of [["routine", "on"], ["routines", "yes"], ["routines"], ["routines", "on", "--computer"], ["routines", "on", "--force"]]) {
    expect([argv, parseCapabilityCommand(argv).ok]).toEqual([argv, false]);
  }
});

test("help and bad usage start no Inbox: help on stdout with exit 0, bad usage exit 2", async () => {
  let started = 0;
  const out: string[] = [];
  const err: string[] = [];
  const deps = { cwd: "/work/api", env: {}, askAiChild: false, ensureRunning: async () => void started++, out: async (text: string) => void out.push(text), err: (text: string) => void err.push(text) };
  expect(await runInboxCapabilityCommand(["--help"], deps as never)).toBe(0);
  expect(out.join("")).toContain("Turn one on or off when the person asks you to; not on your own initiative.");
  expect(await runInboxCapabilityCommand(["routines", "maybe"], deps as never)).toBe(2);
  expect(err.join("")).toContain(INBOX_CAPABILITY_USAGE.split("\n")[0]!);
  expect(started).toBe(0);
});

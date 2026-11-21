/**
 * OpenCode 2's Inbox reminder on one request (`addInboxReminder`, server.ts).
 * The failures this guards: the line on a request that has no
 * plannotator_inbox (it would name a tool the agent lacks), on a subagent or a
 * title request, twice, or with different bytes from one request to the next
 * (which would move the cached prefix). The real-host proof is
 * inbox-v2.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REMINDER_TEXT, INBOX_REMINDER_TEXT_NO_WAKE } from "@plannotator/shared/inbox/connection";
import { addInboxReminder, openCode2InboxReminder } from "./server";
import { addInboxReminderOpenCode1, inboxReminderAlreadyAdded } from "./inbox";

const agents = async () => [
  { name: "build", mode: "primary" },
  { name: "explore", mode: "subagent" },
] as never;

function request(agent: string, tools: Record<string, unknown> = { plannotator_inbox: {} }, system = "You are OpenCode.") {
  return { agent, tools, system: [{ type: "text" as const, text: system }] };
}

describe("addInboxReminder", () => {
  test("a primary agent's request with the tool gets the line once, composed into the one system part, the same every time", async () => {
    const first = request("build");
    await addInboxReminder(first, agents);
    expect(first.system).toHaveLength(1);
    expect(first.system[0]!.text.split(INBOX_REMINDER_TEXT)).toHaveLength(2);
    const second = request("build");
    await addInboxReminder(second, agents);
    expect(second.system).toEqual(first.system);
    await addInboxReminder(first, agents);
    expect(first.system).toEqual(second.system);
  });

  // The failure: a host without session.prompt registers the tool without the
  // wake, and a line saying "Their reply comes back here" would be untrue there.
  test("a host that cannot deliver a reply as a turn gets the read-it-later wording", async () => {
    expect(openCode2InboxReminder({ session: { prompt: () => undefined } })).toBe(INBOX_REMINDER_TEXT);
    expect(openCode2InboxReminder({ session: {} })).toBe(INBOX_REMINDER_TEXT_NO_WAKE);
    expect(openCode2InboxReminder({})).toBe(INBOX_REMINDER_TEXT_NO_WAKE);
    const event = request("build");
    await addInboxReminder(event, agents, openCode2InboxReminder({}));
    expect(event.system[0]!.text).toContain(INBOX_REMINDER_TEXT_NO_WAKE);
    expect(event.system[0]!.text).not.toContain(INBOX_REMINDER_TEXT);
  });

  // #2194: a config.json without a usable prompts.inbox changes nothing; with one, the person's text replaces the line.
  test("prompts.inbox: unset gives today's bytes on both hosts; set, it replaces the line", async () => {
    const wake = { session: { prompt: () => undefined } };
    for (const config of [{}, { prompts: { review: { denied: "Check." } } }, { prompts: { inbox: { reminder: " ", runtimes: { pi: { reminder: "Pi." } } } } }]) {
      expect(openCode2InboxReminder(wake, config as never)).toBe(INBOX_REMINDER_TEXT);
      expect(openCode2InboxReminder({}, config as never)).toBe(INBOX_REMINDER_TEXT_NO_WAKE);
      const event = request("build");
      await addInboxReminder(event, agents, openCode2InboxReminder(wake, config as never));
      const before = request("build");
      await addInboxReminder(before, agents);
      expect(event.system).toEqual(before.system);
    }
    const custom = { prompts: { inbox: { reminder: "Shared.", runtimes: { opencode: { reminder: "Ask upstream first." } } } } };
    expect(openCode2InboxReminder(wake, custom as never)).toBe("Ask upstream first.");
    expect(openCode2InboxReminder({}, custom as never)).toBe("Ask upstream first.");
    const event = request("build");
    await addInboxReminder(event, agents, openCode2InboxReminder(wake, custom as never));
    expect(event.system[0]!.text).toContain("Ask upstream first.");
    expect(event.system[0]!.text).not.toContain(INBOX_REMINDER_TEXT);
  });

  // A short custom text the prompt already holds elsewhere ("Be concise.") is still added, once, at the end;
  // the built-in line keeps today's rule (found anywhere: not added again).
  test("a short custom text the prompt already contains is added once at the end; the built-in line keeps its check", async () => {
    const custom = "Be concise.";
    const event = request("build", undefined, "You are OpenCode. Be concise.");
    await addInboxReminder(event, agents, custom);
    expect(event.system).toEqual([{ type: "text", text: "You are OpenCode. Be concise.\n\nBe concise." }]);
    await addInboxReminder(event, agents, custom);
    expect(event.system).toEqual([{ type: "text", text: "You are OpenCode. Be concise.\n\nBe concise." }]);
    const next = request("build", undefined, "You are OpenCode. Be concise.");
    await addInboxReminder(next, agents, custom);
    expect(next.system).toEqual(event.system);

    const quoted = request("build", undefined, `You are OpenCode.\n\nNotes: ${INBOX_REMINDER_TEXT}\n\nMore.`);
    const before = JSON.stringify(quoted.system);
    await addInboxReminder(quoted, agents);
    expect(JSON.stringify(quoted.system)).toBe(before);
  });

  test("OpenCode 1: the same rule on the last system part", () => {
    const parts = ["You are OpenCode. Be concise."];
    addInboxReminderOpenCode1(parts, "Be concise.");
    expect(parts).toEqual(["You are OpenCode. Be concise.\n\nBe concise."]);
    addInboxReminderOpenCode1(parts, "Be concise.");
    expect(parts).toEqual(["You are OpenCode. Be concise.\n\nBe concise."]);
    const alone = ["A", "Be concise."];
    addInboxReminderOpenCode1(alone, "Be concise.");
    expect(alone).toEqual(["A", "Be concise."]);
    const quoted = [`You are OpenCode.\n\nNotes: ${INBOX_REMINDER_TEXT_NO_WAKE}\n\nMore.`];
    addInboxReminderOpenCode1(quoted);
    expect(quoted).toEqual([`You are OpenCode.\n\nNotes: ${INBOX_REMINDER_TEXT_NO_WAKE}\n\nMore.`]);
    expect(inboxReminderAlreadyAdded([], "x")).toBe(false);
  });

  test("no line without the tool, for a subagent, or on a title request", async () => {
    for (const event of [request("build", {}), request("explore"), request("build", undefined, "You are a title generator.")]) {
      const before = JSON.stringify(event.system);
      await addInboxReminder(event, agents);
      expect(JSON.stringify(event.system)).toBe(before);
    }
  });
});

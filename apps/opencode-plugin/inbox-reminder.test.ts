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
  test("a host that cannot deliver a reply as a turn gets the wait_for_reply wording", async () => {
    expect(openCode2InboxReminder({ session: { prompt: () => undefined } })).toBe(INBOX_REMINDER_TEXT);
    expect(openCode2InboxReminder({ session: {} })).toBe(INBOX_REMINDER_TEXT_NO_WAKE);
    expect(openCode2InboxReminder({})).toBe(INBOX_REMINDER_TEXT_NO_WAKE);
    const event = request("build");
    await addInboxReminder(event, agents, openCode2InboxReminder({}));
    expect(event.system[0]!.text).toContain(INBOX_REMINDER_TEXT_NO_WAKE);
    expect(event.system[0]!.text).not.toContain(INBOX_REMINDER_TEXT);
  });

  test("no line without the tool, for a subagent, or on a title request", async () => {
    for (const event of [request("build", {}), request("explore"), request("build", undefined, "You are a title generator.")]) {
      const before = JSON.stringify(event.system);
      await addInboxReminder(event, agents);
      expect(JSON.stringify(event.system)).toBe(before);
    }
  });
});

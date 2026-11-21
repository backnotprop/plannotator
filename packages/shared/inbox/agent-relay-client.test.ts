/**
 * A paired cloud agent's call through the relay (agent-relay-client.ts) while the person's computer is asleep: a call
 * that changes something waits at the relay, a read says at once that the computer is asleep. The failure this guards:
 * a read classed as a write by its tool's name (card list, a thread_pulls listing), so the agent gets "queued" and
 * never sees the result it asked for; a routine change classed as a read, so one not answered in time is applied later
 * and the agent's retry makes or runs it twice.
 */
import { describe, expect, test } from "bun:test";
import { callInboxThroughRelay, isInboxAgentWrite } from "./agent-relay-client";

const pairing = {
  device_id: "dev_01K7PAIRINGTEST00000000000",
  token: `tok_${"A".repeat(43)}`,
  secret: "B".repeat(43),
  relay: { url: "https://relay.example", mailbox_id: `mbx_${"C".repeat(22)}` },
};

/** A relay that holds nothing and reports the Inbox offline; it records each command posted. */
function asleepRelay() {
  const posted: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/commands")) {
      posted.push(path);
      return Response.json({ inbox_online: false });
    }
    return Response.json({ items: [], inbox_online: false });
  }) as typeof globalThis.fetch;
  return { fetch, posted };
}

describe("a call while the person's computer is asleep", () => {
  test("is a write or a read by what it does, not only by its tool", () => {
    expect(isInboxAgentWrite("card", { op: "list" })).toBe(false);
    expect(isInboxAgentWrite("card", { op: "create", title: "Fix" })).toBe(true);
    expect(isInboxAgentWrite("card", { op: "move", card_id: "crd_1", column: "done" })).toBe(true);
    expect(isInboxAgentWrite("thread_pulls", { thread_id: "thr_1" })).toBe(false);
    expect(isInboxAgentWrite("thread_pulls", { thread_id: "thr_1", add: [] })).toBe(false);
    expect(isInboxAgentWrite("thread_pulls", { thread_id: "thr_1", add: ["acme/api#1"] })).toBe(true);
    expect(isInboxAgentWrite("thread_pulls", { thread_id: "thr_1", remove: ["all"] })).toBe(true);
    expect(isInboxAgentWrite("send_message", { body: "Hi" })).toBe(true);
    expect(isInboxAgentWrite("read_thread", {})).toBe(false);
    expect(isInboxAgentWrite("search", { query: "x" })).toBe(false);
  });

  test("a routine's create, update, on, off, run and delete are writes; its list and get are reads", () => {
    for (const op of ["create", "update", "on", "off", "run", "delete", undefined, "nonsense"]) expect([op, isInboxAgentWrite("routine", { op, id: "sch_1" })]).toEqual([op, true]);
    for (const op of ["list", "get"]) expect([op, isInboxAgentWrite("routine", { op, id: "sch_1" })]).toEqual([op, false]);
  });

  test("a routine run waits at the relay while the computer is asleep; a routine list says it is asleep", async () => {
    const run = asleepRelay();
    expect([(await callInboxThroughRelay(pairing, "routine", { op: "run", id: "sch_1" }, { fetch: run.fetch })).kind, run.posted.length]).toEqual(["queued", 1]);
    const list = asleepRelay();
    const listed = await callInboxThroughRelay(pairing, "routine", { op: "list" }, { fetch: list.fetch });
    expect([listed.kind, listed.kind === "refused" ? listed.code : null, list.posted.length]).toEqual(["refused", "computer_asleep", 0]);
  });

  test("card list and a thread_pulls listing say the computer is asleep and leave nothing waiting; a card move waits at the relay", async () => {
    for (const [tool, args] of [
      ["card", { op: "list" }],
      ["thread_pulls", { thread_id: "thr_1" }],
    ] as const) {
      const relay = asleepRelay();
      const outcome = await callInboxThroughRelay(pairing, tool, args, { fetch: relay.fetch });
      expect([tool, outcome.kind, outcome.kind === "refused" ? outcome.code : null, relay.posted.length]).toEqual([tool, "refused", "computer_asleep", 0]);
    }
    const relay = asleepRelay();
    const outcome = await callInboxThroughRelay(pairing, "card", { op: "move", card_id: "crd_1", column: "done" }, { fetch: relay.fetch });
    expect([outcome.kind, relay.posted.length]).toEqual(["queued", 1]);
  });
});

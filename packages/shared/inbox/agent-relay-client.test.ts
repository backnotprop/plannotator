/**
 * A paired cloud agent's call through the relay (agent-relay-client.ts) while the person's computer is asleep: a call
 * that changes something waits at the relay, a read says at once that the computer is asleep. The failure this guards:
 * a read classed as a write by its tool's name (card list, a thread_pulls listing), so the agent gets "queued" and
 * never sees the result it asked for; a routine change classed as a read, so one not answered in time is applied later
 * and the agent's retry makes or runs it twice; a result an earlier call left at the relay downloaded again on every
 * poll of every later call, and never cleared, until the first read of each call passes its time limit.
 */
import { describe, expect, test } from "bun:test";
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { callInboxThroughRelay, INBOX_AGENT_STALE_RESULT_MS, isInboxAgentWrite } from "./agent-relay-client";

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
    // A command's window route (inbox rows, projects, icon, export-decisions): a GET reads, a POST changes something.
    expect(isInboxAgentWrite("route", { method: "GET", path: "/api/inbox/projects" })).toBe(false);
    expect(isInboxAgentWrite("route", { method: "POST", path: "/api/inbox/settings", body: { rows: [] } })).toBe(true);
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

describe("results left at the relay by an earlier call", () => {
  /**
   * An online relay holding `left` (results earlier calls never acked), which answers each posted command with its
   * result as the Inbox does, sealed with the computer's clock; it records each GET's `after` and each ack.
   */
  async function onlineRelay(left: { id: string; ageMs: number }[]) {
    const keys = await deriveRelayKeys(pairing.secret, pairing.device_id);
    const seal = async (id: string, at: number) =>
      encryptWithKey(JSON.stringify({ v: 1, type: "result", id, status: 200, content_type: "application/json", body_b64: Buffer.from(`{"id":"${id}"}`).toString("base64"), now: new Date(at).toISOString() }), keys.key);
    let n = 0;
    const items: { n: number; ciphertext: string }[] = [];
    for (const one of left) items.push({ n: ++n, ciphertext: await seal(one.id, Date.now() - one.ageMs) });
    const afters: number[] = [];
    const acked: number[] = [];
    let polls = 0;
    let pending: string | null = null;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/commands")) {
        const { ciphertext } = JSON.parse(String(init!.body)) as { ciphertext: string };
        pending = (JSON.parse(await decryptWithKey(ciphertext, keys.upKey)) as { id: string }).id;
        return Response.json({ inbox_online: true });
      }
      if (path.endsWith("/ack")) {
        const { item } = JSON.parse(String(init!.body)) as { item: number };
        acked.push(item);
        items.splice(items.findIndex((held) => held.n === item), 1);
        return new Response(null, { status: 204 });
      }
      const after = Number(new URL(path).searchParams.get("after"));
      afters.push(after);
      // The answer arrives on the second poll, after the first one found nothing new.
      if (pending && ++polls === 2) items.push({ n: ++n, ciphertext: await seal(pending, Date.now()) });
      return Response.json({ items: items.filter((held) => held.n > after), inbox_online: true });
    }) as typeof globalThis.fetch;
    return { fetch, afters, acked, items };
  }

  test("each poll after the first asks only for items after the highest one read, so a leftover is downloaded once a call", async () => {
    const relay = await onlineRelay([{ id: "cmd_old1", ageMs: 1000 }, { id: "cmd_old2", ageMs: 2000 }]);
    const outcome = await callInboxThroughRelay(pairing, "read_thread", {}, { fetch: relay.fetch, pollMs: 1 });
    expect(outcome.kind).toBe("answer");
    expect(relay.afters).toEqual([0, 2, 2]);
  });

  test("a result no call waits for any more (older than ten minutes) is acked by the next call; a recent one, perhaps another call's, is kept", async () => {
    const relay = await onlineRelay([{ id: "cmd_killed", ageMs: INBOX_AGENT_STALE_RESULT_MS + 60_000 }, { id: "cmd_running", ageMs: 5_000 }]);
    const outcome = await callInboxThroughRelay(pairing, "read_thread", {}, { fetch: relay.fetch, pollMs: 1 });
    expect(outcome.kind).toBe("answer");
    // The stale one, then this call's own answer; the other call's stays held for it.
    expect(relay.acked).toEqual([1, 3]);
    expect(relay.items.map((held) => held.n)).toEqual([2]);
  });
});

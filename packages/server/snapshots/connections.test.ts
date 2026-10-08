import { describe, expect, test } from "bun:test";
import type { PendingSend } from "@plannotator/shared/snapshots/store";
import { Connection, parseHello, type DeliveryEvent } from "./connections";

const TOKEN = "t".repeat(64);

function hello(processId = "p1") {
  const parsed = parseHello({ host: "claude-code", sessionId: "s1", processId, cwd: "/w", project: "w", title: "", lastHumanInputAt: 0, capabilities: { ask: { turn: true } } });
  if (!parsed) throw new Error("hello did not parse");
  return parsed;
}

const SEND: PendingSend = { v: 1, sendId: "hs-0123456789ab", collectionId: "hc-1", host: "claude-code", sessionId: "s1", text: "message", files: [], createdAt: "2026-10-08T00:00:00Z" };

function harness() {
  let clock = 1_000_000;
  const events: DeliveryEvent[] = [];
  const connection = new Connection("c1", hello(), TOKEN, (_c, event) => events.push(event), () => clock);
  const request = (path: string, body: unknown) =>
    connection.handle(new Request(`http://127.0.0.1:4000${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), path.endsWith("/poll") ? "poll" : "event");
  const delivers = async () => {
    const response = await request("/poll", { status: "ready", waitMs: 0 });
    const body = (await response.json()) as { commands: Array<{ type: string; sendId?: string }> };
    return body.commands.filter((command) => command.type === "deliver").map((command) => command.sendId);
  };
  return {
    connection,
    events,
    delivers,
    event: (body: unknown) => request("/event", body),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Connection deliveries", () => {
  test("a send is re-sent until the host takes it, then never again", async () => {
    const h = harness();
    h.connection.queue(SEND);
    expect(await h.delivers()).toEqual([SEND.sendId]);
    expect(await h.delivers()).toEqual([]);
    h.advance(5_001);
    expect(await h.delivers()).toEqual([SEND.sendId]);
    await h.event({ type: "deliver_accepted", sendId: SEND.sendId, queued: true });
    expect(h.events).toEqual([{ type: "accepted", sendId: SEND.sendId, queued: true }]);
    h.advance(60_000);
    expect(await h.delivers()).toEqual([]);
  });

  test("a hello hands an accepted, undelivered send out again, and delivered ends it", async () => {
    const h = harness();
    h.connection.queue(SEND);
    await h.delivers();
    await h.event({ type: "deliver_accepted", sendId: SEND.sendId });
    h.advance(10_000);
    expect(await h.delivers()).toEqual([]);
    // Another process on the session (or the same one, back) said hello.
    h.connection.update(hello("p2"));
    expect(await h.delivers()).toEqual([SEND.sendId]);
    await h.event({ type: "delivered", sendId: SEND.sendId });
    expect(h.events.at(-1)).toEqual({ type: "delivered", sendId: SEND.sendId });
    h.advance(10_000);
    expect(await h.delivers()).toEqual([]);
    expect(h.connection.hasDelivery(SEND.sendId)).toBe(false);
  });
});

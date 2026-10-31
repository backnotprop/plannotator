/**
 * One link's line (inbox-peer-link.ts) against a stand-in for another
 * Inbox's door: a loopback server speaking the door's health, threads and
 * event stream, scripted per test to go silent, replay, refuse or answer
 * late. The real two-Inbox runs are in inbox-machines.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxOutbox } from "./inbox-outbox";
import { PeerLink, type PeerRecord } from "./inbox-peer-link";
import { openTransport } from "./inbox-transport";
import { checkTailnetAddress } from "./inbox-transport-tailnet";

const B = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface DoorScript {
  health?: () => Response;
  /** The event stream: hello's cursor, the records to replay, then what happens. */
  cursor?: number;
  records?: (since: number | null) => number[];
  /** Keep the stream open with heartbeats (default), or go silent after hello. */
  silent?: boolean;
  /** The stream's answer never comes (the machine slept between health and events). */
  eventsHang?: boolean;
  threads?: () => Promise<Response> | Response;
  post?: (route: string, body: any) => Response;
}

function door(script: DoorScript) {
  const stats = { events: 0, threads: 0, posts: [] as string[], lastEventId: [] as (string | null)[] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace("/api/inbox/device/", "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return script.health ? script.health() : Response.json({ ok: true, inbox_id: B, machine_links: 1, version: "test" });
      if (route === "threads") {
        stats.threads += 1;
        return script.threads ? script.threads() : Response.json({ cursor: script.cursor ?? 0, sections: [{ threads: [{ thread_id: "msg_a", project: { id: "prj_a" } }] }], projects: [] });
      }
      if (route === "events") {
        stats.events += 1;
        const since = req.headers.get("last-event-id");
        stats.lastEventId.push(since);
        if (script.eventsHang) return new Promise<Response>(() => {});
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setInterval> | null = null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ cursor: script.cursor ?? 0 })}\n\n`));
            for (const seq of script.records?.(since === null ? null : Number(since)) ?? []) {
              controller.enqueue(encoder.encode(`id: ${seq}\nevent: record\ndata: ${JSON.stringify({ seq, kind: "message" })}\n\n`));
            }
            if (!script.silent) timer = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 50);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (req.method === "POST") {
        stats.posts.push(route);
        return script.post ? script.post(route, await req.json()) : Response.json({ ok: true });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, stats, server };
}

function link(url: string, extra: Partial<ConstructorParameters<typeof PeerLink>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-peer-link-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const outbox = InboxOutbox.open(join(root, "data"));
  const records: PeerRecord[] = [];
  let revoked = 0;
  const peer = new PeerLink({
    link: { id: B, name: "Mini", token: TOKEN, transport: { kind: "tailnet", url }, device_id: null, linked_at: "2026-10-30T00:00:00Z" },
    transport: openTransport({ kind: "tailnet", url }),
    outbox,
    onRecord: (record) => records.push(record),
    onChange: () => {},
    onRevoked: () => void revoked++,
    timings: { silenceMs: 400, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
    ...extra,
  });
  cleanups.push(() => peer.stop());
  return { peer, outbox, records, revoked: () => revoked };
}

async function until(what: string, check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(20);
  }
}

describe("the line", () => {
  test("rule 16: a stream that goes silent is a dead line even with TCP open, and it redials", async () => {
    const d = door({ silent: true });
    const { peer } = link(d.url);
    peer.start();
    await until("online", () => peer.state === "online");
    await until("offline after the silence", () => peer.state === "offline");
    expect(peer.reason).toContain("heartbeat");
    await until("redialled", () => d.stats.events >= 2);
  });

  test("a stream whose answer never comes is a dead line too, and it redials (no hang until TCP gives up)", async () => {
    const d = door({ eventsHang: true });
    const { peer } = link(d.url);
    peer.start();
    await until("offline after the stream's deadline", () => peer.state === "offline");
    expect(peer.reason).toContain("did not answer");
    await until("redialled", () => d.stats.events >= 2);
  });

  test("a new record is live, and a redial resumes from the last record seen (Last-Event-ID)", async () => {
    const d = door({ cursor: 5, silent: true, records: (since) => (since === null ? [6] : []) });
    const { peer, records } = link(d.url);
    peer.start();
    await until("a record", () => records.length >= 1);
    expect(records[0]).toMatchObject({ machine: B, seq: 6, live: true });
    await until("reconnected", () => d.stats.events >= 2);
    expect(d.stats.lastEventId[1]).toBe("6");
  });

  test("rule 21: a record at or before hello's cursor (a catch-up) is never live", async () => {
    const d = door({ cursor: 9, records: () => [8, 9, 10] });
    const { peer, records } = link(d.url);
    peer.start();
    await until("three records", () => records.length === 3);
    expect(records.map((r) => [r.seq, r.live])).toEqual([
      [8, false],
      [9, false],
      [10, true],
    ]);
  });

  test("rule 17: device_revoked stops the link for good and says so", async () => {
    const d = door({ health: () => Response.json({ code: "device_revoked" }, { status: 401 }) });
    const { peer, revoked } = link(d.url);
    peer.start();
    await until("revoked", () => peer.state === "revoked");
    expect(revoked()).toBe(1);
    await Bun.sleep(300);
    expect(d.stats.events).toBe(0);
  });

  test("any other failure retries: a 500 health, then a working one", async () => {
    let fail = 2;
    const d = door({ health: () => (fail-- > 0 ? Response.json({}, { status: 500 }) : Response.json({ inbox_id: B, machine_links: 1 })) });
    const { peer } = link(d.url);
    peer.start();
    await until("online after retries", () => peer.state === "online");
  });

  test("an Inbox too old to link reads needs_update, with its version", async () => {
    const d = door({ health: () => Response.json({ inbox_id: B, version: "0.28.30" }) });
    const { peer } = link(d.url);
    peer.start();
    await until("needs_update", () => peer.state === "needs_update");
    expect(peer.reason).toContain("0.28.30");
  });

  test("a different Inbox at the address is never taken for this machine (rule 19)", async () => {
    const d = door({ health: () => Response.json({ inbox_id: "ibx_01K00000000000000000000009", machine_links: 1 }) });
    const { peer } = link(d.url);
    peer.start();
    await until("offline", () => peer.state === "offline");
    expect(peer.reason).toContain("different Inbox");
    expect(d.stats.events).toBe(0);
  });
});

describe("the list (rule 5)", () => {
  test("a list older than the one held is dropped", () => {
    const { peer } = link("http://127.0.0.1:9");
    expect(peer.acceptList({ cursor: 10, sections: [{ threads: [{ thread_id: "new" }] }] })).toBe(true);
    expect(peer.acceptList({ cursor: 7, sections: [{ threads: [{ thread_id: "old" }] }] })).toBe(false);
    expect(peer.list!.rows.map((r) => [r.thread_id, r.machine])).toEqual([["new", B]]);
  });

  test("one fetch in flight at a time: refreshes during it make one more, never several at once (F5)", async () => {
    let inFlight = 0;
    let most = 0;
    const d = door({
      threads: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await Bun.sleep(60);
        inFlight -= 1;
        return Response.json({ cursor: 1, sections: [] });
      },
    });
    const { peer } = link(d.url);
    (peer as unknown as { running: boolean }).running = true;
    const first = peer.refreshList();
    for (let i = 0; i < 5; i++) void peer.refreshList();
    await first;
    expect(most).toBe(1);
    expect(d.stats.threads).toBe(2);
  });
});

describe("the outbox goes when the machine is there (rule 15)", () => {
  test("a write held while offline is sent on hello, once", async () => {
    const d = door({});
    const { peer, outbox } = link(d.url);
    outbox.submit(B, "messages/msg_x/reply", { idempotency_key: "k1", words: "yes", seen_through_seq: 1 });
    peer.start();
    await until("delivered", () => outbox.get("k1")!.state === "delivered");
    expect(d.stats.posts).toEqual(["messages/msg_x/reply"]);
  });

  test("a 401 device_revoked while sending drops the queue with notices", async () => {
    const d = door({ post: () => Response.json({ code: "device_revoked" }, { status: 401 }) });
    const { peer, outbox } = link(d.url);
    outbox.submit(B, "messages/msg_x/reply", { idempotency_key: "k1", words: "yes", seen_through_seq: 1 });
    outbox.submit(B, "messages/msg_x/reply", { idempotency_key: "k2", words: "and", seen_through_seq: 1 });
    peer.start();
    await until("dropped", () => outbox.get("k2")!.state === "dropped");
    expect(outbox.get("k1")!.notice!.kind).toBe("may_have_been_delivered");
    expect(outbox.get("k2")!.notice!.kind).toBe("not_delivered");
  });
});

describe("the tailnet transport's address", () => {
  test("only a MagicDNS name over https: a code, --address or link-back can never send a secret or token off the tailnet", () => {
    const released = {};
    expect(checkTailnetAddress("mini.tail1234.ts.net:8443", released)).toBe("https://mini.tail1234.ts.net:8443");
    expect(checkTailnetAddress("https://mini.tail1234.ts.net:8443/", released)).toBe("https://mini.tail1234.ts.net:8443");
    for (const elsewhere of [
      "https://evil.example:8443",
      "https://mini.tail1234.ts.net.evil.example",
      "https://ts.net",
      "https://100.101.102.103:8443",
      "https://localhost:8443",
      "https://[::1]:8443",
      "http://mini.tail1234.ts.net:8443",
      "http://127.0.0.1:4100",
      "https://user:pw@mini.tail1234.ts.net",
      "https://mini.tail1234.ts.net/api",
      "",
    ]) {
      expect(checkTailnetAddress(elsewhere, released)).toBeNull();
    }
    // Two Inboxes on one computer stand in for two machines only inside a test sandbox.
    expect(checkTailnetAddress("http://127.0.0.1:4100", { PLANNOTATOR_TEST_SANDBOX: "/tmp/x" })).toBe("http://127.0.0.1:4100");
    expect(checkTailnetAddress("http://192.168.1.4:4100", { PLANNOTATOR_TEST_SANDBOX: "/tmp/x" })).toBeNull();
  });
});

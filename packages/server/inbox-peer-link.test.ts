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
import { INBOX_AGENTS_LISTED_MAX } from "@plannotator/core/inbox-types";
import { PeerLink, readCapped, type PeerRecord } from "./inbox-peer-link";
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
  /** Frames sent right after hello and the records. */
  frames?: string[];
  /** Keep the stream open with heartbeats (default), or go silent after hello. */
  silent?: boolean;
  /** The stream's answer never comes (the machine slept between health and events). */
  eventsHang?: boolean;
  threads?: () => Promise<Response> | Response;
  post?: (route: string, body: any) => Response;
  /** Status frames its windows would hear, sent after hello. */
  statuses?: unknown[];
}

function door(script: DoorScript) {
  const stats = { events: 0, threads: 0, posts: [] as string[], windowMarks: [] as (string | null)[], lastEventId: [] as (string | null)[] };
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
            for (const status of script.statuses ?? []) controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`));
            for (const frame of script.frames ?? []) controller.enqueue(encoder.encode(frame));
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
        stats.windowMarks.push(req.headers.get("x-plannotator-window"));
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
    timings: { silenceMs: 400, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000, deliveriesMs: 30 },
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

  test("Delete on its messages is offered only when its health says its store takes one", async () => {
    // An Inbox from before Delete on a message's words says nothing, and its store refuses the DELETION (422).
    const older = link(door({ health: () => Response.json({ inbox_id: B, machine_links: 1, version: "0.28.51" }) }).url).peer;
    older.start();
    await until("online", () => older.state === "online");
    expect(older.messageDeletions).toBe(false);
    const newer = link(door({ health: () => Response.json({ inbox_id: B, machine_links: 1, version: "0.28.54", message_deletions: 1 }) }).url).peer;
    newer.start();
    await until("online", () => newer.state === "online");
    expect(newer.messageDeletions).toBe(true);
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

describe("an Update pressed there", () => {
  const health = (version: string, more: Record<string, unknown> = {}) => () => Response.json({ ok: true, inbox_id: B, machine_links: 1, machine_update: 1, version, ...more });

  test("it reads what that machine's own health says about its update and its door", async () => {
    const d = door({ health: health("0.28.46", { self_update: false, update: { state: "available", version: "0.28.50", action: "copy", releaseUrl: "https://evil.example" } }) });
    const { peer } = link(d.url);
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.canUpdate).toBe(true);
    expect(peer.selfUpdate).toBe(false);
    expect(peer.farUpdate).toEqual({ state: "available", version: "0.28.50", action: "copy" });
  });

  test("an older Inbox's health names no route: it cannot be updated from here", async () => {
    const d = door({ health: () => Response.json({ ok: true, inbox_id: B, machine_links: 1, version: "0.28.44" }) });
    const { peer } = link(d.url);
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.canUpdate).toBe(false);
  });

  test("back on a new version, the press ends as updated, from what to what", async () => {
    const d = door({ health: health("0.28.50") });
    const { peer } = link(d.url);
    peer.asked = { from: "0.28.46", at: Date.now() };
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.asked).toBeNull();
    expect(peer.updated).toMatchObject({ from: "0.28.46", to: "0.28.50" });
  });

  test("an agent there was asked to update it (an older door): back on a new version, it ends as updated too", async () => {
    const d = door({ health: () => Response.json({ ok: true, inbox_id: B, machine_links: 1, version: "0.28.55" }) });
    const { peer } = link(d.url);
    peer.agentAsked = { from: "0.28.50", at: Date.now(), thread: "thr_1", agent: "Claude Code" };
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.agentAsked).toBeNull();
    expect(peer.updated).toMatchObject({ from: "0.28.50", to: "0.28.55" });
  });

  test("an agent asked there that has not acted yet: back on the same version, the ask stays", async () => {
    const d = door({ health: () => Response.json({ ok: true, inbox_id: B, machine_links: 1, version: "0.28.50" }) });
    const { peer } = link(d.url);
    peer.agentAsked = { from: "0.28.50", at: Date.now(), thread: "thr_1", agent: "Claude Code" };
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.agentAsked).not.toBeNull();
    expect(peer.updated).toBeNull();
  });

  test("back on the same version with nothing running, the press is over: it never claims to be updating", async () => {
    const d = door({ health: health("0.28.46") });
    const { peer } = link(d.url);
    peer.asked = { from: "0.28.46", at: Date.now() };
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.asked).toBeNull();
    expect(peer.updated).toBeNull();
  });

  test("back on the same version while its install runs, the press goes on", async () => {
    const d = door({ health: health("0.28.46", { update: { state: "updating", version: "0.28.50", action: "script" } }) });
    const { peer } = link(d.url);
    peer.asked = { from: "0.28.46", at: Date.now() };
    peer.start();
    await until("online", () => peer.state === "online");
    expect(peer.asked).not.toBeNull();
  });

  test("a status frame saying the install failed ends the press, so a later sleep is not read as restarting", async () => {
    const d = door({ health: health("0.28.46", { update: { state: "updating", version: "0.28.50", action: "script" } }), statuses: [{ update: { state: "failed", version: "0.28.50", action: "script" } }] });
    const { peer } = link(d.url);
    peer.asked = { from: "0.28.46", at: Date.now() };
    peer.start();
    await until("the failed frame", () => peer.farUpdate?.state === "failed");
    expect(peer.asked).toBeNull();
  });

  test("a status frame saying nothing changed ends the press and is kept", async () => {
    const d = door({ health: health("0.28.46", { update: { state: "updating", version: "0.28.50", action: "script" } }), statuses: [{ update: { state: "available", version: "0.28.50", action: "script" }, update_no_change: "0.28.50" }] });
    const { peer } = link(d.url);
    peer.asked = { from: "0.28.46", at: Date.now() };
    peer.start();
    await until("the frame", () => peer.noChange === "0.28.50");
    expect(peer.asked).toBeNull();
  });
});

describe("the list (rule 5)", () => {
  test("that machine's live sessions moved its rows (no record, no cursor): the list is read again, then the windows are told", async () => {
    let told = 0;
    let rowsAtTold = -1;
    const d = door({
      cursor: 3,
      frames: ['event: deliveries\ndata: {"sessions":true}\n\n'],
      threads: () => Response.json({ cursor: 3, sections: [{ threads: [{ thread_id: "msg_a", session_ended: d.stats.threads > 1 }] }] }),
    });
    const { peer } = link(d.url, {
      onDeliveries: (change) => {
        expect(change.sessions).toBe(true);
        told += 1;
        rowsAtTold = d.stats.threads;
      },
    });
    peer.start();
    await until("told", () => told === 1);
    expect(rowsAtTold).toBeGreaterThanOrEqual(2);
    expect(peer.list!.rows[0]).toMatchObject({ thread_id: "msg_a", session_ended: true });
  });

  test("many of those frames read the list once, after they stopped; the windows hear of a session that moved in any of them", async () => {
    const told: boolean[] = [];
    const d = door({
      cursor: 3,
      frames: ['event: deliveries\ndata: {"sessions":true}\n\n', ...Array.from({ length: 5 }, () => "event: deliveries\ndata: {}\n\n")],
      threads: () => Response.json({ cursor: 3, sections: [{ threads: [{ thread_id: "msg_a" }] }] }),
    });
    const { peer } = link(d.url, { onDeliveries: (change) => void told.push(change.sessions) });
    peer.start();
    await until("told", () => told.length >= 1);
    await Bun.sleep(100);
    expect(told).toEqual([true]);
    // The first read of the list, then one for all six frames.
    expect(d.stats.threads).toBe(2);
  });

  test("that machine's Agents moved (no record, no cursor): its list is read again with the new agents, and the windows hear `agents`", async () => {
    const told: { sessions: boolean; agents: boolean }[] = [];
    const agentsAt = (state: string) => [{ agents: [{ id: "ses_1", session: "ses_1", host: "claude-code", project: null, state, waiting: 0, live: true, started_at: null, last_seen_at: null }], total: 1, ended_today: 0 }];
    const d = door({
      cursor: 3,
      frames: ['event: deliveries\ndata: {"agents":true}\n\n'],
      threads: () => Response.json({ cursor: 3, sections: [], agents: agentsAt(d.stats.threads > 1 ? "working" : "idle") }),
    });
    const { peer } = link(d.url, { onDeliveries: (change) => void told.push(change) });
    peer.start();
    await until("told", () => told.length === 1);
    expect(told).toEqual([{ sessions: false, agents: true }]);
    expect(peer.list!.agents).toMatchObject({ machine: B, total: 1, agents: [{ id: "ses_1", state: "working" }] });
  });

  test("a machine's agents are kept capped and named by the machine; an older Inbox's list (no `agents`) names none", () => {
    const { peer } = link("http://127.0.0.1:9");
    peer.acceptList({ cursor: 1, sections: [] });
    expect(peer.list!.agents).toBeNull();
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `ses_${i}`, session: `ses_${i}`, host: "pi", project: null, state: "idle", waiting: 0, live: true, started_at: null, last_seen_at: null }));
    peer.acceptList({ cursor: 1, sections: [], agents: [{ agents: [...many, { id: 1 }, { id: "x", session: "x", state: "asleep" }], total: 302, ended_today: 0 }] });
    expect(peer.list!.agents!.machine).toBe(B);
    expect(peer.list!.agents!.agents.length).toBe(INBOX_AGENTS_LISTED_MAX);
    expect(peer.list!.agents!.total).toBe(302);
  });

  test("a list older than the one held is dropped", () => {
    const { peer } = link("http://127.0.0.1:9");
    expect(peer.acceptList({ cursor: 10, sections: [{ threads: [{ thread_id: "new" }] }] })).toBe(true);
    expect(peer.acceptList({ cursor: 7, sections: [{ threads: [{ thread_id: "old" }] }] })).toBe(false);
    expect(peer.list!.rows.map((r) => [r.thread_id, r.machine])).toEqual([["new", B]]);
  });

  test("a machine keeps snoozes only when its list says so: an older Inbox's list (no `snoozes`) takes no snooze", () => {
    const { peer } = link("http://127.0.0.1:9");
    peer.acceptList({ cursor: 3, sections: [] });
    expect(peer.list!.snoozes).toBe(false);
    peer.acceptList({ cursor: 4, sections: [], snoozes: true });
    expect(peer.list!.snoozes).toBe(true);
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

  test("a write the person pressed in a window says so to the other machine; any other write does not (remote launch)", async () => {
    const d = door({});
    const { peer, outbox } = link(d.url);
    outbox.submit(B, "messages", { idempotency_key: "k-window", body: "Start it", to: { launch: { agent: "claude-code", project_id: "prj_a" } } }, null, true);
    outbox.submit(B, "messages/msg_x/reply", { idempotency_key: "k-script", words: "yes", seen_through_seq: 1 });
    peer.start();
    await until("both delivered", () => outbox.get("k-script")!.state === "delivered");
    expect(d.stats.posts).toEqual(["messages", "messages/msg_x/reply"]);
    expect(d.stats.windowMarks).toEqual(["1", null]);
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

// The near side's own count: a body with no socket under it, so what its stream gives is what the reader takes.
// Over a socket the far side can write more than this, into buffers the reader never drains (inbox-accounts.test.ts).
describe("readCapped", () => {
  const CHUNK = 64 * 1024;
  const CAP = 16 * CHUNK;
  /** A body that never ends, and how much of it was drawn. */
  const endless = () => {
    const seen = { drawn: 0, cancelled: false };
    const chunk = new Uint8Array(CHUNK).fill(32);
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          seen.drawn += CHUNK;
          controller.enqueue(chunk);
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
    );
    return { response, seen };
  };

  test("reads an answer up to the cap whole, and one byte past it not at all", async () => {
    expect(await readCapped(new Response("x".repeat(CAP)), CAP)).toBe("x".repeat(CAP));
    expect(await readCapped(new Response("x".repeat(CAP + 1)), CAP)).toBeNull();
    expect(await readCapped(new Response(null), CAP)).toBe("");
  });

  test("draws no more than the cap and the read that crossed it from a body that never ends, and stops it", async () => {
    const { response, seen } = endless();
    expect(await readCapped(response, CAP)).toBeNull();
    expect(seen.drawn).toBeLessThanOrEqual(CAP + 2 * CHUNK);
    await Bun.sleep(20);
    expect(seen.cancelled).toBe(true);
  });

  test("a 401's look at its code through a clone stops at its own cap, and the answer's read at its cap, as the link reads a refusal", async () => {
    const { response, seen } = endless();
    expect(await readCapped(response.clone(), CHUNK)).toBeNull();
    expect(await readCapped(response, CAP)).toBeNull();
    // The tee under a clone draws one more ahead for the other branch: a fixed few chunks, never the flood.
    expect(seen.drawn).toBeLessThanOrEqual(CAP + 4 * CHUNK);
    await Bun.sleep(20);
    expect(seen.cancelled).toBe(true);
  });
});

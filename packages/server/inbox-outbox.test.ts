/**
 * The outbox's rules (PLAN.md section 12), each against the module alone:
 * a temp data dir, a scripted owner standing in for the other machine's door.
 * The end-to-end runs with real Inboxes are in inbox-machines.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { doorRouteNames, doorWriteRoutes } from "./inbox-devices";
import { outboxView } from "./inbox-machines";
import { classifyAnswer, DOOR_WRITES, doorWriteKind, InboxOutbox, OUTBOX_KEEP_SETTLED_MS, OUTBOX_MAX_SERVER_ERRORS, replyIsStale, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";

const B = "ibx_01K00000000000000000000000";
const C = "ibx_01K00000000000000000000001";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-outbox-"));
  roots.push(root);
  return join(root, "data");
}
const reply = (key: string, words = "yes") => ({ idempotency_key: key, words });
const ok: OutboxAnswer = { status: 200, body: { reply: { id: "msg_x" } } };

/** A scripted owner: answers in turn, and records what it was sent. */
function owner(...answers: OutboxAnswer[]) {
  const sent: string[] = [];
  return {
    sent,
    send: async (entry: OutboxEntry) => {
      sent.push(entry.key);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
  };
}

describe("rule 1: one key from end to end", () => {
  test("a retried Send under the window's key answers the first entry and queues nothing", () => {
    const outbox = InboxOutbox.open(dataDir());
    const first = outbox.submit(B, "messages/m1/reply", reply("k1"));
    const again = outbox.submit(B, "messages/m1/reply", reply("k1", "typed twice"));
    expect(first.fresh).toBe(true);
    expect(again.fresh).toBe(false);
    expect(again.entry.body.words).toBe("yes");
    expect(outbox.list(B)).toHaveLength(1);
    expect(outbox.list(B)[0]!.body.idempotency_key).toBe("k1");
  });

  test("the outcome is kept under the key, a refusal included, and answered again", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    await outbox.drain(B, owner({ status: 409, body: { code: "thread_resolved" } }).send);
    const again = outbox.submit(B, "messages/m1/reply", reply("k1"));
    expect(again.fresh).toBe(false);
    expect(again.entry.state).toBe("refused");
    expect(again.entry.status).toBe(409);
  });

  test("the same key on another route is refused, as the door refuses it", () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    expect(() => outbox.submit(B, "messages/m1/picks", reply("k1"))).toThrow(/another route/);
    expect(() => outbox.submit(C, "messages/m1/reply", reply("k1"))).toThrow(/another route/);
  });

  test("a write with no key is refused before anything is held", () => {
    const outbox = InboxOutbox.open(dataDir());
    expect(() => outbox.submit(B, "messages/m1/reply", { words: "x" })).toThrow(/idempotency_key/);
    expect(outbox.list(B)).toHaveLength(0);
  });
});

describe("the window's view of a held write", () => {
  test("it carries the words (a long reply cut, and said so) and the thread the window named, kept across a restart and never sent on", async () => {
    const dir = dataDir();
    const outbox = InboxOutbox.open(dir);
    outbox.submit(B, "messages/m1/reply", reply("k1", "x".repeat(2_500)), "thr_01K00000000000000000000001");
    outbox.submit(B, "threads/t1/read", { idempotency_key: "k2" });
    const [long, read] = InboxOutbox.open(dir).list(B).map(outboxView);
    expect(long!.words).toBe(`${"x".repeat(2_000)}…`);
    expect(long!.thread).toBe("thr_01K00000000000000000000001");
    expect(read!.words).toBeNull();
    expect(read!.thread).toBeNull();
    const sent: OutboxEntry[] = [];
    await outbox.drain(B, async (entry) => {
      sent.push(entry);
      return ok;
    });
    expect(sent.map((entry) => JSON.stringify(entry.body)).join("")).not.toContain("thr_01K00000000000000000000001");
  });
});

describe("an unlink keeps what was not sent", () => {
  test("the dropped entries keep their words and the machine's name, as notices until dismissed", () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1", "Ship it Thursday"), "thr_01K00000000000000000000001");
    outbox.dropMachine(B, "MacBook");
    const [notice] = outbox.notices().map(outboxView);
    expect(notice).toMatchObject({ state: "dropped", words: "Ship it Thursday", machine_name: "MacBook", notice: { kind: "not_delivered" } });
  });

  test("a drain that meets the other side's Unlink drops first; forgetting the link then names those entries", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1", "Ship it Thursday"));
    outbox.submit(B, "messages/m1/reply", reply("k2", "And the notes"));
    expect(await outbox.drain(B, owner({ status: 401, body: { code: "device_revoked" } }).send)).toBe("revoked");
    expect(outbox.notices().map((entry) => entry.machine_name ?? null)).toEqual([null, null]);
    // The link is forgotten with its name (inbox-machines.ts `forget`).
    outbox.dropMachine(B, "MacBook");
    expect(outbox.notices().map(outboxView).map((view) => [view.words, view.machine_name])).toEqual([
      ["Ship it Thursday", "MacBook"],
      ["And the notes", "MacBook"],
    ]);
  });

  test("what was not sent because the link went stays past the notice keep, until dismissed", () => {
    const dir = dataDir();
    let clock = new Date("2026-10-01T00:00:00Z");
    const outbox = InboxOutbox.open(dir, () => clock);
    outbox.submit(B, "messages/m1/reply", reply("k1", "Ship it Thursday"));
    outbox.dropMachine(B, "MacBook");
    clock = new Date(clock.getTime() + 90 * 24 * 3600_000);
    const reopened = InboxOutbox.open(dir, () => clock);
    expect(reopened.notices().map((entry) => entry.key)).toEqual(["k1"]);
    reopened.dismiss("k1");
    expect(InboxOutbox.open(dir, () => clock).list(B)).toEqual([]);
  });
});

describe("rule 2: one queue per machine, one request at a time", () => {
  test("oldest first; each waits for the one before it to have a definite answer", async () => {
    const outbox = InboxOutbox.open(dataDir());
    for (const key of ["k1", "k2", "k3"]) outbox.submit(B, "messages/m1/reply", reply(key));
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    await outbox.drain(B, async (entry) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Bun.sleep(5);
      order.push(entry.key);
      inFlight -= 1;
      return ok;
    });
    expect(order).toEqual(["k1", "k2", "k3"]);
    expect(most).toBe(1);
  });

  test("an online Send goes through the same queue: it never overtakes a held one (F2)", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("held"));
    // The machine wakes: the first try is in flight when the person sends again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const send = async (entry: OutboxEntry) => {
      if (entry.key === "held") await gate;
      order.push(entry.key);
      return ok;
    };
    const first = outbox.drain(B, send);
    outbox.submit(B, "messages/m1/reply", reply("online"));
    const second = outbox.drain(B, send);
    expect(second).toBe(first);
    release();
    await first;
    expect(order).toEqual(["held", "online"]);
  });

  test("a machine that cannot be reached stops its own queue, not another machine's", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("b1"));
    outbox.submit(B, "messages/m1/reply", reply("b2"));
    outbox.submit(C, "messages/m2/reply", reply("c1"));
    const down = owner(null);
    expect(await outbox.drain(B, down.send)).toBe("unreachable");
    expect(down.sent).toEqual(["b1"]);
    expect(await outbox.drain(C, owner(ok).send)).toBe("empty");
    expect(outbox.get("c1")!.state).toBe("delivered");
    expect(outbox.list(B, "pending").map((e) => e.key)).toEqual(["b1", "b2"]);
  });
});

describe("rule 3: refused answers leave the outbox", () => {
  test("a 4xx ends the entry with a notice and it is never sent again (F3)", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    outbox.submit(B, "messages/m1/reply", reply("k2"));
    const answers = owner({ status: 409, body: { code: "thread_resolved" } }, ok);
    await outbox.drain(B, answers.send);
    await outbox.drain(B, answers.send);
    expect(answers.sent).toEqual(["k1", "k2"]);
    expect(outbox.get("k1")!.state).toBe("refused");
    expect(outbox.notices().map((e) => [e.key, e.notice!.kind])).toEqual([["k1", "refused"]]);
    outbox.dismiss("k1");
    expect(outbox.notices()).toHaveLength(0);
  });
});

describe("rule 4: Unlink and revoke empty the machine's outbox", () => {
  test("never left: not delivered; left: may have been delivered (F4)", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("left"));
    outbox.submit(B, "messages/m1/reply", reply("never"));
    await outbox.drain(B, owner(null).send);
    const dropped = outbox.dropMachine(B);
    expect(dropped.map((e) => [e.key, e.notice!.kind])).toEqual([
      ["left", "may_have_been_delivered"],
      ["never", "not_delivered"],
    ]);
    expect(outbox.list(B, "pending")).toHaveLength(0);
  });

  test("a 401 device_revoked stops the queue and drops every waiting entry", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    outbox.submit(B, "messages/m1/reply", reply("k2"));
    const revoked = owner({ status: 401, body: { code: "device_revoked" } });
    expect(await outbox.drain(B, revoked.send)).toBe("revoked");
    expect(revoked.sent).toEqual(["k1"]);
    expect(outbox.get("k1")!.notice!.kind).toBe("may_have_been_delivered");
    expect(outbox.get("k2")!.notice!.kind).toBe("not_delivered");
  });
});

describe("rule 7: the outbox is written atomically and survives a crash", () => {
  test("a held answer is on disk before submit returns, and reads back after a restart (F7)", () => {
    const dir = dataDir();
    InboxOutbox.open(dir).submit(B, "messages/m1/reply", reply("k1"));
    const reopened = InboxOutbox.open(dir);
    expect(reopened.list(B, "pending").map((e) => e.key)).toEqual(["k1"]);
  });

  test("a torn last line (a crash mid-append) loses only that line", () => {
    const dir = dataDir();
    const outbox = InboxOutbox.open(dir);
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    appendFileSync(join(dir, "inbox", "outbox", `${B}.jsonl`), '{"v":1,"key":"k2","machi');
    const reopened = InboxOutbox.open(dir);
    expect(reopened.list(B).map((e) => e.key)).toEqual(["k1"]);
    reopened.submit(B, "messages/m1/reply", reply("k3"));
    expect(InboxOutbox.open(dir).list(B).map((e) => e.key)).toEqual(["k1", "k3"]);
  });

  test("compaction writes a temp file and renames it; settled entries past their keep go", async () => {
    const dir = dataDir();
    let clock = new Date("2026-10-01T00:00:00Z");
    const outbox = InboxOutbox.open(dir, () => clock);
    outbox.submit(B, "messages/m1/reply", reply("old"));
    await outbox.drain(B, owner(ok).send);
    outbox.submit(B, "messages/m1/reply", reply("waiting"));
    clock = new Date(clock.getTime() + OUTBOX_KEEP_SETTLED_MS + 1000);
    const reopened = InboxOutbox.open(dir, () => clock);
    expect(reopened.list(B).map((e) => e.key)).toEqual(["waiting"]);
    const folder = join(dir, "inbox", "outbox");
    expect(readdirSync(folder)).toEqual([`${B}.jsonl`]);
    expect(readFileSync(join(folder, `${B}.jsonl`), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("rule 10: a request that has left is never reported not sent", () => {
  test("left is on disk before the request goes; an unreachable try stays sending", async () => {
    const dir = dataDir();
    const outbox = InboxOutbox.open(dir);
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    let onDisk: OutboxEntry | null = null;
    await outbox.drain(B, async () => {
      onDisk = InboxOutbox.open(dir).get("k1");
      return null;
    });
    expect(onDisk!.left).toBe(true);
    expect(outbox.get("k1")!.state).toBe("sending");
  });
});

describe("rule 12: Sending until the owner answers", () => {
  test("queued, then sending, then delivered only on the owner's 2xx", async () => {
    const outbox = InboxOutbox.open(dataDir());
    const states: string[] = [];
    outbox.onChange(({ entry }) => states.push(entry.state));
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    await outbox.drain(B, owner({ status: 500, body: {} }).send);
    await outbox.drain(B, owner(ok).send);
    expect(states).toEqual(["queued", "sending", "sending", "delivered"]);
  });

  test("waitSettled answers at once when the owner does, and gives up after its time otherwise", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    const quick = outbox.waitSettled("k1", 1000);
    void outbox.drain(B, owner(ok).send);
    expect((await quick)!.state).toBe("delivered");
    outbox.submit(B, "messages/m1/reply", reply("k2"));
    expect((await outbox.waitSettled("k2", 20))!.state).toBe("queued");
  });
});

describe("rule 17 and the 5xx bound", () => {
  test("only a revoked or unknown token stops a link; everything else is a refusal or a retry", () => {
    expect(classifyAnswer(ok)).toBe("delivered");
    expect(classifyAnswer({ status: 201, body: {} })).toBe("delivered");
    expect(classifyAnswer({ status: 401, body: { code: "device_revoked" } })).toBe("revoked");
    expect(classifyAnswer({ status: 401, body: { code: "device_token_invalid" } })).toBe("revoked");
    expect(classifyAnswer({ status: 401, body: { code: "something_else" } })).toBe("retry");
    expect(classifyAnswer({ status: 409, body: { code: "question_revision_conflict" } })).toBe("refused");
    expect(classifyAnswer({ status: 404, body: { code: "message_not_found" } })).toBe("refused");
    expect(classifyAnswer({ status: 422, body: { code: "validation_error" } })).toBe("refused");
    expect(classifyAnswer({ status: 408, body: {} })).toBe("retry");
    expect(classifyAnswer({ status: 429, body: {} })).toBe("retry");
    expect(classifyAnswer({ status: 500, body: {} })).toBe("retry");
    expect(classifyAnswer(null)).toBe("retry");
  });

  test("a write the owner keeps failing with 5xx is parked, and the queue moves on", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("poison"));
    outbox.submit(B, "messages/m1/reply", reply("next"));
    const broken = owner({ status: 500, body: { code: "internal_error" } });
    for (let i = 1; i < OUTBOX_MAX_SERVER_ERRORS; i++) expect(await outbox.drain(B, broken.send)).toBe("server_error");
    expect(outbox.get("next")!.state).toBe("queued");
    const answers = owner({ status: 500, body: {} }, ok);
    expect(await outbox.drain(B, answers.send)).toBe("empty");
    expect(outbox.get("poison")!.state).toBe("parked");
    expect(outbox.get("poison")!.notice!.kind).toBe("may_have_been_delivered");
    expect(outbox.get("next")!.state).toBe("delivered");
  });

  test("a proxy's 502, 503 or 504 (the owner never got it) is not counted: such a write is never parked as maybe delivered", async () => {
    const outbox = InboxOutbox.open(dataDir());
    outbox.submit(B, "messages/m1/reply", reply("k1"));
    for (const status of [502, 503, 504, 502, 503, 504, 502]) {
      expect(await outbox.drain(B, owner({ status, body: {} }).send)).toBe("unreachable");
    }
    expect(outbox.get("k1")).toMatchObject({ state: "sending", errors: 0, notice: null });
    expect(await outbox.drain(B, owner(ok).send)).toBe("empty");
    expect(outbox.get("k1")!.state).toBe("delivered");
  });
});

describe("rule 11: late words are refused by what the person saw", () => {
  const message = (id: string, kind: "agent" | "person") =>
    ({ id, author: kind === "agent" ? { kind, host: null, session: null, name: null } : { kind } }) as InboxMessage;
  const seq: Record<string, number> = { m1: 3, m2: 5, r1: 7 };
  test("an agent message after the seen seq makes the reply stale; the person's own do not", () => {
    const thread = [message("m1", "agent"), message("m2", "agent"), message("r1", "person")];
    expect(replyIsStale(thread, 5, (id) => seq[id] ?? null)).toBe(false);
    expect(replyIsStale(thread, 4, (id) => seq[id] ?? null)).toBe(true);
  });
});

describe("rule 8: every door write is classified, and only small JSON is held", () => {
  /** The door's POST routes in words, each `(a|b|c)` of plain words split into one name per word. */
  const doorWrites = () =>
    doorRouteNames()
      .filter((name) => name.startsWith("POST "))
      .flatMap((name) => {
        const words = /\(([a-z-]+(?:\|[a-z-]+)+)\)/.exec(name);
        return words ? words[1]!.split("|").map((word) => name.replace(words[0]!, word)) : [name];
      });

  test("each door write says why a second copy is safe: the store's key, or a state; a new route fails here", () => {
    expect(doorWrites().filter((name) => !(name in DOOR_WRITES))).toEqual([]);
    expect(Object.keys(DOOR_WRITES).filter((name) => !doorWrites().includes(name))).toEqual([]);
  });

  test("the door's file routes are exactly the ones never held", () => {
    const files = Object.entries(DOOR_WRITES)
      .filter(([, kind]) => kind === "file")
      .map(([name]) => name);
    const raw = doorWriteRoutes()
      .filter((route) => route.raw)
      .map((route) => `POST ${route.route.replace(/^\^|\$$/g, "")}`);
    expect(files.sort()).toEqual(raw.sort());
  });

  test("the forward holds or passes a write by its route in this table, never by its Content-Type; an unclassified route has no kind", () => {
    expect(doorWriteKind("messages/msg_1/reply")).toBe("append");
    expect(doorWriteKind("messages")).toBe("append");
    expect(doorWriteKind("threads/msg_1/read")).toBe("set");
    expect(doorWriteKind("messages/msg_1/actions/a-0123abcd-2")).toBe("set");
    expect(doorWriteKind("messages/msg_1/guide/annotations")).toBe("set");
    expect(doorWriteKind("uploads")).toBe("file");
    expect(doorWriteKind("markups")).toBe("file");
    expect(doorWriteKind("messages/msg_1/reply/extra")).toBeNull();
    expect(doorWriteKind("messages/msg_1/actions/not-an-action")).toBeNull();
    expect(doorWriteKind("settings")).toBeNull();
  });

  test("an Inbox that never holds a write keeps no outbox folder", () => {
    const dir = dataDir();
    InboxOutbox.open(dir);
    expect(existsSync(join(dir, "inbox", "outbox"))).toBe(false);
  });

  test("a body too large to hold is refused before anything is written", () => {
    const outbox = InboxOutbox.open(dataDir());
    expect(() => outbox.submit(B, "messages/m1/reply", { idempotency_key: "big", words: "x".repeat(300 * 1024) })).toThrow(/at most/);
    expect(outbox.list(B)).toHaveLength(0);
  });
});

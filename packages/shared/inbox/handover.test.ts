import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { inboxClaimName } from "./connection";
import { INBOX_ASK_HOLD_MS } from "./handover";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_a", name: null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-handover-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-12T09:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "CSV or Parquet?", wakes: true }).message;
  const reply = (words: string, key: string) => store.sendReply(asked.id, { words, idempotency_key: key }).reply!;
  const refusal = (id: string) => {
    try {
      store.takeBack(id);
      return null;
    } catch (error) {
      return { code: (error as { code: string }).code, by: (error as { details: { by?: string } }).details.by ?? null };
    }
  };
  return { store, clock, project, asked, reply, refusal };
}

describe("take back and the one hand-over step", () => {
  test("a waiting reply leaves the queue, Send now is refused, another agent's read passes it, and a second press changes nothing", () => {
    const { store, asked, reply, refusal } = setup();
    const first = reply("Parquet.", "k1");
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([first.id]);
    expect(refusal(first.id)).toBeNull();
    expect(store.pendingReplies("ses_a")).toEqual([]);
    expect(() => store.requestDeliverNow(first.id)).toThrow("taken back");
    store.markAgentChecked(asked.thread_id, Number.POSITIVE_INFINITY, undefined, "ses_b");
    expect(store.message(asked.thread_id)!.agent_checked_seq).toBe(store.messageCursor(first.id));
    const lines = store.cursor();
    expect(store.takeBack(first.id).taken_back_at).toBeTruthy();
    expect(store.cursor()).toBe(lines);
  });

  test("once delivered, or read by an agent, it is refused and stays as it is", () => {
    const { store, reply, refusal } = setup();
    const delivered = reply("Parquet.", "k1");
    store.recordDelivery(delivered.id, { host: "pi", session: "ses_a" });
    expect(refusal(delivered.id)).toEqual({ code: "agent_has_it", by: "delivered" });
    const read = reply("And gzip.", "k2");
    store.handover.read([read.id], "ses_b");
    expect(refusal(read.id)).toEqual({ code: "agent_has_it", by: "read" });
    expect(store.message(read.id)!.taken_back_at ?? null).toBeNull();
  });

  test("a connection's last ask holds what it listed until it claims one of them, and at most 10 s", () => {
    const { store, clock, reply, refusal } = setup();
    const a = reply("Parquet.", "k1");
    const b = reply("And gzip.", "k2");
    store.handover.asked([a, b], "ses_a");
    expect(refusal(b.id)).toEqual({ code: "agent_has_it", by: "handing" });
    mkdirSync(join(store.dir, "claims", inboxClaimName(a.id, "ses_a")), { recursive: true });
    expect(refusal(a.id)).toEqual({ code: "agent_has_it", by: "handed" });
    expect(refusal(b.id)).toBeNull();
    const c = reply("Snappy, sorry.", "k3");
    store.handover.asked([c], "ses_a");
    clock.now += INBOX_ASK_HOLD_MS - 1;
    expect(refusal(c.id)?.by).toBe("handing");
    clock.now += 1;
    expect(refusal(c.id)).toBeNull();
  });

  test("a wake's hand holds it until it gives it back, and never hands what was taken back", () => {
    const { store, reply, refusal } = setup();
    const a = reply("Parquet.", "k1");
    expect(store.handover.hand(a, "ses_a", "codex")).toBe(true);
    expect(refusal(a.id)).toEqual({ code: "agent_has_it", by: "handed" });
    store.handover.giveBack(a.id, "ses_a");
    expect(refusal(a.id)).toBeNull();
    expect(store.handover.hand(a, "ses_a", "codex")).toBe(false);
  });

  test("only the person's own words and files: not answers, not a launch, not a thread's first message while more follow", () => {
    const { store, project, asked, refusal } = setup();
    const question = store.sendMessage({ project_id: project.id, author: AGENT, body: ":::question\nWhich?\n\n- [ ] A\n- [ ] B\n:::", wakes: true, reply_to: asked.id }).message;
    const q = store.questionsOf(question.id)[0]!;
    store.savePicks(question.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["A"] } }]);
    const answered = store.sendReply(question.id, { idempotency_key: "k9", questions: [{ key: q.key, revision: 1 }] }).reply!;
    expect(refusal(answered.id)?.code).toBe("cannot_take_back");
    const started = store.startPersonThread({ project_id: project.id, body: "Rename the ledger.", to: { host: "pi", session: "ses_b" }, idempotency_key: "k10" }).message;
    const more = store.sendNewMessage(started.thread_id, { body: "And the CLI.", to: { host: "pi", session: "ses_b" }, idempotency_key: "k11" }).message;
    expect(refusal(started.id)?.code).toBe("cannot_take_back");
    expect(refusal(more.id)).toBeNull();
    expect(refusal(started.id)).toBeNull();
  });
});

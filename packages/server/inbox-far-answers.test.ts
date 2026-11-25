/**
 * An agent's answer in another computer's thread, and a tag the phone sends (inbox-mcp-far-reply.ts,
 * inbox-far-tags.ts, inbox-far-wakes.ts), with this computer's real outbox and wakes in temp folders. What regresses:
 * a second session's answer swallowed by the first one's under the same key; an answer held for an older computer
 * that will only refuse it; a held answer refused later with nobody told; a tag from the phone (no computer named)
 * refused as "not live"; a tag refused because the other computer restarted since `@` opened; old wakes kept for ever.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxFarTags, TAG_ACROSS_MARK } from "./inbox-far-tags";
import { createInboxFarWakes } from "./inbox-far-wakes";
import { farAgentReply, type FarReplyDeps } from "./inbox-mcp-far-reply";
import { InboxOutbox, OUTBOX_KEEP_NOTICE_MS, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";
import type { PeerLink } from "./inbox-peer-link";

const id = (kind: string, last: string) => `${kind}_01JZ${"0".repeat(20)}${last}`;
const STUDIO = id("ibx", "S1");
const LAPTOP = id("ibx", "A1");
const OTHER = id("ibx", "B1");
const THREAD = id("msg", "00");
const temp = (name: string) => mkdtempSync(join(tmpdir(), `plannotator-far-answers-${name}-`));
const next = async () => "NEXT";

/** This computer (the agent's) with its real outbox; `answer` is the thread's computer's door. */
function laptop(answer: (entry: OutboxEntry) => OutboxAnswer, more: Partial<FarReplyDeps> = {}) {
  const outbox = InboxOutbox.open(temp("laptop"));
  const sent: OutboxEntry[] = [];
  const state = { online: true };
  const deps: FarReplyDeps = {
    placeOf: async (msg) => (msg === THREAD ? { machine: STUDIO, thread_id: THREAD } : null),
    nameOf: () => "Studio",
    takes: () => true,
    holdWrite: (machine, route, body, thread, waitMs, own = {}) => {
      const { entry } = outbox.submit(machine, route, body, thread, false, null, true, own);
      if (!state.online) return outbox.waitSettled(entry.key, 0);
      return outbox.drain(machine, async (e) => (sent.push(e), answer(e))).then(() => outbox.waitSettled(entry.key, waitMs));
    },
    heldWrite: (key) => outbox.get(key),
    dismissHeld: (key) => void outbox.dismiss(key),
    readFiles: async () => [],
    holdFiles: async () => [],
    ...more,
  };
  return { outbox, sent, state, deps };
}

/** The thread's computer writes each answer it is sent, and says which words it wrote. */
const writes = (entry: OutboxEntry): OutboxAnswer => ({ status: 200, body: { text: `Wrote: ${(entry.body.args as { body: string }).body}`, structured: {} } });

describe("an agent's answer in another computer's thread", () => {
  test("two sessions that both use one key both get there; a session's retry is the same send; its key for other words is refused", async () => {
    const { deps, sent } = laptop(writes);
    const one = await farAgentReply(deps, { body: "The order holds.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "reply-1" }, next, undefined);
    const two = await farAgentReply(deps, { body: "I checked the retries too.", reply_to: THREAD, agent_session: "ses_two", idempotency_key: "reply-1" }, next, undefined);
    expect(one!.text).toBe("Wrote: The order holds.");
    expect(two!.text).toBe("Wrote: I checked the retries too.");
    expect(sent).toHaveLength(2);
    // The thread's computer keeps keys per project: each session's is its own there too.
    const keys = sent.map((e) => (e.body.args as { idempotency_key: string }).idempotency_key);
    expect(new Set(keys).size).toBe(2);
    // The same session again with the same words: the first send's answer, nothing sent again.
    const again = await farAgentReply(deps, { body: "The order holds.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "reply-1" }, next, undefined);
    expect(again!.text).toBe("Wrote: The order holds.");
    expect(sent).toHaveLength(2);
    await expect(farAgentReply(deps, { body: "Something else.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "reply-1" }, next, undefined)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(sent).toHaveLength(2);
  });

  test("a session's key reused with the same words but another argument is refused, as a local send refuses it", async () => {
    const { deps, sent } = laptop(writes);
    const first = { body: "Both fixed.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "reply-2", done: [`${THREAD}/fix-a`] };
    await farAgentReply(deps, first, next, undefined);
    expect(sent).toHaveLength(1);
    // The same done id with a space before it is the same call (the store trims it).
    await farAgentReply(deps, { ...first, done: [` ${THREAD}/fix-a`] }, next, undefined);
    expect(sent).toHaveLength(1);
    await expect(farAgentReply(deps, { ...first, done: [`${THREAD}/fix-a`, `${THREAD}/fix-b`] }, next, undefined)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(farAgentReply(deps, { ...first, done: undefined }, next, undefined)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(farAgentReply(deps, { ...first, supersedes: [`${THREAD}/q1`] }, next, undefined)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(farAgentReply(deps, { ...first, thread: "Another name" }, next, undefined)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(sent).toHaveLength(1);
  });

  test("an older Plannotator there is refused as before, nothing held; one whose list this Inbox has not read yet is held", async () => {
    const older = laptop(writes, { takes: () => false });
    await expect(farAgentReply(older.deps, { body: "x", reply_to: THREAD, agent_session: "ses_one" }, next, undefined)).rejects.toMatchObject({ code: "thread_on_other_machine" });
    expect(older.outbox.list(STUDIO)).toEqual([]);
    const unknown = laptop(writes, { takes: () => null });
    unknown.state.online = false;
    const held = await farAgentReply(unknown.deps, { body: "x", reply_to: THREAD, agent_session: "ses_one" }, next, undefined);
    expect(held!.structured).toMatchObject({ held: true });
  });

  test("held while the thread's computer was away and refused there later: the window is told; refused while the agent waited: it is not", async () => {
    const refuses = (): OutboxAnswer => ({ status: 404, body: { code: "message_not_found", error: "No message." } });
    const { deps, outbox, state } = laptop(refuses);
    state.online = false;
    const held = await farAgentReply(deps, { body: "Held words.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "k-held" }, next, undefined);
    expect(held!.structured).toMatchObject({ held: true });
    // Waiting, it is not the person's write: not listed, no notice.
    expect(outbox.notices()).toEqual([]);
    await outbox.drain(STUDIO, async () => refuses());
    expect(outbox.notices()).toEqual([expect.objectContaining({ state: "refused", thread: THREAD, notice: expect.objectContaining({ kind: "refused" }) })]);
    // The agent itself told at once: nothing for the window.
    const told = laptop(refuses);
    await expect(farAgentReply(told.deps, { body: "x", reply_to: THREAD, agent_session: "ses_one" }, next, undefined)).rejects.toMatchObject({ code: "message_not_found" });
    expect(told.outbox.notices()).toEqual([]);
  });
});

/** A linked computer's line, its agents read through its door. */
function peer(machine: string, sessions: () => string[]) {
  let reads = 0;
  const link = {
    id: machine,
    state: "online",
    list: { marks: [TAG_ACROSS_MARK] },
    request: async () => {
      reads += 1;
      return Response.json({ sessions: sessions().map((session) => ({ session, host: "claude-code", kind: "live", last_at: "2026-11-24T09:00:00.000Z", taggable: true })) });
    },
  } as unknown as PeerLink;
  return { link, reads: () => reads };
}

function studio(peers: PeerLink[]) {
  const store = InboxStore.open(temp("studio"));
  const far = createInboxFarTags({
    store,
    selfId: () => STUDIO,
    selfName: () => "Studio",
    peers: () => peers,
    nameOf: () => "Laptop",
    holdWrite: () => null,
    heldWrite: () => null,
    commandFor: () => {
      throw new Error("not used");
    },
    sendAs: async () => ({ text: "", structured: {} }),
    ownSession: (session) => session === "ses_here",
  });
  return far;
}

describe("a tag sent to the thread's computer", () => {
  test("from the phone, naming no computer: the one linked computer that lists the session is its computer", async () => {
    const a = peer(LAPTOP, () => ["ses_far"]);
    const far = studio([a.link]);
    await far.rows(THREAD, null, new Set());
    const local = (value: unknown) => (value as { session: string }[]).map((t) => ({ host: "pi", session: t.session, wakes: true }));
    expect(far.targets([{ host: "claude-code", session: "ses_far", label: "Claude Code (Laptop)" }, { session: "ses_here" }], local)).toEqual([
      { host: "claude-code", session: "ses_far", label: "Claude Code (Laptop)", wakes: true, machine: LAPTOP },
      { host: "pi", session: "ses_here", wakes: true },
    ]);
  });

  test("a session two computers list, or one of this computer's own, stays this computer's to resolve", async () => {
    const a = peer(LAPTOP, () => ["ses_both", "ses_here"]);
    const b = peer(OTHER, () => ["ses_both"]);
    const far = studio([a.link, b.link]);
    await far.rows(THREAD, null, new Set());
    const seen: unknown[] = [];
    far.targets([{ session: "ses_both" }, { session: "ses_here" }], (value) => (seen.push(value), []));
    expect(seen).toEqual([[{ session: "ses_both" }, { session: "ses_here" }]]);
  });

  test("the other computer restarted since `@` opened: its agents are read once more before a tag is refused", async () => {
    const a = peer(LAPTOP, () => ["ses_far"]);
    // This Inbox never read them (it restarted too): the tag names the computer, or none at all.
    const named = studio([a.link]);
    expect(() => named.targets([{ session: "ses_far", machine: LAPTOP }], () => [])).toThrow(expect.objectContaining({ code: "session_not_live" }));
    await named.prepare([{ session: "ses_far", machine: LAPTOP }]);
    expect(named.targets([{ session: "ses_far", machine: LAPTOP }], () => [])).toEqual([{ host: "claude-code", session: "ses_far", wakes: true, machine: LAPTOP }]);
    const bare = studio([a.link]);
    await bare.prepare([{ session: "ses_far" }]);
    expect(bare.targets([{ session: "ses_far" }], () => [])).toEqual([expect.objectContaining({ session: "ses_far", machine: LAPTOP })]);
    // A session it already lists, or this computer's own, is not read again.
    const reads = a.reads();
    await bare.prepare([{ session: "ses_far" }, { session: "ses_here" }]);
    expect(a.reads()).toBe(reads);
  });
});

describe("the wakes this computer was handed", () => {
  test("at open, a wake no session took within the outbox's keep goes, a newer one stays, and the file keeps one line per wake", () => {
    const dir = temp("wakes");
    const start = Date.parse("2026-11-01T09:00:00.000Z");
    let at = start;
    const wakes = createInboxFarWakes({ dataDir: dir, now: () => new Date(at) });
    const wake = (n: number) => ({ reply_id: id("msg", `1${n}`), thread_id: THREAD, session: "ses_far", host: "claude-code", command: { type: "reply", id: id("msg", `1${n}`), thread_id: THREAD, reply_to: null, subject: null, body: "B" } });
    wakes.receive(STUDIO, wake(1), () => "u");
    // A Send now's newer wake replaces it: two lines, one wake.
    wakes.receive(STUDIO, { ...wake(1), replaces: true }, () => "u");
    at = start + OUTBOX_KEEP_NOTICE_MS - 60_000;
    wakes.receive(STUDIO, wake(2), () => "u");
    const file = join(dir, "inbox", "far-wakes.jsonl");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    at = start + OUTBOX_KEEP_NOTICE_MS + 60_000;
    const reopened = createInboxFarWakes({ dataDir: dir, now: () => new Date(at) });
    expect(reopened.pendingFor("ses_far").map((w) => w.reply_id)).toEqual([id("msg", "12")]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    // A torn line does not stop the next open.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,`);
    expect(createInboxFarWakes({ dataDir: dir, now: () => new Date(at) }).pendingFor("ses_far")).toHaveLength(1);
  });
});

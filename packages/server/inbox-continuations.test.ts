/**
 * A conversation that goes on under a new session id still gets its replies
 * (inbox-continuations.ts). The failures these guard: a reply written while
 * the old id is gone waiting on it for good; the same reply handed twice (to
 * two branches, or again after it was delivered); a session that still polls
 * losing its replies to a branch of it; a branch reaching past a nearer live
 * session; the thread reading "Session ended" while its conversation goes on.
 *
 * The rules on a fake liveness, then the live sessions over a real store in a
 * temp folder: no server, no Inbox process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { INBOX_CONTINUES_POLL_FIELD, INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxContinuations, INBOX_CONTINUES_MAX, parseInboxContinues } from "./inbox-continuations";
import { createInboxLiveSessions, INBOX_ASKER_RESTART_GRACE_MS } from "./inbox-sessions";

describe("which session stands in for which", () => {
  const world = () => {
    const alive = new Set<string>();
    return { alive, c: createInboxContinuations({ isLive: (session) => alive.has(session) }) };
  };

  test("a live branch stands in for the session it continues once that one is gone, and gives it back when it polls again", () => {
    const { alive, c } = world();
    alive.add("old").add("new");
    c.claim("new", ["old"]);
    // Both go on (a fork): the old session keeps its own.
    expect(c.inheritedBy("new")).toEqual([]);
    expect(c.heirOf("old")).toBeNull();
    alive.delete("old");
    expect(c.inheritedBy("new")).toEqual(["old"]);
    expect(c.heirOf("old")).toBe("new");
    alive.add("old");
    expect(c.inheritedBy("new")).toEqual([]);
    expect(c.heirOf("old")).toBeNull();
  });

  test("a branch that is gone itself stands in for nothing", () => {
    const { c } = world();
    c.claim("new", ["old"]);
    expect(c.inheritedBy("new")).toEqual([]);
    expect(c.heirOf("old")).toBeNull();
  });

  test("two branches of one gone session: one of them holds it, and the other takes it only when the first is gone", () => {
    const { alive, c } = world();
    alive.add("b").add("c");
    c.claim("b", ["a"]);
    c.claim("c", ["a"]);
    // Whoever is asked first, the first to claim holds it.
    expect(c.inheritedBy("c")).toEqual([]);
    expect(c.inheritedBy("b")).toEqual(["a"]);
    expect(c.heirOf("a")).toBe("b");
    alive.delete("b");
    expect(c.inheritedBy("c")).toEqual(["a"]);
    // The first is back: the holder stays, so nothing is handed twice.
    alive.add("b");
    expect(c.inheritedBy("b")).toEqual([]);
    expect(c.heirOf("a")).toBe("c");
  });

  test("a line of branches: everything behind the nearest live session is that session's, not a later branch's", () => {
    const { alive, c } = world();
    alive.add("b").add("c");
    c.claim("b", ["a"]);
    c.claim("c", ["b"]);
    expect(c.lineOf("c")).toEqual(["b", "a"]);
    expect(c.inheritedBy("c")).toEqual([]);
    expect(c.inheritedBy("b")).toEqual(["a"]);
    alive.delete("b");
    expect(c.inheritedBy("c")).toEqual(["b", "a"]);
    expect(c.heirOf("a")).toBe("c");
  });

  test("a claim lasts as long as its session says it: a poll without it withdraws it", () => {
    const { alive, c } = world();
    alive.add("new");
    c.claim("new", ["old"]);
    expect(c.heirOf("old")).toBe("new");
    c.claim("new", []);
    expect(c.heirOf("old")).toBeNull();
    expect(c.claimed()).toEqual([]);
  });

  test("two sessions naming each other never loop", () => {
    const { alive, c } = world();
    alive.add("a");
    c.claim("a", ["b"]);
    c.claim("b", ["a"]);
    expect(c.lineOf("a")).toEqual(["b"]);
    expect(c.inheritedBy("a")).toEqual(["b"]);
  });

  test("the poll field: one id or a list, never the session itself, never more than the limit, nothing else", () => {
    expect(parseInboxContinues("old", "new")).toEqual(["old"]);
    expect(parseInboxContinues([" old ", "old", "new", "", 4, "older"], "new")).toEqual(["old", "older"]);
    expect(parseInboxContinues({ session: "old" }, "new")).toEqual([]);
    expect(parseInboxContinues(undefined, "new")).toEqual([]);
    expect(parseInboxContinues("x".repeat(201), "new")).toEqual([]);
    expect(parseInboxContinues(Array.from({ length: 20 }, (_, i) => `s${i}`), "new")).toHaveLength(INBOX_CONTINUES_MAX);
  });
});

describe("the live sessions over a store", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const OLD: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses-old", name: "Claude Code" };
  const GONE_MS = INBOX_ASKER_RESTART_GRACE_MS + INBOX_SESSION_LIVE_MS + 1;

  function world() {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-continues-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    let now = 1_000_000;
    const live = createInboxLiveSessions({ store, serverSession: "s", resolveRoot: async (path) => path, now: () => now });
    const project = store.ensureProject({ name: "app", root: "/work/app" });
    const asked = store.sendMessage({ project_id: project.id, author: OLD, body: "Which target?", subject: "Target", wakes: true }).message;
    let key = 0;
    const personReplies = (words: string) => store.sendReply(asked.id, { words, idempotency_key: `k${(key += 1)}` }).reply;
    /** One poll that answers at once: the session is live for the live window after it. */
    const poll = async (session: string, continues?: string | string[]) => {
      (await live.pollStarted(session, "claude-code", continues === undefined ? {} : { [INBOX_CONTINUES_POLL_FIELD]: continues }))();
      return live.pendingOf(session).map((item) => ({ id: item.message.id, as: item.as }));
    };
    /** What the bridge's `delivered` event does. */
    const delivered = (session: string, id: string) => store.recordDelivery(id, { host: "claude-code", session: live.actingFor(session, id) });
    return { store, live, asked, personReplies, poll, delivered, pass: (ms: number) => void (now += ms) };
  }

  test("a reply written after the conversation moved to a new session id is handed to it, without the agent writing first, and exactly once", async () => {
    const { store, live, asked, personReplies, poll, delivered, pass } = world();
    await poll("ses-old");
    pass(GONE_MS);
    // The old id is gone and nobody continues it yet: the thread reads as ended.
    expect(live.askerLive("ses-old")).toBe(false);
    const first = personReplies("Go with ARM.");
    const second = personReplies("And keep x86 for the nightly.");

    // The new session never wrote in the thread: its transcript names the old one.
    expect(await poll("ses-new", ["ses-old"])).toEqual([
      { id: first.id, as: "ses-old" },
      { id: second.id, as: "ses-old" },
    ]);
    // The thread's session reads as there again, and connected as the new one is.
    expect(live.askerLive("ses-old")).toBe(true);
    expect(live.connectionOf("ses-old")).not.toBeNull();
    expect(live.deliveryConnectionOf("ses-old")).not.toBeNull();

    expect(delivered("ses-new", first.id).delivery).toMatchObject({ state: "delivered", session: "ses-old" });
    expect(await poll("ses-new", ["ses-old"])).toEqual([{ id: second.id, as: "ses-old" }]);
    delivered("ses-new", second.id);
    expect(await poll("ses-new", ["ses-old"])).toEqual([]);
    // A second `delivered` for the same reply changes nothing.
    expect(delivered("ses-new", first.id).delivery?.at).toBe(store.message(first.id)!.delivery!.at);
    expect(store.pendingReplies("ses-old")).toEqual([]);
    expect(store.threadOwner(asked.thread_id)?.session).toBe("ses-old");
  });

  test("a session that never said it continues another gets nothing of that one's", async () => {
    const { personReplies, poll, live, pass } = world();
    pass(GONE_MS);
    const reply = personReplies("Go with ARM.");
    expect(await poll("ses-stranger")).toEqual([]);
    expect(live.actingFor("ses-stranger", reply.id)).toBe("ses-stranger");
    expect(live.askerLive("ses-old")).toBe(false);
  });

  test("a fork where both go on: the old session keeps its replies, and the branch gets them only once the old one stopped polling", async () => {
    const { personReplies, poll, delivered, pass } = world();
    await poll("ses-old");
    const reply = personReplies("Go with ARM.");
    expect(await poll("ses-new", "ses-old")).toEqual([]);
    expect(await poll("ses-old")).toEqual([{ id: reply.id, as: "ses-old" }]);
    delivered("ses-old", reply.id);
    expect(await poll("ses-new", "ses-old")).toEqual([]);

    const later = personReplies("Ship it.");
    pass(INBOX_SESSION_LIVE_MS + 1);
    expect(await poll("ses-new", "ses-old")).toEqual([{ id: later.id, as: "ses-old" }]);
    // The old session is back before the branch delivered: it is its own again.
    expect(await poll("ses-old")).toEqual([{ id: later.id, as: "ses-old" }]);
    expect(await poll("ses-new", "ses-old")).toEqual([]);
  });

  test("the branch's own replies and the ones it inherits come oldest first", async () => {
    const { store, asked, personReplies, poll, pass } = world();
    pass(GONE_MS);
    const inherited = personReplies("Go with ARM.");
    const own = store.sendMessage({
      project_id: asked.project_id,
      author: { kind: "agent", host: "claude-code", session: "ses-new", name: "Claude Code" },
      body: "A new question.",
      subject: "Another",
      wakes: true,
    }).message;
    const mine = store.sendReply(own.id, { words: "Yes.", idempotency_key: "own-1" }).reply;
    expect(await poll("ses-new", ["ses-old"])).toEqual([
      { id: inherited.id, as: "ses-old" },
      { id: mine.id, as: "ses-new" },
    ]);
  });
});

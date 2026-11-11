/**
 * The list rows are kept per thread (store-row-cache.ts) while nothing they read changed (the store's lines, drafts,
 * annotations, the live sessions' answers), a write builds again only the rows of the threads it touched, and the
 * latest message of each agent session is kept as messages land: all must answer exactly what reading every thread
 * again would. A store opened fresh from the same folder has no cache, so it is the reference.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore, type InboxDeliveryPresence } from "./store";

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-list-memo-"));
  roots.push(root);
  return root;
}

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });

/** Rows as plain JSON, and the same read from a store with no memo. */
const rows = (store: InboxStore) => JSON.stringify(store.listRows());
const fresh = (dir: string) => JSON.stringify(InboxStore.open(dir).listRows());

/** Counts rows built (the store's private `buildRow`) on every store until the test ends. */
function countRowBuilds(): { count: number } {
  const counter = { count: 0 };
  const proto = InboxStore.prototype as unknown as { buildRow: (threadId: string) => unknown };
  const original = proto.buildRow;
  proto.buildRow = function (this: InboxStore, threadId: string) {
    counter.count += 1;
    return original.call(this, threadId);
  };
  restores.push(() => {
    proto.buildRow = original;
  });
  return counter;
}

describe("the list's memo", () => {
  test("every write moves the list: a message, a reply, a pick, a draft, read, archive, a rename, a deletion", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Totals first?\n\n:::question\nWhich?\n- [ ] Totals\n- [ ] Cards\n:::", thread: "one" });
    const steps: [string, () => unknown][] = [
      ["another thread", () => store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "Done with the cards.", thread: "two" })],
      ["a message in the first", () => store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Also the footer.", reply_to: first.message.id })],
      ["a pick", () => {
        const q = store.questionsOf(first.message.id)[0]!;
        store.savePicks(first.message.id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Totals"] } }]);
      }],
      ["a draft", () => store.saveReplyDraft(first.message.thread_id, { body: "Totals, then cards", base: null })],
      ["the reply", () => store.sendReply(first.message.id, { words: "Totals, then cards", idempotency_key: "k1" })],
      ["mark read", () => store.markRead(first.message.thread_id, true)],
      ["archive", () => store.resolveThread(first.message.id, true, "person")],
      ["back", () => store.resolveThread(first.message.id, false, "person")],
      ["another draft", () => store.saveReplyDraft(first.message.thread_id, { body: "later", base: store.replyDraft(first.message.thread_id)?.updated_at ?? null })],
      // Read between the save and this: the save's own change cannot stand in for the discard's.
      ["discard it", () => store.deleteReplyDraft(first.message.thread_id)],
      ["a rename", () => store.renameProject(project.id, "Shop front")],
      ["a deletion", () => store.deleteThread(first.message.thread_id)],
    ];
    let before = rows(store);
    for (const [name, step] of steps) {
      step();
      const after = rows(store);
      expect({ name, memo: after }).toEqual({ name, memo: fresh(dir) });
      expect({ name, moved: after !== before }).toEqual({ name, moved: true });
      before = after;
    }
  });

  test("reads with nothing changed between them build nothing again; a write builds only its thread's row", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    const roots = Array.from({ length: 5 }, (_, i) => store.sendMessage({ project_id: project.id, author: agent(`ses_${i}`), body: `Note ${i}`, thread: `t${i}` }).message.thread_id);
    const builds = countRowBuilds();
    const answers = [rows(store), rows(store), rows(store)];
    expect(builds.count).toBe(5);
    expect(new Set(answers).size).toBe(1);
    // One write to one thread: one row built again, wherever the write moves it in the list.
    const writes: [string, () => unknown][] = [
      ["a message", () => store.sendMessage({ project_id: project.id, author: agent("ses_0"), body: "One more", thread: "t0" })],
      ["a draft", () => store.saveReplyDraft(roots[3]!, { body: "later", base: null })],
      ["a look", () => store.markSeen(roots[1]!)],
      ["a comment", () => store.saveMessageAnnotation(roots[2]!, { id: "c-1", type: "COMMENT", originalText: "Note", text: "why" })],
    ];
    for (const [name, write] of writes) {
      builds.count = 0;
      write();
      const after = rows(store);
      // Counted before the reference store below builds its own.
      expect({ name, built: builds.count }).toEqual({ name, built: 1 });
      expect({ name, rows: after }).toEqual({ name, rows: fresh(dir) });
    }
    // A project's name is every row's label: every row is built again.
    builds.count = 0;
    store.renameProject(project.id, "Shop front");
    const renamed = rows(store);
    expect(builds.count).toBe(5);
    expect(renamed).toBe(fresh(dir));
  });

  test("a caller that sorts or trims its copy never changes the next answer", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    for (let i = 0; i < 3; i += 1) store.sendMessage({ project_id: project.id, author: agent(`ses_${i}`), body: `Note ${i}`, thread: `t${i}` });
    const expected = rows(store);
    const copy = store.listRows();
    copy.reverse();
    copy.pop();
    expect(rows(store)).toBe(expected);
  });

  test("the live sessions moving with no store line moves the rows: a session that goes away ends its row", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    const sent = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Ready to merge?", thread: "merge", wakes: true });
    const live = new Set(["ses_live"]);
    const presence: InboxDeliveryPresence = {
      connection: (session) => (live.has(session) ? { busy: false, send_now: false } : null),
      askerLive: (session) => live.has(session),
    };
    store.setDeliveryPresence(presence);
    const rowOf = () => store.listRows().find((row) => row.thread_id === sent.message.thread_id)!;
    const there = JSON.stringify(rowOf());
    expect(rowOf().session_ended).toBeUndefined();
    // Read twice with the session still there: the same answer.
    expect(JSON.stringify(rowOf())).toBe(there);
    live.delete("ses_live");
    expect(rowOf().session_ended).toBe(true);
    live.add("ses_live");
    expect(JSON.stringify(rowOf())).toBe(there);
    // And the person's reply waiting on it follows its connection too.
    store.sendReply(sent.message.id, { words: "Yes", idempotency_key: "k-merge" });
    const waiting = JSON.stringify(rowOf().delivery);
    live.delete("ses_live");
    expect(JSON.stringify(rowOf().delivery)).not.toBe(waiting);
  });

  test("filtered reads give only their project's or session's rows", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const shop = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    const docs = store.ensureProject({ name: "docs", root: join(dir, "docs") });
    store.sendMessage({ project_id: shop.id, author: agent("ses_a"), body: "Shop note", thread: "a" });
    store.sendMessage({ project_id: docs.id, author: agent("ses_b"), body: "Docs note", thread: "b" });
    expect(store.listRows()).toHaveLength(2);
    expect(store.listRows({ projectId: docs.id }).map((row) => row.project.id)).toEqual([docs.id]);
    expect(store.listRows({ session: "ses_a" }).map((row) => row.project.id)).toEqual([shop.id]);
  });
});

describe("each agent session's latest message", () => {
  test("follows every send, in the order sessions first wrote, and is built again after a deletion", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "shop", root: join(dir, "shop") });
    const plain = (s: InboxStore) => [...s.latestAgentMessages()].map(([session, message]) => [session, message.id, message.body]);
    const threads = (s: InboxStore) => [...s.lastThreadsBySession()];
    const a1 = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "a1", thread: "x" });
    store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "b1", thread: "y" });
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "a2", thread: "z" });
    // The person's reply is nobody's latest agent message.
    store.sendReply(a1.message.id, { words: "ok", idempotency_key: "k" });
    expect(plain(store)).toEqual([
      ["ses_a", expect.any(String), "a2"],
      ["ses_b", expect.any(String), "b1"],
    ]);
    expect(plain(store)).toEqual(plain(InboxStore.open(dir)));
    expect(threads(store)).toEqual(threads(InboxStore.open(dir)));
    // A later snapshot of a message (archived) is the one given.
    store.resolveThread(a1.message.id, true, "person");
    expect(plain(store)).toEqual(plain(InboxStore.open(dir)));
    // Deleting the thread a session last wrote in: its earlier message is its latest again.
    const z = store.lastThreadsBySession().get("ses_a")!.id;
    store.deleteThread(z);
    expect(plain(store)).toEqual([
      ["ses_a", a1.message.id, "a1"],
      ["ses_b", expect.any(String), "b1"],
    ]);
    expect(threads(store)).toEqual(threads(InboxStore.open(dir)));
  });
});

/**
 * The reply draft of a linked machine's thread (inbox-machine-drafts.ts), this Inbox's side alone: a real outbox here,
 * and on the far side a real store behind its own draft routes (inbox-reply-drafts.ts), reached through a stand-in door
 * that is "asleep" or "online" on cue. No Inbox is started. What it guards:
 *  - online with nothing waiting, a save is that machine's to answer, a conflict included, and nothing is held;
 *  - away, a save is held (never "waiting", never a notice) and answered with the draft as it will be; a read, the
 *    row's Draft mark and the Drafts page show it; a reload's read and a restart keep it;
 *  - saves that never left fold into one, file changes and all; a Discard takes them with it;
 *  - back online, what waits lands on that machine's real store, its compare-and-set passing;
 *  - a held save refused there because the draft changed meanwhile keeps both words; one naming a file swept there
 *    goes again without it; one refused for any other reason keeps its words here until the next save carries them;
 *  - a draft past the outbox's limit is held whole, never refused for it;
 *  - a held reply that carries the draft leaves no draft of the sent words;
 *  - a machine whose list lacks the mark gets no Drafts rows from here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxListRow, InboxReplyDraft } from "@plannotator/core/inbox-types";
import { receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { InboxOutbox, OUTBOX_MAX_BODY_BYTES, type OutboxEntry } from "./inbox-outbox";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";
import { createMachineDrafts, type DraftAnswer, type DraftPeer } from "./inbox-machine-drafts";

const MACHINE = "ibx_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempDir = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `plannotator-machine-drafts-${name}-`));
  roots.push(root);
  return root;
};

/** The far machine: a real store and its real draft routes, behind a door that answers only while `online`. */
function farMachine() {
  const dir = tempDir("far");
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing-svc", root: join(dir, "billing-svc") });
  const thread = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, body: "Retry the webhook?", thread: "refunds" }).message.thread_id;
  const told: string[] = [];
  const routes = createInboxReplyDrafts({
    store,
    serverSession: "far-session",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: (threadId) => told.push(threadId),
  });
  const door = async (route: string, init: { method: string; body?: string }) => {
    const req = new Request(`http://far.local/api/inbox/${route}`, { method: init.method, headers: { "Content-Type": "application/json" }, body: init.body });
    try {
      return (await routes.route(req, new URL(req.url))) ?? Response.json({ code: "device_route_not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof InboxError) return Response.json({ error: error.message, code: error.code, ...error.details }, { status: error.code === "draft_conflict" ? 409 : error.code.endsWith("_not_found") ? 404 : 422 });
      throw error;
    }
  };
  return { store, thread, told, door };
}

function linked(options: { marks?: string[] } = {}) {
  const far = farMachine();
  const here = tempDir("here");
  let outbox = InboxOutbox.open(here);
  const changes: string[] = [];
  const sentRoutes: string[] = [];
  const row = (): InboxListRow & { machine: string } => ({ ...(far.store.listRows().find((r) => r.thread_id === far.thread) as InboxListRow), machine: MACHINE });
  const peer: DraftPeer & { state: string } = {
    id: MACHINE,
    state: "offline",
    list: { marks: options.marks ?? ["reply-drafts"], rows: [] },
    async request(route, _search, init) {
      if (peer.state !== "online") throw new Error("unreachable");
      sentRoutes.push(`${init.method} ${route}`);
      return far.door(route, { method: init.method, body: init.body });
    },
    flush() {
      if (peer.state !== "online") return;
      void outbox.drain(MACHINE, async (entry: OutboxEntry) => {
        sentRoutes.push(`held ${entry.route}`);
        const answer = await far.door(entry.route, { method: "POST", body: JSON.stringify(entry.body) });
        return { status: answer.status, body: await answer.json() };
      });
    },
    poke() {},
    refreshList: async () => {},
  };
  let drafts = createMachineDrafts({ outbox, peer: () => peer, onChange: (_m, threadId) => changes.push(threadId) });
  const save = (body: Record<string, unknown>) => drafts.write(peer, far.thread, false, { files_add: [], files_remove: [], files_place: [], ...body });
  const settle = async () => {
    for (let i = 0; i < 50 && outbox.list(MACHINE, "pending").length > 0; i += 1) await Bun.sleep(5);
  };
  return {
    far,
    peer,
    changes,
    sentRoutes,
    row,
    save,
    settle,
    get outbox() {
      return outbox;
    },
    get drafts() {
      return drafts;
    },
    /** This Inbox restarts: the outbox read again from disk, the module made again (nothing in memory). */
    restart() {
      outbox = InboxOutbox.open(here);
      drafts = createMachineDrafts({ outbox, peer: () => peer, onChange: (_m, threadId) => changes.push(threadId) });
    },
  };
}

const answerOf = async (answer: DraftAnswer): Promise<{ status: number; body: any }> =>
  "far" in answer ? { status: answer.far.status, body: await answer.far.json() } : { status: answer.status, body: answer.body };

describe("a linked machine's reply draft, from this Inbox", () => {
  test("online with nothing waiting: the save is that machine's, its conflict the window's, and nothing is held", async () => {
    const l = linked();
    l.peer.state = "online";
    const first = await answerOf(await l.save({ body: "Retry after the deploy", base: null }));
    expect(first.status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Retry after the deploy");
    expect(l.far.told).toEqual([l.far.thread]);
    // Another window there changed it since: refused with the newer draft, as on that machine.
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: (first.body.draft as InboxReplyDraft).updated_at });
    const stale = await answerOf(await l.save({ body: "Mine", base: (first.body.draft as InboxReplyDraft).updated_at, base_body: "Something else" }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "draft_conflict", draft: { body: "Typed on the MacBook" } });
    expect(l.outbox.list(MACHINE)).toEqual([]);
  });

  test("away: held as this Inbox's own write, answered with the draft as it will be, shown by a read, the row and Drafts", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Words typed while the MacBook sleeps", base: null }));
    expect(held.status).toBe(200);
    expect(held.body.draft).toMatchObject({ thread_id: l.far.thread, body: "Words typed while the MacBook sleeps" });
    const [entry] = l.outbox.list(MACHINE, "pending");
    expect(entry).toMatchObject({ auto: true, route: `threads/${l.far.thread}/draft`, thread: l.far.thread });
    expect(l.outbox.notices()).toEqual([]);
    expect(l.changes).toContain(l.far.thread);
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: held.body.draft });
    const [row] = l.drafts.overlay([l.row()]);
    expect(row!.unsent?.reply_at).toBe(held.body.draft.updated_at);
    const [listed] = await l.drafts.rowsFor([l.peer], [row!]);
    expect(listed!.reply_preview).toBe("Words typed while the MacBook sleeps");
    // A restart here keeps it: the read still answers it.
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words typed while the MacBook sleeps");
  });

  test("saves that never left fold into one, and land on that machine's store when it is back", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Retry", base: null }));
    const farBase = (start.body.draft as InboxReplyDraft).updated_at;
    l.peer.state = "offline";
    const one = await answerOf(await l.save({ body: "Retry after", base: farBase, base_body: "Retry" }));
    const two = await answerOf(await l.save({ body: "Retry after the deploy", base: one.body.draft.updated_at, base_body: "Retry after" }));
    expect(two.status).toBe(200);
    const pending = l.outbox.list(MACHINE, "pending");
    expect(pending).toHaveLength(1);
    // The folded save still stands on what that machine holds: its time and words.
    expect(pending[0]!.body).toMatchObject({ body: "Retry after the deploy", base: farBase, base_body: "Retry" });
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Retry after the deploy");
    expect(l.outbox.notices()).toEqual([]);
    // Landed: a read asks that machine again.
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a save behind one already on its way is held behind it and lands after it", async () => {
    const l = linked();
    await answerOf(await l.save({ body: "First words", base: null }));
    // The first one left once and got no answer: it may have landed there, so it is never folded.
    await l.outbox.drain(MACHINE, async () => null);
    expect(l.outbox.list(MACHINE, "pending")[0]).toMatchObject({ state: "sending", left: true });
    const view = l.drafts.read(l.peer, l.far.thread)!.draft!;
    await answerOf(await l.save({ body: "First words, then more", base: view.updated_at, base_body: "First words" }));
    const pending = l.outbox.list(MACHINE, "pending");
    expect(pending).toHaveLength(2);
    expect(pending[1]!.body).toMatchObject({ base: null, base_body: "First words" });
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("First words, then more");
  });

  test("a second window here a step behind the held draft is refused with it, as that machine would refuse it", async () => {
    const l = linked();
    const mine = await answerOf(await l.save({ body: "From the first window", base: null }));
    const other = await answerOf(await l.save({ body: "From a stale window", base: null, base_body: "Something older" }));
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "draft_conflict", draft: mine.body.draft });
  });

  test("Discard while away takes the saves that never left with it, and deletes the draft there when it is back", async () => {
    const l = linked();
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook earlier", base: null });
    await answerOf(await l.save({ body: "Typed here while it sleeps", base: null }));
    const gone = await answerOf(await l.drafts.write(l.peer, l.far.thread, true, {}));
    expect(gone).toEqual({ status: 200, body: { ok: true, deleted: true } });
    expect(l.outbox.list(MACHINE, "pending").map((e) => e.route)).toEqual([`threads/${l.far.thread}/draft/delete`]);
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    const [row] = l.drafts.overlay([l.row()]);
    expect(row!.unsent).toBeNull();
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
  });

  test("a held save refused there because the draft changed meanwhile keeps both words", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "Typed on the Studio", base: start.body.draft.updated_at, base_body: "Shared start" }));
    // Meanwhile, on the MacBook's own window.
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: start.body.draft.updated_at });
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Typed on the MacBook\n\nTyped on the Studio");
    expect(l.outbox.notices()).toEqual([]);
  });

  test("a held join whose list names a file swept there since goes again without it: the words and the other file land", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    const upload = (name: string) => receiveInboxUpload(l.far.store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const kept = await upload("trace.txt");
    const swept = await upload("old-log.txt");
    for (const file of [kept, swept]) l.drafts.noteUpload(Response.json({ upload: file }));
    // The uploads' answers read, as they are long before the box saves them.
    await Bun.sleep(5);
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "Typed on the Studio", base: start.body.draft.updated_at, base_body: "Shared start", files_add: [{ upload_id: kept.upload_id }, { upload_id: swept.upload_id }] }));
    // Meanwhile the MacBook's own window changes the draft, and a day later its sweep takes one upload.
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: start.body.draft.updated_at });
    removeInboxUploads(l.far.store.dir, [swept.upload_id]);
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    const landed = l.far.store.replyDraft(l.far.thread);
    expect(landed?.body).toBe("Typed on the MacBook\n\nTyped on the Studio");
    expect(landed?.files?.map((file) => file.upload_id)).toEqual([kept.upload_id]);
    expect(l.outbox.notices()).toEqual([]);
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a held save refused there for another reason keeps its words as the draft here, through a restart, and the next save carries them", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Words that machine refused", base: null }));
    await l.outbox.drain(MACHINE, async () => ({ status: 422, body: { error: "Not this time.", code: "validation_error" } }));
    expect(l.outbox.list(MACHINE, "pending")).toEqual([]);
    expect(l.outbox.notices()).toEqual([]);
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: held.body.draft });
    const [row] = l.drafts.overlay([l.row()]);
    expect(row!.unsent?.reply_at).toBe(held.body.draft.updated_at);
    expect((await l.drafts.rowsFor([l.peer], [row!]))[0]!.reply_preview).toBe("Words that machine refused");
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words that machine refused");
    // The window's next save, on the draft it was shown: those words go there with it.
    l.peer.state = "online";
    const next = await answerOf(await l.save({ body: "Words that machine refused, and more", base: held.body.draft.updated_at, base_body: "Words that machine refused" }));
    expect(next.status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Words that machine refused, and more");
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a draft past the outbox's limit is held whole while that machine is away, and lands when it is back", async () => {
    const l = linked();
    const long = "Retry the webhook. ".repeat(20_000);
    expect(long.length).toBeGreaterThan(OUTBOX_MAX_BODY_BYTES);
    const held = await answerOf(await l.save({ body: long, base: null }));
    expect(held.status).toBe(200);
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe(long);
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe(long);
  });

  test("a held reply that carries the draft leaves no draft of the sent words, here or there", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Ship it", base: null }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Ship it", clear_draft: held.body.draft.updated_at });
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
  });

  test("a machine whose list lacks the mark (an older Plannotator) gets no Drafts rows from here", async () => {
    const l = linked({ marks: [] });
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: null });
    expect(await l.drafts.rowsFor([l.peer], [l.row()])).toEqual([]);
  });

  test("the Drafts page reads a far draft's first words once, and the outbox keeps no settled draft write past a start", async () => {
    const l = linked();
    l.peer.state = "online";
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed   on\nthe MacBook", base: null });
    const [listed] = await l.drafts.rowsFor([l.peer], [l.row()]);
    expect(listed!.reply_preview).toBe("Typed on the MacBook");
    await l.drafts.rowsFor([l.peer], [l.row()]);
    expect(l.sentRoutes.filter((r) => r === `GET threads/${l.far.thread}/draft`)).toHaveLength(1);
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "Held", base: null, base_body: "Typed   on\nthe MacBook" }));
    l.peer.state = "online";
    l.peer.flush();
    await l.settle();
    expect(l.outbox.list(MACHINE).length).toBeGreaterThan(0);
    l.restart();
    expect(l.outbox.list(MACHINE)).toEqual([]);
  });
});

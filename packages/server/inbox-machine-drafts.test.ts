/**
 * The reply draft of a linked machine's thread (inbox-machine-drafts.ts), this Inbox's side alone: its held drafts in
 * a temp data folder, and on the far side a real store behind its own draft routes (inbox-reply-drafts.ts), reached
 * through a stand-in door that is "asleep" or "online" on cue. No Inbox is started. What it guards:
 *  - online with nothing held, a save is that machine's to answer, a conflict included, and nothing is held;
 *  - away, a save is held in one file of its own (never the outbox) and answered with the draft as it will be; a read,
 *    the row's Draft mark and the Drafts page show it; a restart keeps it;
 *  - many saves while away leave one small file, and land there as one write, once;
 *  - a save behind one that left without an answer goes after it, that one again under its own key;
 *  - a Discard after saves wins: only it goes; a save after it stands on no draft;
 *  - a held save refused there because the draft changed meanwhile keeps both words; one naming a file swept there
 *    goes again without it; one refused for any other reason keeps its words here (through a restart) until the next
 *    save carries them;
 *  - a held reply that carries the draft leaves no draft of the sent words, or only the file it did not carry;
 *  - Unlink: what is held is counted, and handed back as words to keep;
 *  - the held draft follows the same rules as that machine's own store, save by save (table below).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxListRow, InboxReplyDraft } from "@plannotator/core/inbox-types";
import { receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";
import { createMachineDrafts, heldReplyState, lostDraftParts, MORE_OFFERED_MAX, type DraftAnswer, type DraftPeer, type LostDraft } from "./inbox-machine-drafts";
import type { OutboxState } from "./inbox-outbox";
import { INBOX_MACHINE_DRAFTS_DIR } from "./inbox-machine-drafts-held";

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
  /** Each time that machine's windows were told its draft changed (`event: drafts`). */
  const told: string[] = [];
  const routes = createInboxReplyDrafts({
    store,
    serverSession: "far-session",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: (threadId) => told.push(threadId),
  });
  /**
   * As that machine's door (inbox-devices.ts, `carries: "draft"`): nothing of a draft route is recorded, so a write
   * under a key seen before goes to the store again (a save under the draft's last key is answered with the draft,
   * `last_key`; a Discard names its version). A Discard naming none is refused, as that door refuses it.
   */
  const door = async (route: string, init: { method: string; body?: string }) => {
    if (init.method === "POST" && route.endsWith("/delete") && !("base" in (JSON.parse(init.body ?? "{}") as Record<string, unknown>))) {
      return Response.json({ error: "base: required here.", code: "validation_error", field: "base" }, { status: 422 });
    }
    const req = new Request(`http://far.local/api/inbox/${route}`, { method: init.method, headers: { "Content-Type": "application/json" }, body: init.body });
    let answer: Response;
    try {
      answer = (await routes.route(req, new URL(req.url))) ?? Response.json({ code: "device_route_not_found" }, { status: 404 });
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      answer = Response.json({ error: error.message, code: error.code, ...error.details }, { status: error.code === "draft_conflict" ? 409 : error.code.endsWith("_not_found") ? 404 : 422 });
    }
    return answer;
  };
  return { store, thread, door, told };
}

/** `outbox`: each held reply's entry state as the outbox holds it (no entry: gone), read as inbox-machines.ts reads it. */
function linked(options: { marks?: string[]; outbox?: Map<string, OutboxState> } = {}) {
  const far = farMachine();
  const here = tempDir("here");
  const changes: string[] = [];
  /** Each POST that reached that machine: its route and key. */
  const posts: { route: string; key: unknown; body: Record<string, unknown> }[] = [];
  const gets: string[] = [];
  let failPosts = 0;
  let lostAnswers = 0;
  let sleepAfterLoss = false;
  /** How each held reply stands in the outbox (inbox-machines.ts `replyState`). */
  const replies = new Map<string, "pending" | "delivered" | "refused">();
  const logged: string[] = [];
  let answerWith: ((route: string) => Response | null) | null = null;
  /** The next POST waits for this, then gets no answer (it is on its way while the test does something else). */
  let postGate: Promise<void> | null = null;
  /** Unlinked: the machine's line is gone (inbox-machines.ts `peers` no longer has it). */
  let unlinked = false;
  const lost: LostDraft[] = [];
  const row = (): InboxListRow & { machine: string } => ({ ...(far.store.listRows().find((r) => r.thread_id === far.thread) as InboxListRow), machine: MACHINE });
  const peer: DraftPeer & { state: string } = {
    id: MACHINE,
    state: "offline",
    list: { marks: options.marks ?? ["reply-drafts"], rows: [] },
    listAsked: 0,
    listGen: 0,
    async request(route, _search, init) {
      if (peer.state !== "online") throw new Error("unreachable");
      if (init.method === "GET") gets.push(route);
      else {
        if (postGate) {
          const gate = postGate;
          postGate = null;
          await gate;
          throw new Error("no answer in time");
        }
        if (failPosts > 0) {
          failPosts -= 1;
          throw new Error("no answer");
        }
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        posts.push({ route, key: body.idempotency_key, body });
        if (lostAnswers > 0) {
          // Landed there, but its answer never came back (too slow).
          lostAnswers -= 1;
          await far.door(route, { method: init.method, body: init.body });
          // It went to sleep before answering: nothing more reaches it until it is back.
          if (sleepAfterLoss) peer.state = "offline";
          throw new Error("no answer in time");
        }
        const canned = answerWith?.(route);
        if (canned) return canned;
      }
      return far.door(route, { method: init.method, body: init.body });
    },
    poke() {},
    refreshList: async () => {},
  };
  const make = () =>
    createMachineDrafts({
      dataDir: here,
      peer: () => (unlinked ? undefined : peer),
      onChange: (_m, threadId) => changes.push(threadId),
      retryMs: 60_000,
      replyState: (k) => (options.outbox ? heldReplyState(options.outbox.get(k)) : (replies.get(k) ?? "pending")),
      log: (line) => logged.push(line),
      lost: (_peer, one) => lost.push(one),
    });
  let drafts = make();
  const save = (body: Record<string, unknown>) => drafts.write(peer, far.thread, false, { files_add: [], files_remove: [], files_place: [], ...body });
  const heldDir = join(inboxDir(here), INBOX_MACHINE_DRAFTS_DIR, MACHINE);
  const heldFiles = () => {
    try {
      return readdirSync(heldDir);
    } catch {
      return [];
    }
  };
  return {
    far,
    peer,
    changes,
    posts,
    gets,
    row,
    save,
    here,
    heldFiles,
    heldBytes: () => heldFiles().reduce((sum, name) => sum + statSync(join(heldDir, name)).size, 0),
    failNextPosts: (n: number) => void (failPosts = n),
    loseNextAnswers: (n: number, sleep = false) => void ((lostAnswers = n), (sleepAfterLoss = sleep)),
    replies,
    logged,
    heldDir,
    answer: (fn: ((route: string) => Response | null) | null) => void (answerWith = fn),
    gateNextPost: (gate: Promise<void>) => void (postGate = gate),
    lost,
    /** Unlink, as inbox-machines.ts `forget` does it: the line goes first, then what is held for it. */
    unlink() {
      unlinked = true;
      return drafts.forget(MACHINE);
    },
    /** A read of that machine's list lands (`PeerLink.acceptList`): its rows as its store has them now, or `rows`. */
    listed(rows = [row()], asked = ++peer.listAsked) {
      peer.listGen = Math.max(peer.listGen, asked);
      peer.list = { marks: options.marks ?? ["reply-drafts"], rows };
    },
    get drafts() {
      return drafts;
    },
    /** Back online: what is held lands (as the line's change does in inbox-machines.ts). */
    async back() {
      peer.state = "online";
      await drafts.drain(MACHINE);
    },
    /** This Inbox restarts: the module made again from the data folder (nothing in memory). */
    restart() {
      drafts = make();
    },
  };
}

const answerOf = async (answer: DraftAnswer): Promise<{ status: number; body: any }> =>
  "far" in answer ? { status: answer.far.status, body: await answer.far.json() } : { status: answer.status, body: answer.body };

describe("a linked machine's reply draft, from this Inbox", () => {
  test("online with nothing held: the save is that machine's, its conflict the window's, and nothing is held", async () => {
    const l = linked();
    l.peer.state = "online";
    const first = await answerOf(await l.save({ body: "Retry after the deploy", base: null }));
    expect(first.status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Retry after the deploy");
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: (first.body.draft as InboxReplyDraft).updated_at });
    const stale = await answerOf(await l.save({ body: "Mine", base: (first.body.draft as InboxReplyDraft).updated_at, base_body: "Something else" }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "draft_conflict", draft: { body: "Typed on the MacBook" } });
    expect(l.heldFiles()).toEqual([]);
  });

  test("away: held in a file of its own, answered with the draft as it will be, shown by a read, the row and Drafts, through a restart", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Words typed while the MacBook sleeps", base: null }));
    expect(held.status).toBe(200);
    expect(held.body.draft).toMatchObject({ thread_id: l.far.thread, body: "Words typed while the MacBook sleeps" });
    expect(l.heldFiles()).toEqual([`${l.far.thread}.json`]);
    expect(statSync(join(inboxDir(l.here), INBOX_MACHINE_DRAFTS_DIR, MACHINE, `${l.far.thread}.json`)).mode & 0o777).toBe(0o600);
    expect(readdirSync(inboxDir(l.here))).not.toContain("outbox");
    expect(l.changes).toContain(l.far.thread);
    expect(l.drafts.heldCount(MACHINE)).toBe(1);
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: held.body.draft });
    const [row] = l.drafts.overlay([l.row()]);
    expect(row!.unsent?.reply_at).toBe(held.body.draft.updated_at);
    const [listed] = await l.drafts.rowsFor([l.peer], [row!]);
    expect(listed!.reply_preview).toBe("Words typed while the MacBook sleeps");
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: held.body.draft });
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Words typed while the MacBook sleeps");
    expect(l.heldFiles()).toEqual([]);
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("many autosaves while away leave one small file, and the newest lands there once", async () => {
    const l = linked();
    let base: string | null = null;
    let words = "";
    for (let i = 0; i < 300; i++) {
      const was: string = words;
      words += `word${i} `;
      const answer = await answerOf(await l.save({ body: words, base, ...(was ? { base_body: was } : {}) }));
      expect(answer.status).toBe(200);
      base = answer.body.draft.updated_at;
    }
    expect(l.heldFiles()).toHaveLength(1);
    // The words twice (shown, and to send) and a little more: not a log that grows with each save.
    expect(l.heldBytes()).toBeLessThan(2 * words.length + 4096);
    await l.back();
    expect(l.posts.filter((p) => p.route === `threads/${l.far.thread}/draft`)).toHaveLength(1);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe(words);
    // Nothing goes twice: a later drain finds nothing to send.
    await l.drafts.drain(MACHINE);
    expect(l.posts).toHaveLength(1);
  });

  test("a save behind one that left without an answer goes after it, that one again under its own key", async () => {
    const l = linked();
    await answerOf(await l.save({ body: "First words", base: null }));
    l.failNextPosts(1);
    await l.back();
    l.peer.state = "offline";
    const view = l.drafts.read(l.peer, l.far.thread)!.draft!;
    expect(view.body).toBe("First words");
    await answerOf(await l.save({ body: "First words, then more", base: view.updated_at, base_body: "First words" }));
    await l.back();
    expect(l.posts.map((p) => p.body.body)).toEqual(["First words", "First words, then more"]);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("First words, then more");
    expect(l.heldFiles()).toEqual([]);
  });

  test("a second window here a step behind the held draft is refused with it, as that machine would refuse it", async () => {
    const l = linked();
    const mine = await answerOf(await l.save({ body: "From the first window", base: null }));
    const other = await answerOf(await l.save({ body: "From a stale window", base: null, base_body: "Something older" }));
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: "draft_conflict", draft: mine.body.draft });
  });

  test("Discard after saves wins: only it goes there; a save after it stands on no draft", async () => {
    const l = linked();
    const earlier = l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook earlier", base: null })!;
    l.drafts.noteRead(MACHINE, l.far.thread, Response.json({ draft: earlier }));
    await Bun.sleep(5);
    await answerOf(await l.save({ body: "Typed here while it sleeps", base: earlier.updated_at, base_body: earlier.body }));
    const gone = await answerOf(await l.drafts.write(l.peer, l.far.thread, true, {}));
    expect(gone).toEqual({ status: 200, body: { ok: true, deleted: true } });
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    expect(l.drafts.overlay([l.row()])[0]!.unsent).toBeNull();
    await l.back();
    expect(l.posts.map((p) => p.route)).toEqual([`threads/${l.far.thread}/draft/delete`]);
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    // Away again: a Discard, then new words. Both go, in that order, and the words land on no draft.
    const again = l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook again", base: null })!;
    l.drafts.noteRead(MACHINE, l.far.thread, Response.json({ draft: again }));
    await Bun.sleep(5);
    l.peer.state = "offline";
    await answerOf(await l.drafts.write(l.peer, l.far.thread, true, {}));
    const fresh = await answerOf(await l.save({ body: "A new start", base: null }));
    expect(fresh.status).toBe(200);
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("A new start");
  });

  test("a held save that meets newer words there is a conflict as on this computer: never joined, offered until the person chooses", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    const mine = await answerOf(await l.save({ body: "Shared start, typed on the Studio", base: start.body.draft.updated_at, base_body: "Shared start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Shared start, typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    // Theirs stays theirs; mine are offered beside it, in every window, and through a restart.
    const theirs = l.far.store.replyDraft(l.far.thread)!;
    expect(theirs.body).toBe("Shared start, typed on the MacBook");
    const offered = { words: "Shared start, typed on the Studio", version: mine.body.draft.updated_at, conflict: true };
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
    l.restart();
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: theirs, not_landed: offered });
    // Drained again: nothing is joined, however often.
    await l.back();
    await l.drafts.drain(MACHINE);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Shared start, typed on the MacBook");
    // Keep mine: the person's words go over theirs, once, and nothing is offered any more.
    const kept = await answerOf(await l.save({ body: "Shared start, typed on the Studio", base: theirs.updated_at, base_body: theirs.body }));
    expect(kept.status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Shared start, typed on the Studio");
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("Discard mine after a held conflict: the person's words go, the draft there stays", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Start", base: null }));
    l.peer.state = "offline";
    const mine = await answerOf(await l.save({ body: "Start, mine", base: start.body.draft.updated_at, base_body: "Start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Start, theirs", base: start.body.draft.updated_at });
    await l.back();
    expect(await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: mine.body.draft.updated_at }))).toEqual({ status: 200, body: { ok: true, deleted: false } });
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Start, theirs");
    expect(l.heldFiles()).toEqual([]);
  });

  test("two held conflicts in a row: words offered and not chosen on yet are never written over; each is offered in turn, and Discard mine lets only its own go", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "First words held here", base: start.body.draft.updated_at, base_body: "Shared start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Shared start, typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    const first = l.drafts.notLanded(MACHINE, l.far.thread)!;
    expect(first.words).toBe("First words held here");
    // Away again: another window here, which never showed them, saves on the MacBook's draft; the MacBook types again.
    l.peer.state = "offline";
    const theirs = l.far.store.replyDraft(l.far.thread)!;
    await answerOf(await l.save({ body: "Second words held here", base: theirs.updated_at, base_body: theirs.body }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook again", base: theirs.updated_at });
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Typed on the MacBook again");
    // The first words are still the ones offered, through a restart; the second are offered once those are settled.
    l.restart();
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(first);
    // A Discard mine naming a version never offered lets nothing go.
    await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: "2000-01-01T00:00:00.000Z" }));
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(first);
    await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: first.version }));
    const second = l.drafts.notLanded(MACHINE, l.far.thread)!;
    expect(second.words).toBe("Second words held here");
    expect(second.conflict).toBe(true);
    await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: second.version }));
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Typed on the MacBook again");
    expect(l.heldFiles()).toEqual([]);
  });

  test("Unlink with two held conflicts offered: both sets of words are handed back", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "First words held here", base: start.body.draft.updated_at, base_body: "Shared start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    l.peer.state = "offline";
    const theirs = l.far.store.replyDraft(l.far.thread)!;
    await answerOf(await l.save({ body: "Second words held here", base: theirs.updated_at, base_body: theirs.body }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook again", base: theirs.updated_at });
    await l.back();
    expect(l.drafts.forget(MACHINE).map((lost) => lost.words).sort()).toEqual(["First words held here", "Second words held here"]);
  });

  test("a direct save that lands while another window's save was held meanwhile: the held save is kept and lands after it, its words never erased", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "Words offered here", base: start.body.draft.updated_at, base_body: "Shared start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Shared start, typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    const offered = l.drafts.notLanded(MACHINE, l.far.thread)!;
    const theirs = l.far.store.replyDraft(l.far.thread)!;
    // Window A's save goes straight there and waits for its answer; meanwhile that machine stops answering and window
    // B's save is held here.
    const request = l.peer.request.bind(l.peer);
    let release = () => {};
    const gate = new Promise<void>((done) => (release = done));
    l.peer.request = async (route, search, init) => {
      if (init.method === "POST") await gate;
      return request(route, search, init);
    };
    const a = l.save({ body: `${theirs.body}, from window A`, base: theirs.updated_at, base_body: theirs.body });
    await Bun.sleep(5);
    l.peer.state = "offline";
    const b = await answerOf(await l.save({ body: `${theirs.body}, from window B`, base: theirs.updated_at, base_body: theirs.body }));
    expect(b.status).toBe(200);
    l.peer.state = "online";
    l.peer.request = request;
    release();
    expect((await answerOf(await a)).status).toBe(200);
    // B's words are still held here, beside the words offered before.
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe(`${theirs.body}, from window B`);
    // Back: B's save meets A's there, so it is offered after the first words; nothing is lost or joined.
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe(`${theirs.body}, from window A`);
    const words: string[] = [];
    for (let n = l.drafts.notLanded(MACHINE, l.far.thread); n; n = l.drafts.notLanded(MACHINE, l.far.thread)) {
      words.push(n.words);
      await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: n.version }));
    }
    expect(words).toEqual([offered.words, `${theirs.body}, from window B`]);
  });

  test("Discard online goes only for the version the window threw away: newer words typed there since stay", async () => {
    const l = linked();
    l.peer.state = "online";
    const mine = await answerOf(await l.save({ body: "Words this window saw", base: null }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Newer words typed on the MacBook", base: mine.body.draft.updated_at });
    const gone = await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: mine.body.draft.updated_at }));
    expect(gone.body.code).toBe("draft_conflict");
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Newer words typed on the MacBook");
    // Every window is told, so the words kept there show.
    expect(l.changes).toContain(l.far.thread);
    // Naming the version there now, it goes.
    const now = l.far.store.replyDraft(l.far.thread)!;
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: now.updated_at }))).status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
  });

  test("Discard held while away goes for the version the window names, never a newer one heard there since that the window never showed", async () => {
    const l = linked();
    l.peer.state = "online";
    const mine = await answerOf(await l.save({ body: "Words this window saw", base: null }));
    // Another window's read heard newer words there; this window never showed them.
    const newer = l.far.store.saveReplyDraft(l.far.thread, { body: "Newer words typed on the MacBook", base: mine.body.draft.updated_at })!;
    l.drafts.noteRead(MACHINE, l.far.thread, Response.json({ draft: newer }));
    await Bun.sleep(5);
    l.peer.state = "offline";
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: mine.body.draft.updated_at }))).status).toBe(200);
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Newer words typed on the MacBook");
  });

  test("Discard of a held draft after it landed, naming the version this Inbox showed for it: it goes there", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Typed while it slept", base: null }));
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Typed while it slept");
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: held.body.draft.updated_at }))).status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
  });

  for (const choice of ["Keep mine", "Discard mine"] as const) {
    test(`a held conflict's words stay offered while another window that never showed them saves and discards, online and away, through a restart; only ${choice} settles them`, async () => {
      const l = linked();
      l.peer.state = "online";
      const start = await answerOf(await l.save({ body: "Shared start", base: null }));
      l.peer.state = "offline";
      const mine = await answerOf(await l.save({ body: "Shared start, typed on the Studio", base: start.body.draft.updated_at, base_body: "Shared start" }));
      l.far.store.saveReplyDraft(l.far.thread, { body: "Shared start, typed on the MacBook", base: start.body.draft.updated_at });
      await l.back();
      const offered = { words: "Shared start, typed on the Studio", version: mine.body.draft.updated_at as string, conflict: true as const };
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
      // Another window here, which read the MacBook's draft before the conflict was offered, saves on it: it lands there.
      let theirs = l.far.store.replyDraft(l.far.thread)!;
      const other = await answerOf(await l.save({ body: `${theirs.body}, and a second window`, base: theirs.updated_at, base_body: theirs.body }));
      expect(other.status).toBe(200);
      expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Shared start, typed on the MacBook, and a second window");
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
      // Away, the same window saves again (held here) and Discards: the words are still offered, through a restart.
      theirs = l.far.store.replyDraft(l.far.thread)!;
      l.peer.state = "offline";
      const held = await answerOf(await l.save({ body: `${theirs.body}, held`, base: theirs.updated_at, base_body: theirs.body }));
      expect(held.status).toBe(200);
      expect(l.drafts.read(l.peer, l.far.thread)?.not_landed).toEqual(offered);
      l.restart();
      expect(l.drafts.read(l.peer, l.far.thread)?.not_landed).toEqual(offered);
      await l.back();
      expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Shared start, typed on the MacBook, and a second window, held");
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
      theirs = l.far.store.replyDraft(l.far.thread)!;
      expect(await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: theirs.updated_at }))).toMatchObject({ status: 200 });
      expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
      expect(l.drafts.overlay([l.row()])[0]!.unsent?.reply_at).toBe(offered.version);
      if (choice === "Keep mine") {
        // A window that shows them saves them: they are the draft there, and nothing is offered any more.
        const kept = await answerOf(await l.save({ body: offered.words, base: null }));
        expect(kept.status).toBe(200);
        expect(l.far.store.replyDraft(l.far.thread)?.body).toBe(offered.words);
      } else {
        expect(await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: offered.version }))).toEqual({ status: 200, body: { ok: true, deleted: false } });
        expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
      }
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
      expect(l.heldFiles()).toEqual([]);
    });
  }

  test("a held save whose draft was discarded there meanwhile becomes the draft; the discarded words do not come back", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Words thrown away on the MacBook", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.save({ body: "Words typed here", base: start.body.draft.updated_at, base_body: "Words thrown away on the MacBook" }));
    l.far.store.deleteReplyDraft(l.far.thread);
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Words typed here");
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a held whole list (an older page) naming a file swept there since goes again without it: the words and the other file land", async () => {
    const l = linked();
    const upload = (name: string) => receiveInboxUpload(l.far.store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const kept = await upload("trace.txt");
    const swept = await upload("old-log.txt");
    for (const file of [kept, swept]) l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    await answerOf(await l.drafts.write(l.peer, l.far.thread, false, { body: "Typed on the Studio", base: null, files: [kept.upload_id, swept.upload_id], all_files: true }));
    removeInboxUploads(l.far.store.dir, [swept.upload_id]);
    await l.back();
    const landed = l.far.store.replyDraft(l.far.thread);
    expect(landed?.body).toBe("Typed on the Studio");
    expect(landed?.files?.map((file) => file.upload_id)).toEqual([kept.upload_id]);
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a held save adding a file swept there since: the words land, and the file is named as not taken (never dropped unsaid) until the person writes again", async () => {
    const l = linked();
    const upload = (name: string) => receiveInboxUpload(l.far.store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const kept = await upload("trace.txt");
    const swept = await upload("screenshot.png");
    for (const file of [kept, swept]) l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const held = await answerOf(await l.save({ body: "See the picture", base: null, files_add: [{ upload_id: kept.upload_id }, { upload_id: swept.upload_id }] }));
    expect(held.body.draft.files.map((file: { upload_id: string }) => file.upload_id)).toEqual([kept.upload_id, swept.upload_id]);
    removeInboxUploads(l.far.store.dir, [swept.upload_id]);
    await l.back();
    const there = l.far.store.replyDraft(l.far.thread)!;
    expect(there.body).toBe("See the picture");
    expect(there.files?.map((file) => file.upload_id)).toEqual([kept.upload_id]);
    // Offered with the far draft's read, by its name, and kept through a restart; nothing waits, nothing counts as unsent.
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
    expect(l.drafts.notLanded(MACHINE, l.far.thread)?.files?.map((file) => [file.upload_id, file.name])).toEqual([[swept.upload_id, "screenshot.png"]]);
    expect(l.drafts.heldCount(MACHINE)).toBe(0);
    l.restart();
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)?.not_landed?.files?.map((file) => file.name)).toEqual(["screenshot.png"]);
    // Landed already: nothing goes again.
    await l.back();
    expect(l.posts).toHaveLength(1);
    // The person writes again: it is said no more.
    const next = await answerOf(await l.save({ body: "See the picture, attached again later", base: there.updated_at, base_body: there.body }));
    expect(next.status).toBe(200);
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a long paste removed with some words while away: the held saves land, never stuck on the paste's old place", async () => {
    const l = linked();
    const paste = await receiveInboxUpload(l.far.store.dir, "pasted.txt", new Response("a long paste ".repeat(200)).body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: paste }));
    await Bun.sleep(5);
    const typed = "w".repeat(300);
    const chip = { upload_id: paste.upload_id, pasted: { at: 300, preview: "a long paste" } };
    const first = await answerOf(await l.save({ body: typed, base: null, files_add: [chip], files_place: [chip] }));
    expect(first.status).toBe(200);
    const shorter = "w".repeat(200);
    const second = await answerOf(await l.save({ body: shorter, base: first.body.draft.updated_at, base_body: typed, files_remove: [paste.upload_id] }));
    expect(second.status).toBe(200);
    await l.back();
    const there = l.far.store.replyDraft(l.far.thread);
    expect(there?.body).toBe(shorter);
    expect(there?.files ?? []).toEqual([]);
    expect(l.heldFiles()).toEqual([]);
  });

  test("a direct save that landed without its answer in time goes again under its own key: the next save never doubles its words", async () => {
    const l = linked();
    l.peer.state = "online";
    // It lands there, and the machine sleeps before its answer comes back: the next save is typed while it sleeps.
    l.loseNextAnswers(1, true);
    const first = await answerOf(await l.save({ body: "W1", base: null }));
    expect(first.status).toBe(200);
    expect(l.peer.state).toBe("offline");
    await answerOf(await l.save({ body: "W1 and more", base: first.body.draft.updated_at, base_body: "W1" }));
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("W1 and more");
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a save that landed with its answer lost, sent again under its key, is answered by that machine's store: written once, its windows told once", async () => {
    const l = linked();
    l.peer.state = "online";
    const words = "Refund Ada Novak in full";
    const first = await answerOf(await l.save({ body: words, base: null }));
    const file = await receiveInboxUpload(l.far.store.dir, "invoice.pdf", new Response("bytes").body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    // A save that adds a file and keeps the words lands; its answer is lost and that machine sleeps.
    l.loseNextAnswers(1, true);
    expect((await answerOf(await l.save({ body: words, base: first.body.draft.updated_at, base_body: words, files_add: [{ upload_id: file.upload_id }] }))).status).toBe(200);
    const landed = l.far.store.replyDraft(l.far.thread)!;
    expect(landed.files?.map((one) => one.upload_id)).toEqual([file.upload_id]);
    expect(l.far.told).toEqual([l.far.thread, l.far.thread]);
    await Bun.sleep(5);
    await l.back();
    const sends = l.posts.filter((p) => p.route === `threads/${l.far.thread}/draft`).slice(1);
    expect(sends.map((p) => p.key)).toEqual([sends[0]!.key, sends[0]!.key]);
    // The same draft there, its version unmoved: nothing written again, and its windows not told again.
    expect(l.far.store.replyDraft(l.far.thread)).toEqual(landed);
    expect(l.far.told).toEqual([l.far.thread, l.far.thread]);
    expect(l.heldFiles()).toEqual([]);
  });

  test("a save that landed with its answer lost, then changed there with the same words: sent again, it never puts back a file taken out there, nor the quote and recipients changed there", async () => {
    const l = linked();
    l.peer.state = "online";
    const file = await receiveInboxUpload(l.far.store.dir, "trace.txt", new Response("bytes").body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    l.loseNextAnswers(1, true);
    const typed = { body: "See the trace", base: null, files_add: [{ upload_id: file.upload_id }], quote: { of: l.far.thread, words: "the webhook" }, recipients: ["ses_a"] };
    expect((await answerOf(await l.save(typed))).status).toBe(200);
    const landed = l.far.store.replyDraft(l.far.thread)!;
    expect(landed.files?.map((one) => one.upload_id)).toEqual([file.upload_id]);
    await Bun.sleep(5);
    // A window there takes the file out, drops the quote and aims the reply at another agent; the words stay the same.
    const there = l.far.store.saveReplyDraft(l.far.thread, { body: "See the trace", base: landed.updated_at, files_add: [], files_remove: [file.upload_id], files_place: [], quote: null, recipients: ["ses_b"] })!;
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)).toEqual(there);
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a held Discard goes only for the draft the person threw away: newer words typed there meanwhile stay", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Thrown away", base: null }));
    l.peer.state = "offline";
    await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: start.body.draft.updated_at }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Newer words typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Newer words typed on the MacBook");
    expect(l.heldFiles()).toEqual([]);
  });

  test("a torn held file is moved aside (never deleted), said once, and the thread holds no draft here", async () => {
    const l = linked();
    await answerOf(await l.save({ body: "Words", base: null }));
    writeFileSync(join(l.heldDir, `${l.far.thread}.json`), '{"v":1,"machine":');
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
    expect(l.heldFiles().filter((name) => name.startsWith(`${l.far.thread}.json.corrupt-`))).toHaveLength(1);
    expect(l.logged).toHaveLength(1);
  });

  test("a held file that cannot be written as it lands (a full disk) stays as it was and is tried again, with no unhandled failure", async () => {
    const l = linked();
    l.answer(() => Response.json({ error: "Not this time.", code: "validation_error" }, { status: 422 }));
    await answerOf(await l.save({ body: "Kept through a full disk", base: null }));
    const before = readFileSync(join(l.heldDir, `${l.far.thread}.json`), "utf8");
    chmodSync(l.heldDir, 0o500);
    try {
      await l.back();
    } finally {
      chmodSync(l.heldDir, 0o700);
    }
    expect(readFileSync(join(l.heldDir, `${l.far.thread}.json`), "utf8")).toBe(before);
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Kept through a full disk");
  });

  test("a held save refused there for another reason keeps its words here, through a restart, and the next save carries them", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Words that machine refused", base: null }));
    l.answer(() => Response.json({ error: "Not this time.", code: "validation_error" }, { status: 422 }));
    await l.back();
    l.answer(null);
    // Shown as not saved there: its words, offered as words that did not land ("Not saved").
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: held.body.draft, not_landed: { words: "Words that machine refused", version: held.body.draft.updated_at } });
    expect(l.drafts.overlay([l.row()])[0]!.unsent?.reply_at).toBe(held.body.draft.updated_at);
    // Not sent again by itself.
    await l.drafts.drain(MACHINE);
    expect(l.posts).toHaveLength(1);
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words that machine refused");
    const next = await answerOf(await l.save({ body: "Words that machine refused, and more", base: held.body.draft.updated_at, base_body: "Words that machine refused" }));
    expect(next.status).toBe(200);
    await l.drafts.drain(MACHINE);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Words that machine refused, and more");
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a held reply that carries the draft leaves no draft of the sent words, here or there, once it is delivered", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Ship it", base: null }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Ship it", clear_draft: held.body.draft.updated_at }, "reply-1");
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    l.replies.set("reply-1", "delivered");
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a held reply whose outbox entry is gone (settled long ago, its settle missed here): the words it carried never come back", async () => {
    const outbox = new Map<string, OutboxState>([["reply-1", "sending"]]);
    const l = linked({ outbox });
    const held = await answerOf(await l.save({ body: "Ship it", base: null }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Ship it", clear_draft: held.body.draft.updated_at }, "reply-1");
    // Delivered, its settle never heard here (a restart in between), then dropped from the outbox past its keep.
    outbox.delete("reply-1");
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
    expect(l.heldFiles()).toEqual([]);
  });

  test("a held reply refused there: the words it carried are the draft again", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Ship it", base: null }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Ship it", clear_draft: held.body.draft.updated_at }, "reply-1");
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    l.replies.set("reply-1", "refused");
    l.drafts.replySettled(MACHINE, "reply-1");
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Ship it");
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Ship it");
  });

  test("a held reply that did not carry one of the draft's files leaves that file as the draft, here and there", async () => {
    const l = linked();
    const upload = (name: string) => receiveInboxUpload(l.far.store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const sent = await upload("sent.txt");
    const left = await upload("left.txt");
    for (const file of [sent, left]) l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const held = await answerOf(await l.save({ body: "Both files", base: null, files_add: [{ upload_id: sent.upload_id }, { upload_id: left.upload_id }] }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Both files", clear_draft: held.body.draft.updated_at, uploads: [sent.upload_id] }, "reply-1");
    const after = l.drafts.read(l.peer, l.far.thread)!.draft!;
    expect(after.body).toBe("");
    expect(after.files?.map((f) => f.upload_id)).toEqual([left.upload_id]);
    expect(l.drafts.overlay([l.row()])[0]!.unsent?.reply_at).toBe(after.updated_at);
    l.replies.set("reply-1", "delivered");
    await l.back();
    const there = l.far.store.replyDraft(l.far.thread);
    expect(there?.body).toBe("");
    expect(there?.files?.map((f) => f.upload_id)).toEqual([left.upload_id]);
  });

  test("a held reply that sent the draft's file, then new words typed while it waits: they land, and the sent file is never said to be not added", async () => {
    const l = linked();
    const file = await receiveInboxUpload(l.far.store.dir, "invoice.pdf", new Response("bytes").body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const held = await answerOf(await l.save({ body: "Here is the invoice", base: null, files_add: [{ upload_id: file.upload_id }] }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Here is the invoice", clear_draft: held.body.draft.updated_at, uploads: [file.upload_id] }, "reply-1");
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
    // The next reply, typed while the first waits.
    const typed = await answerOf(await l.save({ body: "And the receipt follows", base: null }));
    expect(typed.body.draft.files ?? []).toEqual([]);
    // Delivered there: the file is the reply's attachment now, no longer an upload.
    removeInboxUploads(l.far.store.dir, [file.upload_id]);
    l.replies.set("reply-1", "delivered");
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("And the receipt follows");
    expect(l.far.store.replyDraft(l.far.thread)?.files ?? []).toEqual([]);
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  /** A held save meets newer words there: `words` are offered as a conflict. */
  const offeredConflict = async (l: ReturnType<typeof linked>, words: string) => {
    l.peer.state = "offline";
    const there = l.far.store.replyDraft(l.far.thread);
    await answerOf(await l.save({ body: words, base: there?.updated_at ?? null, ...(there ? { base_body: there.body } : {}) }));
    l.far.store.saveReplyDraft(l.far.thread, { body: `Typed on the MacBook ${Math.random()}`, base: there?.updated_at ?? null });
    await l.back();
    return l.drafts.notLanded(MACHINE, l.far.thread)!;
  };

  for (const outcome of ["delivered", "refused"] as const) {
    test(`a Send of a held conflict's words: no longer offered while it goes (never sent twice); ${outcome === "delivered" ? "delivered, they stay settled through a restart" : "refused, they are offered again, once"}`, async () => {
      const l = linked();
      l.peer.state = "online";
      await answerOf(await l.save({ body: "Shared start", base: null }));
      const offered = await offeredConflict(l, "Words offered here");
      expect(offered.conflict).toBe(true);
      l.drafts.afterReply(l.peer, l.far.thread, { words: offered.words, clear_draft: "", uploads: [] }, "reply-c");
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
      l.peer.state = "offline";
      expect(l.drafts.read(l.peer, l.far.thread)?.not_landed).toBeUndefined();
      l.peer.state = "online";
      l.replies.set("reply-c", outcome);
      l.drafts.replySettled(MACHINE, "reply-c");
      await l.drafts.drain(MACHINE);
      l.restart();
      if (outcome === "delivered") expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
      else expect(l.drafts.notLanded(MACHINE, l.far.thread)).toMatchObject({ words: offered.words, version: offered.version, conflict: true });
      expect(l.far.store.replyDraft(l.far.thread)?.body.startsWith("Typed on the MacBook")).toBe(true);
    });
  }

  for (const outcome of ["delivered", "refused"] as const) {
    test(`a Send while that machine sleeps, its draft saved there: the sent words do not come back from the draft last heard; ${outcome === "delivered" ? "delivered, the draft goes there" : "refused, they are the draft again"}`, async () => {
      const l = linked();
      l.peer.state = "online";
      const saved = await answerOf(await l.save({ body: "Words saved there", base: null }));
      await Bun.sleep(5);
      l.peer.state = "offline";
      expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words saved there");
      l.drafts.afterReply(l.peer, l.far.thread, { words: "Words saved there", clear_draft: saved.body.draft.updated_at, uploads: [] }, "reply-s");
      expect(l.drafts.read(l.peer, l.far.thread)?.draft).toBeNull();
      expect(l.drafts.overlay([l.row()])[0]!.unsent).toBeNull();
      expect(await l.drafts.rowsFor([l.peer], l.drafts.overlay([l.row()]))).toEqual([]);
      l.restart();
      expect(l.drafts.read(l.peer, l.far.thread)?.draft).toBeNull();
      l.replies.set("reply-s", outcome);
      l.drafts.replySettled(MACHINE, "reply-s");
      if (outcome === "refused") expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words saved there");
      await l.back();
      expect(l.far.store.replyDraft(l.far.thread)?.body ?? null).toBe(outcome === "delivered" ? null : "Words saved there");
    });
  }

  test("Discard while a save is still on its way: the version it lands as goes too (online, and after a restart with a held save landed); newer words typed there still stay", async () => {
    const l = linked();
    l.peer.state = "online";
    const shown = await answerOf(await l.save({ body: "Words", base: null }));
    // The window's next save landed there, its answer not back yet as Discard is pressed: it names the version shown.
    l.far.store.saveReplyDraft(l.far.thread, { body: "Words and more", base: shown.body.draft.updated_at });
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: shown.body.draft.updated_at, base_body: "Words and more" }))).status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    // Held while it slept, landed, then this Inbox restarted: a Discard naming the version shown while it was held.
    l.peer.state = "offline";
    const held = await answerOf(await l.save({ body: "Typed while it slept", base: null }));
    await l.back();
    l.restart();
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: held.body.draft.updated_at, base_body: "Typed while it slept" }))).status).toBe(200);
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    // The same while it sleeps again: the Discard is held, and goes once it is back.
    l.peer.state = "offline";
    const again = await answerOf(await l.save({ body: "Typed again while it slept", base: null }));
    await l.back();
    l.restart();
    l.peer.state = "offline";
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: again.body.draft.updated_at, base_body: "Typed again while it slept" }))).status).toBe(200);
    await l.back();
    expect(l.far.store.replyDraft(l.far.thread)).toBeNull();
    // Other words there: refused, and they stay.
    const mine = await answerOf(await l.save({ body: "Mine", base: null }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Newer words typed on the MacBook", base: mine.body.draft.updated_at });
    expect((await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { base: mine.body.draft.updated_at, base_body: "Mine" }))).status).toBe(409);
    expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Newer words typed on the MacBook");
  });

  test("offered words are settled only by a draft of those very words, never one that merely contains them", async () => {
    const l = linked();
    l.peer.state = "online";
    await answerOf(await l.save({ body: "Shared start", base: null }));
    const offered = await offeredConflict(l, "ok");
    const there = l.far.store.replyDraft(l.far.thread)!;
    await answerOf(await l.save({ body: "ok, but not before the deploy", base: there.updated_at, base_body: there.body }));
    expect(l.drafts.notLanded(MACHINE, l.far.thread)).toEqual(offered);
  });

  test("offered words waiting in turn are bounded: the oldest stay, a new one past the cap takes the newest's place", async () => {
    const l = linked();
    l.peer.state = "online";
    await answerOf(await l.save({ body: "Shared start", base: null }));
    for (let n = 0; n <= MORE_OFFERED_MAX + 1; n++) await offeredConflict(l, `Held words ${n}`);
    const words: string[] = [];
    for (let left = l.drafts.notLanded(MACHINE, l.far.thread); left; left = l.drafts.notLanded(MACHINE, l.far.thread)) {
      words.push(left.words);
      await answerOf(await l.drafts.write(l.peer, l.far.thread, true, { not_landed: left.version }));
    }
    expect(words).toEqual([...Array.from({ length: MORE_OFFERED_MAX }, (_, n) => `Held words ${n}`), `Held words ${MORE_OFFERED_MAX + 1}`]);
  });

  test("Unlink while a held reply carries the draft: its words are not handed back a second time (the reply is in Not sent); kept on disk when asked", async () => {
    const l = linked();
    const held = await answerOf(await l.save({ body: "Words the reply carries", base: null }));
    l.drafts.afterReply(l.peer, l.far.thread, { words: "Words the reply carries", clear_draft: held.body.draft.updated_at, uploads: [] }, "reply-u");
    expect(l.drafts.forget(MACHINE, true)).toEqual([]);
    expect(l.heldFiles().length).toBe(1);
    l.drafts.forget(MACHINE);
    expect(l.heldFiles()).toEqual([]);
  });

  test("a save held after that machine said its draft changed (this Inbox's own write) stands on the draft last heard: its file and quote stay", async () => {
    const l = linked();
    l.peer.state = "online";
    const file = await receiveInboxUpload(l.far.store.dir, "trace.txt", new Response("bytes").body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const start = await answerOf(await l.save({ body: "Start", base: null, files_add: [{ upload_id: file.upload_id }], quote: { of: l.far.thread, words: "the webhook" } }));
    await Bun.sleep(5);
    // Its stream says the draft changed (this very save), then it goes to sleep before any window reads it again.
    l.drafts.farChanged(MACHINE, l.far.thread);
    l.peer.state = "offline";
    const held = await answerOf(await l.save({ body: "Longer words typed while it sleeps", base: start.body.draft.updated_at, base_body: "Start" }));
    expect(held.body.draft).toMatchObject({ body: "Longer words typed while it sleeps", quote: { of: l.far.thread, words: "the webhook" } });
    expect(held.body.draft.files.map((f: { name: string }) => f.name)).toEqual(["trace.txt"]);
    expect(l.drafts.forget(MACHINE)).toEqual([{ thread: l.far.thread, words: "Longer words typed while it sleeps", files: ["trace.txt"], quote: { of: l.far.thread, words: "the webhook" } }]);
  });

  for (const how of ["Send", "Discard"] as const) {
    test(`words ${how === "Send" ? "sent" : "discarded"} there after this Inbox last heard them never come back here while that machine sleeps: no draft shows, and words typed then land as typed`, async () => {
      const l = linked();
      l.peer.state = "online";
      const file = await receiveInboxUpload(l.far.store.dir, "trace.txt", new Response("bytes").body, { at: new Date().toISOString() });
      l.drafts.noteUpload(Response.json({ upload: file }));
      const kept = await answerOf(await l.save({ body: "Refund Ada Novak in full", base: null, files_add: [{ upload_id: file.upload_id }] }));
      await Bun.sleep(5);
      // There, on that machine: the draft is sent (or discarded); its stream says so, its list read again first.
      if (how === "Send") expect(l.far.store.clearSentReplyDraft(l.far.thread, kept.body.draft.updated_at, "Refund Ada Novak in full", [file.upload_id])).toBe(true);
      else expect(l.far.store.deleteReplyDraft(l.far.thread)).toBe(true);
      l.peer.list = { marks: ["reply-drafts"], rows: [l.row()] };
      l.drafts.farChanged(MACHINE, l.far.thread);
      l.peer.state = "offline";
      // Never the words already sent or thrown away, so no Send of them again and no typing over them.
      expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
      const typed = await answerOf(await l.save({ body: "Something new", base: null }));
      expect(typed.body.draft.body).toBe("Something new");
      expect(typed.body.draft.files ?? []).toEqual([]);
      await l.back();
      expect(l.far.store.replyDraft(l.far.thread)?.body).toBe("Something new");
      expect(l.far.store.replyDraft(l.far.thread)?.files ?? []).toEqual([]);
      expect(l.drafts.notLanded(MACHINE, l.far.thread)).toBeNull();
    });
  }

  test("that machine says its draft changed and its list names the version last heard (this Inbox's own write): while it sleeps, that draft still shows", async () => {
    const l = linked();
    l.peer.state = "online";
    await answerOf(await l.save({ body: "Words saved there", base: null }));
    await Bun.sleep(5);
    l.peer.list = { marks: ["reply-drafts"], rows: [l.row()] };
    l.drafts.farChanged(MACHINE, l.far.thread);
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)?.draft?.body).toBe("Words saved there");
  });

  test("a held save that lands without a file it added keeps no words on disk here; sent there, the file's name and the row's Draft mark go too", async () => {
    const l = linked();
    const upload = (name: string) => receiveInboxUpload(l.far.store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const kept = await upload("trace.txt");
    const swept = await upload("screenshot.png");
    for (const file of [kept, swept]) l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const secret = "Refund Bob Tully, see the picture";
    await answerOf(await l.save({ body: secret, base: null, files_add: [{ upload_id: kept.upload_id }, { upload_id: swept.upload_id }] }));
    removeInboxUploads(l.far.store.dir, [swept.upload_id]);
    await l.back();
    const there = l.far.store.replyDraft(l.far.thread)!;
    expect(there.body).toBe(secret);
    // Only the file's name is kept here, to say it on its tile: never the words, which are there.
    expect(l.drafts.notLanded(MACHINE, l.far.thread)?.files?.map((file) => file.name)).toEqual(["screenshot.png"]);
    expect(l.heldFiles()).toEqual([`${l.far.thread}.json`]);
    expect(readFileSync(join(l.heldDir, `${l.far.thread}.json`), "utf8")).not.toContain(secret);
    // Its Send there (a phone, or that machine's own window): the list says no draft, and nothing of it stays here.
    expect(l.far.store.clearSentReplyDraft(l.far.thread, there.updated_at, secret, [kept.upload_id])).toBe(true);
    l.listed();
    l.drafts.farChanged(MACHINE, l.far.thread);
    expect(l.heldFiles()).toEqual([]);
    expect(l.drafts.overlay([l.row()])[0]!.unsent).toBeNull();
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
  });

  test("words offered beside the draft there: the row's Draft mark follows that machine's list (newer words there, then its Send), never the copy kept when they met", async () => {
    const l = linked();
    l.peer.state = "online";
    const start = await answerOf(await l.save({ body: "Shared start", base: null }));
    l.peer.state = "offline";
    const mine = await answerOf(await l.save({ body: "Shared start, typed on the Studio", base: start.body.draft.updated_at, base_body: "Shared start" }));
    l.far.store.saveReplyDraft(l.far.thread, { body: "Shared start, typed on the MacBook", base: start.body.draft.updated_at });
    await l.back();
    expect(l.drafts.notLanded(MACHINE, l.far.thread)?.conflict).toBe(true);
    await Bun.sleep(5);
    const newer = l.far.store.saveReplyDraft(l.far.thread, { body: "Newer words on the MacBook", base: l.far.store.replyDraft(l.far.thread)!.updated_at })!;
    l.listed();
    expect(l.drafts.overlay([l.row()])[0]!.unsent?.reply_at).toBe(newer.updated_at);
    expect(l.far.store.clearSentReplyDraft(l.far.thread, newer.updated_at, newer.body, [])).toBe(true);
    l.listed();
    // Their draft went; the person's own words are still offered, so the mark stays, on their version.
    expect(l.drafts.overlay([l.row()])[0]!.unsent?.reply_at).toBe(mine.body.draft.updated_at);
  });

  test("Unlink while a save is on its way that then gets no answer: nothing is held for the unlinked machine, and the words go to Not sent", async () => {
    const l = linked();
    l.peer.state = "online";
    let release!: () => void;
    l.gateNextPost(new Promise<void>((resolve) => (release = resolve)));
    const saving = l.save({ body: "Words on their way as Unlink runs", base: null });
    await Bun.sleep(5);
    expect(l.unlink()).toEqual([]);
    release();
    expect((await answerOf(await saving)).status).toBe(404);
    expect(l.heldFiles()).toEqual([]);
    expect(l.lost).toEqual([{ thread: l.far.thread, words: "Words on their way as Unlink runs", files: [], quote: null }]);
    expect(l.drafts.heldCount(MACHINE)).toBe(0);
  });

  test("that machine says its draft changed but its list could not be read again: while it sleeps, the draft last heard is not shown", async () => {
    const l = linked();
    l.peer.state = "online";
    await answerOf(await l.save({ body: "Words a phone sends there", base: null }));
    // The list held still names this draft; then it is sent there, and the read of the list for it fails.
    l.listed();
    expect(l.far.store.deleteReplyDraft(l.far.thread)).toBe(true);
    l.drafts.farChanged(MACHINE, l.far.thread, false);
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
  });

  test("a draft discarded there while the stream was down: the list read as it reconnects says so, and while it sleeps after, the draft last heard is not shown", async () => {
    const l = linked();
    l.peer.state = "online";
    await answerOf(await l.save({ body: "Words thrown away there while the line was down", base: null }));
    l.listed();
    expect(l.far.store.deleteReplyDraft(l.far.thread)).toBe(true);
    // Its hello: the list is read again (no draft named), with no `drafts` frame for it. Then it sleeps.
    l.listed();
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)).toEqual({ draft: null });
  });

  test("a draft saved there just now still shows while that machine sleeps: before its list is read again, and when a read started before it landed lands after it", async () => {
    const l = linked();
    l.peer.state = "online";
    const before = l.row();
    // A read of the list is on its way as the save lands; it answers after, with the list as it was before.
    const asked = ++l.peer.listAsked;
    const saved = await answerOf(await l.save({ body: "Typed just now", base: null }));
    l.peer.state = "offline";
    expect(l.drafts.read(l.peer, l.far.thread)?.draft).toEqual(saved.body.draft);
    l.listed([before], asked);
    expect(l.drafts.read(l.peer, l.far.thread)?.draft).toEqual(saved.body.draft);
    // A read started after it names it too: still shown.
    l.listed();
    expect(l.drafts.read(l.peer, l.far.thread)?.draft).toEqual(saved.body.draft);
  });

  test("Unlink: a held draft is counted, and every word of it handed back to keep, its file and quote named; nothing of it stays held", async () => {
    const l = linked();
    const file = await receiveInboxUpload(l.far.store.dir, "trace.txt", new Response("bytes").body, { at: new Date().toISOString() });
    l.drafts.noteUpload(Response.json({ upload: file }));
    await Bun.sleep(5);
    const long = `Words for a machine about to go ${"and more ".repeat(5_000)}`;
    await answerOf(await l.save({ body: long, base: null, files_add: [{ upload_id: file.upload_id }], quote: { of: l.far.thread, words: "the webhook" } }));
    expect(l.drafts.heldCount(MACHINE)).toBe(1);
    const lost = l.drafts.forget(MACHINE);
    expect(lost).toEqual([{ thread: l.far.thread, words: long, files: ["trace.txt"], quote: { of: l.far.thread, words: "the webhook" } }]);
    const parts = lostDraftParts(lost[0]!, 10_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(`${long}\n\nReplying to words in a message: “the webhook”\n\nAttached: trace.txt`);
    expect(l.drafts.heldCount(MACHINE)).toBe(0);
    expect(l.heldFiles()).toEqual([]);
    l.restart();
    expect(l.drafts.read(l.peer, l.far.thread)).toBeNull();
  });

  test("a machine whose list lacks the mark (an older Plannotator) gets no Drafts rows from here", async () => {
    const l = linked({ marks: [] });
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed on the MacBook", base: null });
    expect(await l.drafts.rowsFor([l.peer], [l.row()])).toEqual([]);
  });

  test("the Drafts page reads a far draft's first words once", async () => {
    const l = linked();
    l.peer.state = "online";
    l.far.store.saveReplyDraft(l.far.thread, { body: "Typed   on\nthe MacBook", base: null });
    const [listed] = await l.drafts.rowsFor([l.peer], [l.row()]);
    expect(listed!.reply_preview).toBe("Typed on the MacBook");
    await l.drafts.rowsFor([l.peer], [l.row()]);
    expect(l.gets.filter((r) => r === `threads/${l.far.thread}/draft`)).toHaveLength(1);
  });
});

describe("one set of draft rules: a held draft becomes what that machine's own store makes of the same saves", () => {
  /** What a draft is, its time aside (each keeper stamps its own). */
  const shape = (draft: InboxReplyDraft | null) =>
    draft && { body: draft.body, files: (draft.files ?? []).map((f) => ({ id: f.upload_id, pasted: f.pasted ?? null })), recipients: draft.recipients ?? [], quote: draft.quote ?? null, mentions: draft.mentions ?? [] };

  test("save by save, local and far give the same draft and the same refusals", async () => {
    const l = linked();
    const store = l.far.store;
    const upload = (name: string) => receiveInboxUpload(store.dir, name, new Response(`bytes of ${name}`).body, { at: new Date().toISOString() });
    const a = await upload("a.txt");
    const b = await upload("b.txt");
    for (const file of [a, b]) l.drafts.noteUpload(Response.json({ upload: file }));
    const T = l.far.thread;
    // The starting draft, on that machine, as this Inbox heard it.
    const d0 = store.saveReplyDraft(T, { body: "See Refunds for context", base: null, files_add: [{ upload_id: a.upload_id }], files_remove: [], files_place: [], mentions: [{ thread_id: T, title: "Refunds", label: "Refunds", at: 4 }] })!;
    l.drafts.noteRead(MACHINE, T, Response.json({ draft: d0 }));
    await Bun.sleep(5);
    const ops = { files_add: [], files_remove: [], files_place: [] };
    const STALE = "2000-01-01T00:00:00.000Z";
    /** Each save, given the draft each keeper holds before it (its `updated_at` and words), and what both must answer. */
    const steps: { name: string; input: (prior: InboxReplyDraft | null) => Record<string, unknown>; refused?: boolean }[] = [
      { name: "words change in front: the mention moves with them; a file, recipients and a quote added", input: (p) => ({ ...ops, body: "Please see Refunds for context", base: p!.updated_at, files_add: [{ upload_id: b.upload_id }], recipients: ["ses_a"], quote: { of: T } }) },
      { name: "a step behind on its own words: taken", input: (p) => ({ ...ops, body: "Please see Refunds for context now", base: STALE, base_body: p!.body, files_remove: [a.upload_id] }) },
      { name: "a step behind on other words: refused", input: () => ({ ...ops, body: "Other words", base: STALE, base_body: "Not these" }), refused: true },
      { name: "an older page's whole list, its own words and files: taken", input: (p) => ({ body: "Final words", base: STALE, base_body: p!.body, files: [b.upload_id], all_files: true, base_files: [b.upload_id] }) },
      { name: "an older page's whole list, its own words but other files: refused", input: (p) => ({ body: "Final words, again", base: STALE, base_body: p!.body, files: [b.upload_id], all_files: true, base_files: [a.upload_id] }), refused: true },
      { name: "no words and no file left: no draft", input: (p) => ({ ...ops, body: "  ", base: p!.updated_at, files_remove: [b.upload_id] }) },
    ];
    let local: InboxReplyDraft | null = d0;
    let far: InboxReplyDraft | null = d0;
    for (const step of steps) {
      let localRefused = false;
      try {
        local = store.saveReplyDraft(T, step.input(local) as never);
      } catch (error) {
        expect((error as InboxError).code).toBe("draft_conflict");
        localRefused = true;
      }
      // As sent: an older page's whole list carries no file changes.
      const answer = await answerOf(await l.drafts.write(l.peer, T, false, step.input(far)));
      expect({ step: step.name, refused: answer.status === 409 }).toEqual({ step: step.name, refused: !!step.refused });
      expect({ step: step.name, refused: localRefused }).toEqual({ step: step.name, refused: !!step.refused });
      if (step.refused) {
        expect(answer.body.code).toBe("draft_conflict");
        continue;
      }
      far = answer.body.draft;
      expect({ step: step.name, draft: shape(far) }).toEqual({ step: step.name, draft: shape(local) });
    }
    expect(far).toBeNull();
    expect(shape(local)).toBeNull();
  });
});

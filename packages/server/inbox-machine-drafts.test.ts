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
import { createMachineDrafts, lostDraftParts, type DraftAnswer, type DraftPeer } from "./inbox-machine-drafts";
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
  const routes = createInboxReplyDrafts({
    store,
    serverSession: "far-session",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
  });
  /** As that machine's door (inbox-devices.ts `claim`): a key it answered once is answered the same again, never applied twice. */
  const seen = new Map<string, { status: number; text: string }>();
  const door = async (route: string, init: { method: string; body?: string }) => {
    const key = init.method === "POST" ? (JSON.parse(init.body ?? "{}") as { idempotency_key?: string }).idempotency_key : undefined;
    const replay = key ? seen.get(`${route} ${key}`) : undefined;
    if (replay) return new Response(replay.text, { status: replay.status, headers: { "Content-Type": "application/json" } });
    const req = new Request(`http://far.local/api/inbox/${route}`, { method: init.method, headers: { "Content-Type": "application/json" }, body: init.body });
    let answer: Response;
    try {
      answer = (await routes.route(req, new URL(req.url))) ?? Response.json({ code: "device_route_not_found" }, { status: 404 });
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      answer = Response.json({ error: error.message, code: error.code, ...error.details }, { status: error.code === "draft_conflict" ? 409 : error.code.endsWith("_not_found") ? 404 : 422 });
    }
    if (key && answer.status < 500) seen.set(`${route} ${key}`, { status: answer.status, text: await answer.clone().text() });
    return answer;
  };
  return { store, thread, door };
}

function linked(options: { marks?: string[] } = {}) {
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
  const row = (): InboxListRow & { machine: string } => ({ ...(far.store.listRows().find((r) => r.thread_id === far.thread) as InboxListRow), machine: MACHINE });
  const peer: DraftPeer & { state: string } = {
    id: MACHINE,
    state: "offline",
    list: { marks: options.marks ?? ["reply-drafts"], rows: [] },
    async request(route, _search, init) {
      if (peer.state !== "online") throw new Error("unreachable");
      if (init.method === "GET") gets.push(route);
      else {
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
    createMachineDrafts({ dataDir: here, peer: () => peer, onChange: (_m, threadId) => changes.push(threadId), retryMs: 60_000, replyState: (k) => replies.get(k) ?? "pending", log: (line) => logged.push(line) });
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

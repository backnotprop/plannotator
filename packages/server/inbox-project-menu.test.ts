/**
 * The project menu through the Inbox's real doors (design record
 * "inbox-project-menu", approved 2026-10-14): `POST
 * /api/inbox/projects/:id/read`, `/unread` and `/resolve` on a running Inbox
 * (temp data dir, loopback). Each is a loop over the single actions, so what
 * is proved here is which threads a batch takes, that its Undo touches
 * exactly those, the `batch_id` replay, the guards, the set-aside notes
 * (one per thread, after the Undo window, none when undone inside it), and
 * the folders' additive `listed` / `archived` counts that hide a project.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxListRow, InboxListSection } from "@plannotator/core/inbox-types";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DELAY = 150;

const ask = (prompt: string, extra: string[] = []) =>
  [":::question", prompt, "", ...extra, ...(extra.length ? [""] : []), "- [ ] Yes", "- [ ] No", ":::"].join("\n");

/**
 * Two projects. `billing`: a thread an agent is stopped on, one waiting on a
 * question, one with plain news, one the person replied to (Sent), one quiet
 * (looked at), one archived, and one that came back from the archive.
 * `docs`: one thread waiting on a question.
 */
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-project-menu-")));
  roots.push(root);
  for (const name of ["billing", "docs"]) mkdirSync(join(root, name), { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: DELAY });
  servers.push(server);
  const store = server.store;
  const billing = store.ensureProject({ name: "billing", root: join(root, "billing") });
  const docs = store.ensureProject({ name: "docs", root: join(root, "docs") });
  const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
  const send = (project: string, session: string, body: string, reply_to?: string) =>
    store.sendMessage({ project_id: project, author: agent(session), body, ...(reply_to ? { reply_to } : {}) }).message;
  const stopped = send(billing.id, "ses_1", ask("Which layout?", ["Stopped: the list waits on this."]));
  const waiting = send(billing.id, "ses_2", ask("Ship today?"));
  const news = send(billing.id, "ses_3", "The index is built.");
  const sent = send(billing.id, "ses_4", "Draft ready.");
  store.sendReply(sent.id, { words: "Thanks", idempotency_key: "k-sent", questions: [] });
  const quiet = send(billing.id, "ses_5", "FYI.");
  store.markSeen(quiet.id);
  const archived = send(billing.id, "ses_6", "Old work.");
  store.resolveThread(archived.id, true);
  const cameBack = send(billing.id, "ses_7", "Earlier work.");
  store.resolveThread(cameBack.id, true);
  send(billing.id, "ses_7", ask("Keep the old route?"), cameBack.id);
  const other = send(docs.id, "ses_8", ask("Which search index?"));
  return { server, store, billing: billing.id, docs: docs.id, stopped: stopped.id, waiting: waiting.id, news: news.id, sent: sent.id, quiet: quiet.id, archived: archived.id, cameBack: cameBack.id, other: other.id };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

type Folder = { id: string; threads: number; unread: number; listed: number; archived: number };

async function folders(server: InboxServer): Promise<Map<string, Folder>> {
  const model = (await (await fetch(url(server, "/api/inbox/projects"))).json()) as { projects: Folder[] };
  return new Map(model.projects.map((p) => [p.id, p]));
}

async function sections(server: InboxServer): Promise<Map<string, string>> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return new Map(model.sections.flatMap((s) => s.threads.map((r) => [r.thread_id, s.id] as const)));
}

describe("the project menu's routes", () => {
  test("Mark all as read takes exactly the threads waiting on the person, and its Undo puts them back", async () => {
    const w = await setup();
    const before = await sections(w.server);
    const res = await post(w.server, `/api/inbox/projects/${w.billing}/read`, { serverSession: w.server.serverSession });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: { read: string[] }; threads: InboxListRow[]; project: Folder; replayed: boolean };
    // Stopped, Waiting, plain news and the came-back thread; not Sent, Quiet, archived, nor the other project.
    expect(new Set(body.batch.read)).toEqual(new Set([w.stopped, w.waiting, w.news, w.cameBack]));
    expect(body.replayed).toBe(false);
    expect(body.threads.every((row) => row.section === "quiet")).toBe(true);
    const after = await sections(w.server);
    for (const id of [w.stopped, w.waiting, w.news]) expect(after.get(id)).toBe("quiet");
    // The came-back thread went back to the archive (read made after the line).
    expect(w.store.listRow(w.cameBack)!.back_from_archive).toBe(false);
    for (const id of [w.sent, w.quiet, w.archived, w.other]) expect(after.get(id)).toBe(before.get(id));
    // The questions closed as skips; no decision.
    const stoppedQ = w.store.questionsOf(w.stopped)[0]!;
    expect(stoppedQ).toMatchObject({ state: "closed", answer: { skipped: true } });

    const undo = await post(w.server, `/api/inbox/projects/${w.billing}/unread`, { threads: body.batch.read });
    expect(undo.status).toBe(200);
    expect(await sections(w.server)).toEqual(before);
    expect(w.store.questionsOf(w.stopped)[0]).toMatchObject({ state: "open", answer: null });
  });

  test("each thread's own set-aside note goes after the Undo window; none when undone inside it", async () => {
    const w = await setup();
    const res = await post(w.server, `/api/inbox/projects/${w.billing}/read`, {});
    const { batch } = (await res.json()) as { batch: { read: string[] } };
    await post(w.server, `/api/inbox/projects/${w.billing}/unread`, { threads: batch.read });
    await Bun.sleep(DELAY + 200);
    for (const id of batch.read) expect(w.store.thread(id)!.messages.some((m) => m.body.startsWith(INBOX_SET_ASIDE_HEADING))).toBe(false);

    const again = (await (await post(w.server, `/api/inbox/projects/${w.billing}/read`, {})).json()) as { batch: { read: string[] } };
    await Bun.sleep(DELAY + 200);
    const notes = (id: string) => w.store.thread(id)!.messages.filter((m) => m.body.startsWith(INBOX_SET_ASIDE_HEADING)).length;
    // A note per thread that had a question waiting (not per batch); plain news had none to set aside.
    expect(notes(w.stopped)).toBe(1);
    expect(notes(w.waiting)).toBe(1);
    expect(notes(w.cameBack)).toBe(1);
    expect(notes(w.news)).toBe(0);
    expect(again.batch.read).toContain(w.news);
  });

  test("Archive all resolves every listed thread, sends a came-back one back with Mark read, and the project hides", async () => {
    const w = await setup();
    const before = await sections(w.server);
    expect((await folders(w.server)).get(w.billing)).toMatchObject({ threads: 7, listed: 6, archived: 1 });
    const res = await post(w.server, `/api/inbox/projects/${w.billing}/resolve`, { resolved: true, batch_id: "b-archive" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: { resolved: string[]; read: string[] }; project: Folder };
    expect(new Set(body.batch.resolved)).toEqual(new Set([w.stopped, w.waiting, w.news, w.sent, w.quiet]));
    expect(body.batch.read).toEqual([w.cameBack]);
    expect(body.project).toMatchObject({ listed: 0, archived: 7 });
    // The list model carries the same fields: the window draws `listed > 0`.
    const list = (await (await fetch(url(w.server, "/api/inbox/threads?archived=exclude"))).json()) as { projects: Folder[]; sections: InboxListSection[] };
    expect(list.projects.find((p) => p.id === w.billing)).toMatchObject({ listed: 0, archived: 7 });
    expect(list.projects.find((p) => p.id === w.docs)).toMatchObject({ listed: 1, archived: 0 });
    expect(list.sections.flatMap((s) => s.threads).every((r) => r.project.id !== w.billing)).toBe(true);

    const undo = await post(w.server, `/api/inbox/projects/${w.billing}/resolve`, { resolved: false, threads: body.batch });
    expect(undo.status).toBe(200);
    expect(await sections(w.server)).toEqual(before);
    expect((await folders(w.server)).get(w.billing)).toMatchObject({ listed: 6, archived: 1 });
  });

  test("a hidden project comes back with the next thread that puts it in the list", async () => {
    const w = await setup();
    await post(w.server, `/api/inbox/projects/${w.billing}/resolve`, { resolved: true });
    expect((await folders(w.server)).get(w.billing)!.listed).toBe(0);
    // A reply_to after the archive brings that thread back, and with it the project.
    w.store.sendMessage({ project_id: w.billing, author: { kind: "agent", host: null, session: "ses_2", name: null }, body: "One more thing.", reply_to: w.waiting });
    expect((await folders(w.server)).get(w.billing)!.listed).toBe(1);
  });

  test("batch_id: a retry answers the first answer and writes nothing; another request's id is refused", async () => {
    const w = await setup();
    const first = (await (await post(w.server, `/api/inbox/projects/${w.billing}/read`, { batch_id: "b-1" })).json()) as Record<string, unknown>;
    const cursor = w.store.cursor();
    const retry = (await (await post(w.server, `/api/inbox/projects/${w.billing}/read`, { batch_id: "b-1" })).json()) as Record<string, unknown>;
    expect(retry.replayed).toBe(true);
    expect({ ...retry, replayed: false }).toEqual(first);
    expect(w.store.cursor()).toBe(cursor);
    // Without the id a second call finds nothing waiting and writes nothing.
    const plain = (await (await post(w.server, `/api/inbox/projects/${w.billing}/read`, {})).json()) as { batch: { read: string[] } };
    expect(plain.batch.read).toEqual([]);
    expect(w.store.cursor()).toBe(cursor);
    const reused = await post(w.server, `/api/inbox/projects/${w.docs}/read`, { batch_id: "b-1" });
    expect([reused.status, ((await reused.json()) as { code: string }).code]).toEqual([409, "batch_id_reused"]);
    const bad = await post(w.server, `/api/inbox/projects/${w.billing}/read`, { batch_id: "no spaces" });
    expect(bad.status).toBe(422);
  });

  test("a write that fails partway: what applied is answered (with its notes and Undo), flagged, and remembered for the batch_id", async () => {
    const w = await setup();
    const real = w.store.markRead.bind(w.store);
    let calls = 0;
    // The second Mark read of the loop fails, as a disk error would.
    w.store.markRead = ((threadId: string, read: boolean) => {
      calls += 1;
      if (read && calls === 2) throw new Error("EIO: the disk went away");
      return real(threadId, read);
    }) as typeof w.store.markRead;
    const res = await post(w.server, `/api/inbox/projects/${w.billing}/read`, { batch_id: "b-partial" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: { read: string[] }; error?: { code: string; message: string } };
    expect(body.batch.read).toHaveLength(1);
    expect(body.error?.code).toBe("batch_incomplete");
    // The cause stays in the server's log, never the page.
    expect(body.error?.message).not.toContain("EIO");
    const applied = body.batch.read[0]!;
    expect(w.store.listRow(applied)!.read_at).not.toBeNull();
    // A retry with the same batch_id answers the same partial answer and writes nothing.
    const cursor = w.store.cursor();
    const retry = (await (await post(w.server, `/api/inbox/projects/${w.billing}/read`, { batch_id: "b-partial" })).json()) as typeof body & { replayed: boolean };
    expect(retry.replayed).toBe(true);
    expect(retry.batch.read).toEqual(body.batch.read);
    expect(w.store.cursor()).toBe(cursor);
    w.store.markRead = real;
    // The thread that applied gets its set-aside note.
    await Bun.sleep(DELAY + 200);
    expect(w.store.thread(applied)!.messages.some((m) => m.body.startsWith(INBOX_SET_ASIDE_HEADING))).toBe(applied !== w.news);
    // Its Undo covers exactly what applied.
    const undo = (await (await post(w.server, `/api/inbox/projects/${w.billing}/unread`, { threads: body.batch.read })).json()) as { skipped: string[] };
    expect(undo.skipped).toEqual([]);
    expect(w.store.listRow(applied)!.read_at ?? null).toBeNull();
  });

  test("Archive all that fails partway answers the threads it resolved", async () => {
    const w = await setup();
    const real = w.store.resolveThread.bind(w.store);
    let calls = 0;
    w.store.resolveThread = ((id: string, resolved: boolean) => {
      calls += 1;
      if (resolved && calls === 3) throw new Error("ENOSPC");
      return real(id, resolved);
    }) as typeof w.store.resolveThread;
    const body = (await (await post(w.server, `/api/inbox/projects/${w.billing}/resolve`, { resolved: true })).json()) as { batch: { resolved: string[]; read: string[] }; error?: { code: string } };
    w.store.resolveThread = real;
    expect(body.batch.resolved).toHaveLength(2);
    expect(body.error?.code).toBe("batch_incomplete");
    for (const id of body.batch.resolved) expect(w.store.message(id)!.resolved_at).not.toBeNull();
  });

  test("an Undo touches only the threads it names, and only this project's", async () => {
    const w = await setup();
    // The other project's thread named in billing's Undo: skipped, untouched.
    await post(w.server, `/api/inbox/projects/${w.docs}/read`, {});
    const undo = (await (await post(w.server, `/api/inbox/projects/${w.billing}/unread`, { threads: [w.other] })).json()) as { skipped: string[] };
    expect(undo.skipped).toEqual([w.other]);
    expect(w.store.listRow(w.other)!.section).toBe("quiet");
    const bad = await post(w.server, `/api/inbox/projects/${w.billing}/unread`, { threads: ["not-an-id"] });
    expect(bad.status).toBe(422);
    const badResolve = await post(w.server, `/api/inbox/projects/${w.billing}/resolve`, { resolved: false, threads: [w.other] });
    expect(badResolve.status).toBe(422);
  });

  test("the window's guards: another site, another session's tab, a GET, a malformed or unknown project", async () => {
    const w = await setup();
    const path = `/api/inbox/projects/${w.billing}/resolve`;
    const cross = await post(w.server, path, { resolved: true }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    const stale = await post(w.server, path, { resolved: true, serverSession: "an-older-inbox" });
    expect(stale.status).toBe(409);
    expect((await fetch(url(w.server, path))).status).toBe(405);
    expect((await post(w.server, "/api/inbox/projects/nope/read", {})).status).toBe(422);
    expect((await post(w.server, "/api/inbox/projects/prj_00000000000000000000000000/read", {})).status).toBe(404);
    // Nothing above changed anything.
    expect((await folders(w.server)).get(w.billing)!.listed).toBe(6);
  });
});

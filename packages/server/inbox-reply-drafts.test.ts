/**
 * Reply drafts (approval "inbox-reply-drafts") through the Inbox's real
 * doors on a running Inbox (temp data dir, loopback): the words typed in a
 * thread's reply box, kept per thread outside the event log. Saved with a
 * compare-and-set, read back, discarded, cleared by the Send that carries
 * them, kept across a restart, gone with their thread; never seen by an
 * agent through the MCP. The row's `unsent` and the section rule: a thread
 * holding unsent work never sits in Quiet unless archived.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxReplyDraft, InboxUpload } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ASK = ["Which index should the docs use?", "", ":::question", "Which search index?", "", "- [ ] Pagefind", "- [ ] Orama", ":::"].join("\n");

async function start(dataDir: string) {
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000 });
  servers.push(server);
  const client = new Client({ name: "inbox-reply-drafts-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-drafts-")));
  roots.push(root);
  const project = join(root, "docs");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const { server, client } = await start(dataDir);
  const send = async (body: string, session: string, extra: Record<string, unknown> = {}) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", body, ...extra } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  return { root, project, dataDir, server, client, send };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

async function rowOf(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, "/api/inbox/threads?archived=exclude"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function saveDraft(server: InboxServer, threadId: string, body: string, base: string | null): Promise<InboxReplyDraft | null> {
  const response = await post(server, `/api/inbox/threads/${threadId}/draft`, { body, base });
  expect(response.status).toBe(200);
  return ((await response.json()) as { draft: InboxReplyDraft | null }).draft;
}

describe("reply drafts", () => {
  test("save, read back, a stale base is a conflict, an empty body deletes, Discard deletes", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_a");
    expect(((await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json()) as { draft: unknown }).draft).toBeNull();

    const first = (await saveDraft(server, thread_id, "Cards, but keep", null))!;
    expect(first).toMatchObject({ v: 1, thread_id, body: "Cards, but keep" });
    const second = (await saveDraft(server, thread_id, "Cards, but keep the totals", first.updated_at))!;
    expect(second.updated_at > first.updated_at).toBe(true);
    expect(second.created_at).toBe(first.created_at);
    const read = (await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json()) as { draft: InboxReplyDraft };
    expect(read.draft).toEqual(second);

    // Another window saved since: the old base is refused, and nothing changes.
    const stale = await post(server, `/api/inbox/threads/${thread_id}/draft`, { body: "lost", base: first.updated_at });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "draft_conflict", draft: second });

    // Emptied: deleted.
    expect(await saveDraft(server, thread_id, "   ", second.updated_at)).toBeNull();
    expect((await rowOf(server, thread_id)).unsent ?? null).toBeNull();
    await saveDraft(server, thread_id, "again", null);
    const discard = await post(server, `/api/inbox/threads/${thread_id}/draft/delete`, {});
    expect(await discard.json()).toEqual({ ok: true, deleted: true });
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("the row's unsent, and the section rule: a draft never sits in Quiet, and is not bold", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_a");
    expect(await post(server, `/api/inbox/threads/${thread_id}/seen`, {}).then((r) => r.status)).toBe(200);
    expect((await rowOf(server, thread_id)).section).toBe("quiet");

    const draft = (await saveDraft(server, thread_id, "Thanks, ship it", null))!;
    const row = await rowOf(server, thread_id);
    expect(row.unsent).toEqual({ reply_at: draft.updated_at, picks: 0, comments: 0 });
    expect(row.section).toBe("new");
    expect(row.unread).toBe(false);

    // Mark read keeps it in New while the words wait; discarding the words lets it go to Quiet.
    expect((await post(server, `/api/inbox/threads/${thread_id}/read`, {})).status).toBe(200);
    expect((await rowOf(server, thread_id)).section).toBe("new");
    await post(server, `/api/inbox/threads/${thread_id}/draft/delete`, {});
    expect((await rowOf(server, thread_id)).section).toBe("quiet");
  });

  test("picks only: the thread stays out of Quiet after it is seen, its row says how many", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send(ASK, "ses_b");
    const q = server.store.questionsOf(message_id)[0]!;
    server.store.savePicks(message_id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Pagefind"] } }]);
    await post(server, `/api/inbox/threads/${thread_id}/seen`, {});
    const row = await rowOf(server, thread_id);
    expect(row.unsent).toEqual({ reply_at: null, picks: 1, comments: 0 });
    expect(row.section).toBe("new");
    // "Answered, not sent" stays bold: it waits only for the person's Send.
    expect(row.unread).toBe(true);
  });

  test("the Send that carries the words clears the draft; a Send without clear_draft leaves it", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The build is green.", "ses_c");
    await saveDraft(server, thread_id, "Ship it", null);
    const kept = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k1", words: "From the phone" });
    expect(kept.status).toBe(200);
    expect(server.store.replyDraft(thread_id)?.body).toBe("Ship it");
    // An older window's `clear_draft: true` names no draft: nothing is cleared.
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k2", words: "Ship it", clear_draft: true })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)?.body).toBe("Ship it");
    const draft = server.store.replyDraft(thread_id)!;
    const cleared = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k3", words: "Ship it", clear_draft: draft.updated_at });
    expect(cleared.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
    expect((await rowOf(server, thread_id)).unsent ?? null).toBeNull();
  });

  test("clear_draft is a compare-and-set: a newer draft another window saved meanwhile stays", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The build is green.", "ses_c2");
    const mine = (await saveDraft(server, thread_id, "Ship it", null))!;
    // Another window types over it before this window's Send lands.
    const theirs = (await saveDraft(server, thread_id, "Ship it, and tag the release", mine.updated_at))!;
    const sent = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k1", words: "Ship it", clear_draft: mine.updated_at });
    expect(sent.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
    // That window's own Send clears its own draft.
    await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k2", words: theirs.body, clear_draft: theirs.updated_at });
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("a Send whose clear_draft names a stale updated_at (or none) still clears a draft holding exactly its words", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The build is green.", "ses_c5");
    // The window's last save landed without its answer: it still knows the first draft's updated_at.
    // The box's raw words are saved; the Send carries them trimmed.
    const first = (await saveDraft(server, thread_id, "Ship", null))!;
    await saveDraft(server, thread_id, "Ship it\n", first.updated_at);
    const stale = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k1", words: "Ship it", clear_draft: first.updated_at });
    expect(stale.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
    // No updated_at known at all ('').
    await saveDraft(server, thread_id, "Tag the release", null);
    const none = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k2", words: "Tag the release", clear_draft: "" });
    expect(none.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("a Send whose clear_draft names a stale updated_at leaves a draft holding different words", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The build is green.", "ses_c6");
    const mine = (await saveDraft(server, thread_id, "Ship it", null))!;
    // Another window's newer, different words.
    const theirs = (await saveDraft(server, thread_id, "Ship it, and tag the release", mine.updated_at))!;
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k1", words: "Ship it", clear_draft: mine.updated_at })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "k2", words: "Ship it", clear_draft: "" })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
  });

  test("a save sent as the page goes, a step behind on its base, lands when the draft holds the words it last wrote", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_c3");
    const first = (await saveDraft(server, thread_id, "Ship", null))!;
    // The window's next save landed, but the page went before its answer came back: base is still the first.
    await saveDraft(server, thread_id, "Ship it", first.updated_at);
    const stale = await post(server, `/api/inbox/threads/${thread_id}/draft`, { body: "Ship it now", base: first.updated_at });
    expect(stale.status).toBe(409);
    const kept = await post(server, `/api/inbox/threads/${thread_id}/draft`, { body: "Ship it now", base: first.updated_at, base_body: "Ship it" });
    expect(kept.status).toBe(200);
    expect(server.store.replyDraft(thread_id)?.body).toBe("Ship it now");
    // Words another window wrote are not this window's: still a conflict.
    const other = await post(server, `/api/inbox/threads/${thread_id}/draft`, { body: "mine", base: first.updated_at, base_body: "Ship it" });
    expect(other.status).toBe(409);
    expect((await post(server, `/api/inbox/threads/${thread_id}/draft`, { body: "x", base: null, base_body: 3 })).status).toBe(422);
  });

  test("agents read the section without the person's unsent work: a thread holding only a draft is quiet to them", async () => {
    const { server, client, send, project } = await setup();
    const { thread_id } = await send("The build is green.", "ses_c4");
    await post(server, `/api/inbox/threads/${thread_id}/seen`, {});
    await saveDraft(server, thread_id, "Ship it", null);
    expect((await rowOf(server, thread_id)).section).toBe("new");
    const list = (await client.callTool({ name: "read_thread", arguments: { project_path: project, agent_session: "ses_c4" } })) as {
      structuredContent?: { threads?: { thread_id: string; section: string }[] };
    };
    const rows = list.structuredContent?.threads ?? [];
    expect(rows.find((r) => r.thread_id === thread_id)?.section).toBe("quiet");
    expect(JSON.stringify(list)).not.toContain("Ship it");
  });

  test("search's status filter follows a draft's save and Discard", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_c5");
    await post(server, `/api/inbox/threads/${thread_id}/seen`, {});
    const total = async (status: string) => {
      for (let i = 0; i < 40; i++) {
        const body = (await (await fetch(url(server, `/api/inbox/search?q=build&status=${status}`))).json()) as { indexing: boolean; totals: { threads: number } | null };
        if (!body.indexing) return body.totals?.threads ?? 0;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the search index did not build");
    };
    expect(await total("quiet")).toBe(1);
    expect(await total("new")).toBe(0);
    await saveDraft(server, thread_id, "Ship it", null);
    expect(await total("new")).toBe(1);
    expect(await total("quiet")).toBe(0);
    expect((await post(server, `/api/inbox/threads/${thread_id}/draft/delete`, {})).status).toBe(200);
    expect(await total("quiet")).toBe(1);
  });

  test("never in the event log, never seen by an agent: read_thread carries none of it", async () => {
    const { server, client, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_d");
    const cursor = server.store.cursor();
    await saveDraft(server, thread_id, "SECRET-DRAFT-WORDS", null);
    expect(server.store.cursor()).toBe(cursor);
    expect(server.store.changesSince(cursor)).toEqual([]);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id, agent_session: "ses_d" } });
    expect(JSON.stringify(read)).not.toContain("SECRET-DRAFT-WORDS");
    const search = await (await fetch(url(server, "/api/inbox/search?q=SECRET"))).json();
    expect(JSON.stringify(search)).not.toContain("SECRET-DRAFT-WORDS");
  });

  test("kept across a restart; gone with its thread", async () => {
    const { dataDir, server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_e");
    const saved = (await saveDraft(server, thread_id, "Keep the totals column", null))!;
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const again = await start(dataDir);
    expect(again.server.store.replyDraft(thread_id)).toEqual(saved);
    expect((await rowOf(again.server, thread_id)).unsent?.reply_at).toBe(saved.updated_at);
    const file = join(again.server.store.dir, "reply-drafts", `${thread_id}.json`);
    expect(existsSync(file)).toBe(true);
    expect((await post(again.server, `/api/inbox/threads/${thread_id}/delete`, {})).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(again.server.store.replyDraft(thread_id)).toBeNull();
  });

  test("the Drafts route lists open threads holding unsent work; an archived one stays archived", async () => {
    const { server, send } = await setup();
    const words = await send("The build is green.", "ses_f");
    const picks = await send(ASK, "ses_g");
    const archived = await send("Old news.", "ses_h");
    await saveDraft(server, words.thread_id, "Thanks,   ship\n it", null);
    const q = server.store.questionsOf(picks.message_id)[0]!;
    server.store.savePicks(picks.message_id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Orama"] } }]);
    await saveDraft(server, archived.thread_id, "never mind", null);
    await post(server, `/api/inbox/messages/${archived.thread_id}/resolve`, { resolved: true });
    const answer = (await (await fetch(url(server, "/api/inbox/drafts"))).json()) as { replies: (InboxListRow & { reply_preview: string | null })[] };
    expect(answer.replies.map((r) => r.thread_id).sort()).toEqual([words.thread_id, picks.thread_id].sort());
    const byId = new Map(answer.replies.map((r) => [r.thread_id, r]));
    expect(byId.get(words.thread_id)!.reply_preview).toBe("Thanks, ship it");
    expect(byId.get(picks.thread_id)!.reply_preview).toBeNull();
    // Archived wins: archiving is the person's explicit "done"; its draft is kept.
    expect(server.store.replyDraft(archived.thread_id)?.body).toBe("never mind");
  });

  test("guards: another site's write and read are refused, a stale tab is refused, an unknown thread is 404, a bad body is 422", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_i");
    const path = `/api/inbox/threads/${thread_id}/draft`;
    expect((await post(server, path, { body: "x", base: null }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(server, path, { body: "x", base: null }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await fetch(url(server, path), { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    const stale = await fetch(url(server, path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: "not-this-one", body: "x", base: null }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("session_mismatch");
    expect((await post(server, "/api/inbox/threads/msg_01K70000000000000000000099/draft", { body: "x", base: null })).status).toBe(404);
    expect((await fetch(url(server, "/api/inbox/threads/msg_01K70000000000000000000099/draft"))).status).toBe(404);
    expect((await post(server, path, { body: 42, base: null })).status).toBe(422);
    expect((await post(server, path, { body: "x", base: 7 })).status).toBe(422);
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("every open window hears `event: drafts`; the phone's stream (no window id) does not", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_j");
    const controller = new AbortController();
    const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}&window=window-test-1&permission=granted`), { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Wait for hello, then save.
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
    await saveDraft(server, thread_id, "words", null);
    const deadline = Date.now() + 3000;
    while (!text.includes("event: drafts") && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain(`event: drafts\ndata: {"thread_id":"${thread_id}"}`);
  });
});

/**
 * A long paste kept beside the words (approval "inbox-paste-attachment"): the
 * reply draft's `files`, each a pending upload with where it goes back, read
 * back after a reload or in another window through `GET uploads/:id/text`.
 */
describe("reply drafts keep long pastes", () => {
  const LOG = "2026-11-01T21:10:04Z worker-3 retry 2 status=failed\n".repeat(700);
  const PREVIEW = "2026-11-01T21:10:04Z worker-3 retry 2 status=failed";
  const upload = async (server: InboxServer, name: string, bytes: string | Uint8Array): Promise<InboxUpload> => {
    const response = await fetch(url(server, `/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`), { method: "POST", body: bytes });
    expect(response.status).toBe(200);
    return ((await response.json()) as { upload: InboxUpload }).upload;
  };
  const pasted = (id: string, at: number) => ({ upload_id: id, pasted: { at, preview: PREVIEW } });
  const save = (server: InboxServer, threadId: string, body: Record<string, unknown>) => post(server, `/api/inbox/threads/${threadId}/draft`, body);
  const draftOf = async (response: Response) => ((await response.json()) as { draft: InboxReplyDraft | null }).draft;
  const textOf = async (server: InboxServer, id: string) => {
    const response = await fetch(url(server, `/api/inbox/uploads/${id}/text`));
    return { status: response.status, body: (await response.json()) as { text?: string; code?: string } };
  };

  test("saved and read back with its place; its words come back by the text route; files alone keep the draft; no words and no files delete it", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The nightly import failed. Can you send me the log?", "ses_p");
    const file = await upload(server, "pasted-text-2026-11-01-2110.txt", LOG);
    const words = "Here is the log. It fails on the third retry.";
    const first = await save(server, thread_id, { body: words, base: null, files: [pasted(file.upload_id, "Here is the log.".length)] });
    expect(first.status).toBe(200);
    const draft = (await draftOf(first))!;
    expect(draft.files).toEqual([{ ...file, pasted: { at: "Here is the log.".length, preview: PREVIEW } }]);
    // Another window (or a reload) reads the same draft, then the paste's exact words.
    const read = (await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json()) as { draft: InboxReplyDraft };
    expect(read.draft).toEqual(draft);
    expect(await textOf(server, file.upload_id)).toEqual({ status: 200, body: { text: LOG } });

    // Words gone, the paste kept: still a draft, still unsent on its row.
    const filesOnly = await draftOf(await save(server, thread_id, { body: "", base: draft.updated_at, files: [pasted(file.upload_id, 0)] }));
    expect(filesOnly?.files?.map((f) => f.upload_id)).toEqual([file.upload_id]);
    expect((await rowOf(server, thread_id)).unsent?.reply_at).toBe(filesOnly!.updated_at);
    // Nothing left: deleted, as an empty body was.
    expect(await draftOf(await save(server, thread_id, { body: "  ", base: filesOnly!.updated_at }))).toBeNull();
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("the compare-and-set covers the files: base_body's shortcut holds only while the draft holds the files this window saved last", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The nightly import failed.", "ses_q");
    const a = await upload(server, "pasted-text-a.txt", LOG);
    const b = await upload(server, "pasted-text-b.txt", `${LOG}more\n`);
    const mine = (await draftOf(await save(server, thread_id, { body: "Log:", base: null, files: [pasted(a.upload_id, 4)] })))!;
    // Another window keeps the same words but swaps the paste.
    const theirs = (await draftOf(await save(server, thread_id, { body: "Log:", base: mine.updated_at, files: [pasted(b.upload_id, 4)] })))!;
    // This window's next save is a step behind: its words match, its files do not. Refused, nothing written over.
    const refused = await save(server, thread_id, { body: "Log: see the file", base: mine.updated_at, base_body: "Log:", base_files: [a.upload_id], files: [pasted(a.upload_id, 4)] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "draft_conflict", draft: theirs });
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
    // Naming the files the draft does hold, the shortcut holds.
    const ok = await save(server, thread_id, { body: "Log: see the file", base: mine.updated_at, base_body: "Log:", base_files: [b.upload_id], files: [pasted(b.upload_id, 4)] });
    expect(ok.status).toBe(200);
    expect(server.store.replyDraft(thread_id)?.body).toBe("Log: see the file");
  });

  test("refusals write nothing: a place past the words, a lead that is not space, an upload that is gone", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The nightly import failed.", "ses_r");
    const file = await upload(server, "pasted-text-c.txt", LOG);
    expect((await save(server, thread_id, { body: "Log:", base: null, files: [pasted(file.upload_id, 5)] })).status).toBe(422);
    expect((await save(server, thread_id, { body: "Log:", base: null, files: [{ upload_id: file.upload_id, pasted: { at: 1, lead: "ab", preview: "x" } }] })).status).toBe(422);
    const gone = await save(server, thread_id, { body: "Log:", base: null, files: [pasted("upl_01K70000000000000000000099", 0)] });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe("upload_not_found");
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("the text route: another site's read refused; a picture, an unknown id and a sent paste are 404", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The nightly import failed.", "ses_s");
    const file = await upload(server, "pasted-text-d.txt", LOG);
    expect((await fetch(url(server, `/api/inbox/uploads/${file.upload_id}/text`), { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    const png = await upload(server, "shot.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    expect((await textOf(server, png.upload_id)).status).toBe(404);
    expect(await textOf(server, "upl_01K70000000000000000000099")).toMatchObject({ status: 404, body: { code: "upload_not_found" } });
    // A draft of the paste alone, carried by the Send: the draft is cleared and the paste is no longer pending.
    const draft = (await draftOf(await save(server, thread_id, { body: "", base: null, files: [pasted(file.upload_id, 0)] })))!;
    const sent = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "paste-1", words: "", uploads: [file.upload_id], clear_draft: draft.updated_at });
    expect(sent.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
    expect((await textOf(server, file.upload_id)).status).toBe(404);
  });

  test("the text route reads only long pastes: a .txt the person dropped is 404", async () => {
    const { server } = await setup();
    const dropped = await upload(server, "notes.txt", "my private notes\n");
    expect(dropped.kind).toBe("text");
    expect(await textOf(server, dropped.upload_id)).toMatchObject({ status: 404, body: { code: "upload_not_found" } });
    const paste = await upload(server, "pasted-text-2026-11-01-2110-2.txt", LOG);
    expect(await textOf(server, paste.upload_id)).toEqual({ status: 200, body: { text: LOG } });
  });

  test("a Send of the paste alone with a stale clear_draft (or none) still clears the draft holding only that paste", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The nightly import failed.", "ses_u");
    const file = await upload(server, "pasted-text-g.txt", LOG);
    const first = (await draftOf(await save(server, thread_id, { body: "Log", base: null, files: [pasted(file.upload_id, 3)] })))!;
    // The window's last save (the words emptied, the paste kept) landed without its answer: it still knows the first updated_at.
    expect((await save(server, thread_id, { body: "", base: first.updated_at, files: [pasted(file.upload_id, 0)] })).status).toBe(200);
    const sent = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "paste-u", words: "", uploads: [file.upload_id], clear_draft: first.updated_at });
    expect(sent.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
    expect((await rowOf(server, thread_id)).unsent ?? null).toBeNull();
    // No updated_at known at all (''), words beside the paste.
    const other = await upload(server, "pasted-text-h.txt", LOG);
    await save(server, thread_id, { body: "Here:", base: null, files: [pasted(other.upload_id, 5)] });
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "paste-v", words: "Here:", uploads: [other.upload_id], clear_draft: "" })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
  });

  test("a stale Send of the same words leaves a draft holding a paste another window added, and its words still read", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The nightly import failed.", "ses_w");
    // Window A saves "Yes". Window B adds a long paste beside the same words.
    const mine = (await draftOf(await save(server, thread_id, { body: "Yes", base: null })))!;
    const file = await upload(server, "pasted-text-i.txt", LOG);
    const theirs = (await draftOf(await save(server, thread_id, { body: "Yes", base: mine.updated_at, files: [pasted(file.upload_id, 3)] })))!;
    // A, before it hears of B's save, sends "Yes" naming its own old updated_at, without the paste.
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "w1", words: "Yes", clear_draft: mine.updated_at })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
    expect(await textOf(server, file.upload_id)).toEqual({ status: 200, body: { text: LOG } });
    // A Send carrying another paste, not B's, leaves it too.
    const another = await upload(server, "pasted-text-j.txt", `${LOG}j\n`);
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "w2", words: "Yes", uploads: [another.upload_id], clear_draft: "" })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
  });

  test("a Send carrying some of a draft's pastes drops them from every reply draft (a new updated_at, a draft left empty goes) and says so in `event: drafts`", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("The nightly import failed.", "ses_x");
    const { thread_id: elsewhere } = await send("The deploy failed too.", "ses_y");
    expect(elsewhere).not.toBe(thread_id);
    const p = await upload(server, "pasted-text-p.txt", LOG);
    const q = await upload(server, "pasted-text-q.txt", `${LOG}q\n`);
    // Window A saves "Yes" and P; window B adds Q beside them. Another thread's draft holds P alone.
    const mine = (await draftOf(await save(server, thread_id, { body: "Yes", base: null, files: [pasted(p.upload_id, 3)] })))!;
    const theirs = (await draftOf(await save(server, thread_id, { body: "Yes", base: mine.updated_at, files: [pasted(p.upload_id, 3), pasted(q.upload_id, 3)] })))!;
    expect((await save(server, elsewhere, { body: "", base: null, files: [pasted(p.upload_id, 0)] })).status).toBe(200);

    const controller = new AbortController();
    const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}&window=window-test-x&permission=granted`), { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);

    // A, before it hears of B's save, sends "Yes" and P naming its own old updated_at: B's draft stays, without P.
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "x1", words: "Yes", uploads: [p.upload_id], clear_draft: mine.updated_at })).status).toBe(200);
    const left = server.store.replyDraft(thread_id)!;
    expect(left.body).toBe("Yes");
    expect(left.files?.map((f) => f.upload_id)).toEqual([q.upload_id]);
    expect(left.updated_at).not.toBe(theirs.updated_at);
    expect(server.store.replyDraft(elsewhere)).toBeNull();
    // Both threads' windows hear it.
    const deadline = Date.now() + 3000;
    const heard = () => text.includes(`event: drafts\ndata: {"thread_id":"${thread_id}"}`) && text.includes(`event: drafts\ndata: {"thread_id":"${elsewhere}"}`);
    while (!heard() && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain(`event: drafts\ndata: {"thread_id":"${elsewhere}"}`);
    expect(text).toContain(`event: drafts\ndata: {"thread_id":"${thread_id}"}`);
    // What the windows read back names no gone upload.
    const read = (await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json()) as { draft: InboxReplyDraft };
    expect(read.draft).toEqual(left);
    // B, typing before it heard: its save names the base it knew and the pastes it saved last (P and Q). P is a
    // sent paste now, so it does not tell B's draft apart: the save of Q alone beside B's words is B's own and lands.
    const fromB = await save(server, thread_id, { body: "Yes, see Q", base: theirs.updated_at, base_body: "Yes", base_files: [p.upload_id, q.upload_id], files: [pasted(q.upload_id, 3)] });
    expect(fromB.status).toBe(200);
    expect(server.store.replyDraft(thread_id)?.body).toBe("Yes, see Q");
  });

  test("the upload sweep keeps a reply draft's paste a day on, and forgets one no draft names", async () => {
    const { dataDir, server, send } = await setup();
    const { thread_id } = await send("The nightly import failed.", "ses_t");
    const kept = await upload(server, "pasted-text-e.txt", LOG);
    const loose = await upload(server, "pasted-text-f.txt", `${LOG}loose\n`);
    expect((await save(server, thread_id, { body: "Log:", base: null, files: [pasted(kept.upload_id, 4)] })).status).toBe(200);
    // Both two days old, as the sweep sees them.
    const pending = join(server.store.dir, "uploads", "pending");
    for (const id of [kept.upload_id, loose.upload_id]) {
      const path = join(pending, `${id}.json`);
      const record = JSON.parse(readFileSync(path, "utf8")) as InboxUpload;
      writeFileSync(path, JSON.stringify({ ...record, created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }));
    }
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    // The Inbox sweeps as it starts.
    const again = await start(dataDir);
    expect(await textOf(again.server, kept.upload_id)).toEqual({ status: 200, body: { text: LOG } });
    expect((await textOf(again.server, loose.upload_id)).status).toBe(404);
    expect(again.server.store.replyDraft(thread_id)?.files?.map((f) => f.upload_id)).toEqual([kept.upload_id]);
  });
});

/**
 * Every file attached to a reply box (paperclip, drop, paste) is part of the
 * draft, beside its words, so it syncs to every window and the phone and goes
 * with whichever device sends. An older page that knew long pastes only never
 * drops one; a Send that did not carry one leaves it behind, never loses it.
 */
describe("reply drafts keep every attached file", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const LOG = "2026-11-01T21:10:04Z worker-3 retry 2 status=failed\n".repeat(700);
  const upload = async (server: InboxServer, name: string, bytes: string | Uint8Array): Promise<InboxUpload> => {
    const response = await fetch(url(server, `/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`), { method: "POST", body: bytes });
    expect(response.status).toBe(200);
    return ((await response.json()) as { upload: InboxUpload }).upload;
  };
  const save = (server: InboxServer, threadId: string, body: Record<string, unknown>) => post(server, `/api/inbox/threads/${threadId}/draft`, body);
  const draftOf = async (response: Response) => ((await response.json()) as { draft: InboxReplyDraft | null }).draft;
  const ids = (draft: InboxReplyDraft | null | undefined) => (draft?.files ?? []).map((file) => file.upload_id);
  const pending = (server: InboxServer, id: string) => existsSync(join(server.store.dir, "uploads", "pending", `${id}.json`));

  test("the phone's long paste keeps its place when this window's save (a step behind, its own words) changes the words", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here is the log.", "ses_r1");
    const LOG = "2026-11-01T21:10:04Z worker-3 retry 2 status=failed\n".repeat(700);
    const first = (await draftOf(await save(server, thread_id, { body: "Hello world", base: null, files_add: [], files_remove: [], files_place: [] })))!;
    // The phone pastes a long log between "Hello " and "world" (a tile: its words do not change).
    const log = await upload(server, "pasted-text.txt", LOG);
    const phone = (await draftOf(
      await save(server, thread_id, { body: "Hello world", base: first.updated_at, base_body: "Hello world", files_add: [{ upload_id: log.upload_id, pasted: { at: 6, preview: "2026-11-01" } }], files_remove: [], files_place: [] }),
    ))!;
    expect(phone.files!.map((f) => f.pasted?.at)).toEqual([6]);
    // This window, a step behind, puts "Oh. " in front of its words: accepted (its own words), naming no file.
    const mine = await save(server, thread_id, { body: "Oh. Hello world", base: first.updated_at, base_body: "Hello world", files_add: [], files_remove: [], files_place: [] });
    expect(mine.status).toBe(200);
    const after = (await draftOf(mine))!;
    // The paste was between "Hello " and "world": after "Oh. Hello " now.
    expect(after.files!.map((f) => f.pasted?.at)).toEqual([10]);
    // Shorter words never leave it past their end.
    const short = (await draftOf(await save(server, thread_id, { body: "Oh.", base: after.updated_at, base_body: "Oh. Hello world", files_add: [], files_remove: [], files_place: [] })))!;
    expect(short.files!.map((f) => f.pasted?.at)).toEqual([3]);
  });

  test("a files_add entry with no upload id is refused (422), not skipped", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here.", "ses_r1b");
    for (const entry of [123, {}, { upload_id: 5 }]) {
      const refused = await save(server, thread_id, { body: "Hi", base: null, files_add: [entry], files_remove: [], files_place: [] });
      expect(refused.status).toBe(422);
    }
  });

  test("saved beside the words and read back whole (as a phone's 7.62 read gets it); files alone keep the draft; the Drafts page names the file", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here is the dashboard.", "ses_f1");
    const shot = await upload(server, "dashboard.png", PNG);
    const notes = await upload(server, "notes.md", "# Notes\n");
    const first = await save(server, thread_id, { body: "See the shot", base: null, files: [shot.upload_id, { upload_id: notes.upload_id }], all_files: true });
    expect(first.status).toBe(200);
    const draft = (await draftOf(first))!;
    expect(draft.files).toEqual([shot, notes]);
    const read = (await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json()) as { draft: InboxReplyDraft };
    expect(read.draft).toEqual(draft);

    // The words gone, the files kept: a draft of files only, unsent on its row, named on the Drafts page.
    const filesOnly = (await draftOf(await save(server, thread_id, { body: "", base: draft.updated_at, files: [shot.upload_id], all_files: true })))!;
    expect(ids(filesOnly)).toEqual([shot.upload_id]);
    expect((await rowOf(server, thread_id)).unsent?.reply_at).toBe(filesOnly.updated_at);
    const page = (await (await fetch(url(server, "/api/inbox/drafts"))).json()) as { replies: { thread_id: string; reply_preview: string | null }[] };
    expect(page.replies.find((row) => row.thread_id === thread_id)?.reply_preview).toBe("dashboard.png");
  });

  test("a page's file changes apply to the files as they are: another window's file stays, one it removed stays out, and only the words refuse a save", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here is the dashboard.", "ses_f9");
    const mine = await upload(server, "mine.png", PNG);
    const theirs = await upload(server, "theirs.png", Uint8Array.from([...PNG, 1]));
    const later = await upload(server, "later.png", Uint8Array.from([...PNG, 2]));
    const first = (await draftOf(await save(server, thread_id, { body: "Shots", base: null, files_add: [mine.upload_id], files_remove: [], files_place: [] })))!;
    expect(ids(first)).toEqual([mine.upload_id]);
    // Another window adds its file (a step ahead of this one).
    const other = (await draftOf(await save(server, thread_id, { body: "Shots", base: first.updated_at, base_body: "Shots", files_add: [theirs.upload_id], files_remove: [], files_place: [] })))!;
    // This window, a version behind, adds one more and names nothing else: theirs stays. Its words are its own (base_body).
    const behind = await save(server, thread_id, { body: "Shots, both", base: first.updated_at, base_body: "Shots", files_add: [later.upload_id], files_remove: [], files_place: [] });
    expect(behind.status).toBe(200);
    const both = (await draftOf(behind))!;
    expect(ids(both)).toEqual([mine.upload_id, theirs.upload_id, later.upload_id]);
    expect(both.updated_at > other.updated_at).toBe(true);
    // Removing a file another window already removed, and adding one twice, change nothing more.
    const again = (await draftOf(await save(server, thread_id, { body: "Shots, both", base: both.updated_at, files_add: [later.upload_id], files_remove: [mine.upload_id], files_place: [] })))!;
    expect(ids(again)).toEqual([theirs.upload_id, later.upload_id]);
    const twice = (await draftOf(await save(server, thread_id, { body: "Shots, both", base: again.updated_at, files_add: [], files_remove: [mine.upload_id], files_place: [] })))!;
    expect(ids(twice)).toEqual([theirs.upload_id, later.upload_id]);
    // Different words from elsewhere do refuse it, with the newer draft.
    await save(server, thread_id, { body: "Other words", base: twice.updated_at, files_add: [], files_remove: [], files_place: [] });
    const refused = await save(server, thread_id, { body: "Mine", base: twice.updated_at, base_body: "Shots, both", files_add: [], files_remove: [theirs.upload_id], files_place: [] });
    expect(refused.status).toBe(409);
    expect(ids((await (await fetch(url(server, `/api/inbox/threads/${thread_id}/draft`))).json() as { draft: InboxReplyDraft }).draft)).toEqual([theirs.upload_id, later.upload_id]);
  });

  test("a page's added file whose upload is gone (sent or swept) is left out and the save lands; a long paste's place follows; nothing left deletes the draft", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here is the log.", "ses_f10");
    const gone = await upload(server, "gone.png", PNG);
    const paste = await upload(server, "pasted-text.txt", LOG);
    rmSync(join(server.store.dir, "uploads", "pending", `${gone.upload_id}.json`), { force: true });
    const saved = await save(server, thread_id, {
      body: "Log: ",
      base: null,
      files_add: [gone.upload_id, { upload_id: paste.upload_id, pasted: { at: 5, preview: "2026-11-01" } }],
      files_remove: [],
      files_place: [],
    });
    expect(saved.status).toBe(200);
    const draft = (await draftOf(saved))!;
    expect(ids(draft)).toEqual([paste.upload_id]);
    // The words grew before the paste: its place moves with them; a place for a file not in the draft does nothing.
    const moved = (await draftOf(
      await save(server, thread_id, { body: "The log: ", base: draft.updated_at, files_add: [], files_remove: [], files_place: [{ upload_id: paste.upload_id, pasted: { at: 9, preview: "2026-11-01" } }, { upload_id: gone.upload_id, pasted: { at: 0, preview: "x" } }] }),
    ))!;
    expect(moved.files!.map((file) => [file.upload_id, file.pasted?.at])).toEqual([[paste.upload_id, 9]]);
    // No words and no file left: the draft goes.
    const emptied = await save(server, thread_id, { body: "", base: moved.updated_at, files_add: [], files_remove: [paste.upload_id], files_place: [] });
    expect(await draftOf(emptied)).toBeNull();
    // A malformed change is refused, naming its field.
    const bad = await save(server, thread_id, { body: "x", base: null, files_add: [], files_remove: "nope", files_place: [] });
    expect(bad.status).toBe(422);
  });

  test("the compare-and-set covers every file, and base_files names them: a save a step behind holds only while the draft holds what it saved last", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("Here is the dashboard.", "ses_f2");
    const a = await upload(server, "a.png", PNG);
    const b = await upload(server, "b.png", Uint8Array.from([...PNG, 1]));
    const mine = (await draftOf(await save(server, thread_id, { body: "Shots", base: null, files: [a.upload_id], all_files: true })))!;
    // Another window adds B beside the same words.
    const theirs = (await draftOf(await save(server, thread_id, { body: "Shots", base: mine.updated_at, files: [a.upload_id, b.upload_id], all_files: true })))!;
    // This window's next save is a step behind and names only A as what it saved last: refused, nothing written over.
    const refused = await save(server, thread_id, { body: "Shots, see A", base: mine.updated_at, base_body: "Shots", base_files: [a.upload_id], files: [a.upload_id], all_files: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "draft_conflict", draft: theirs });
    // A stale base alone is refused too.
    expect((await save(server, thread_id, { body: "x", base: mine.updated_at, files: [], all_files: true })).status).toBe(409);
    expect(server.store.replyDraft(thread_id)).toEqual(theirs);
    // With all_files, a list without A removes it.
    const removed = (await draftOf(await save(server, thread_id, { body: "Shots", base: theirs.updated_at, files: [b.upload_id], all_files: true })))!;
    expect(ids(removed)).toEqual([b.upload_id]);
  });

  test("an older page (long pastes only, no all_files) never drops a file it does not know, and keeps the words it saves", async () => {
    const { server, send } = await setup();
    const { thread_id } = await send("The nightly import failed.", "ses_f3");
    const shot = await upload(server, "error.png", PNG);
    const paste = await upload(server, "pasted-text-o.txt", LOG);
    const mine = (await draftOf(await save(server, thread_id, { body: "Log:", base: null, files: [shot.upload_id, { upload_id: paste.upload_id, pasted: { at: 4, preview: "log" } }], all_files: true })))!;
    // The older page saves its words and the paste it knows; the picture stays.
    const older = (await draftOf(await save(server, thread_id, { body: "Log: retry 2", base: mine.updated_at, files: [{ upload_id: paste.upload_id, pasted: { at: 4, preview: "log" } }] })))!;
    expect(older.body).toBe("Log: retry 2");
    expect(ids(older)).toEqual([shot.upload_id, paste.upload_id]);
    // It drops the paste and every word: the picture still stays, as a draft of files only.
    const emptied = (await draftOf(await save(server, thread_id, { body: "", base: older.updated_at })))!;
    expect(emptied.body).toBe("");
    expect(ids(emptied)).toEqual([shot.upload_id]);
    // Its save a step behind compares only the pastes it can name (none here), so it is still its own.
    const behind = await save(server, thread_id, { body: "Again", base: older.updated_at, base_body: "", base_files: [] });
    expect(behind.status).toBe(200);
    expect(ids(await draftOf(behind))).toEqual([shot.upload_id]);
  });

  test("Send: the draft's own version takes words and carried files; a Send of the words alone leaves the file as a draft of files only, and says so to every window", async () => {
    const { server, send } = await setup();
    const { thread_id, message_id } = await send("Here is the dashboard.", "ses_f4");
    const shot = await upload(server, "chart.png", PNG);
    const other = await upload(server, "table.csv", "a,b\n1,2\n");
    // Carried: the draft is done, the upload is now the reply's attachment.
    const draft = (await draftOf(await save(server, thread_id, { body: "Ship it", base: null, files: [shot.upload_id], all_files: true })))!;
    const sent = await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "f4-1", words: "Ship it", uploads: [shot.upload_id], clear_draft: draft.updated_at });
    expect(sent.status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toBeNull();
    expect(pending(server, shot.upload_id)).toBe(false);
    expect(server.store.thread(thread_id)!.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual(["chart.png"]);

    const controller = new AbortController();
    const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}&window=window-test-f4&permission=granted`), { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);

    // A phone (or an older page) sends the words alone, naming the draft's version: the words go, the file stays.
    const next = (await draftOf(await save(server, thread_id, { body: "And the table", base: null, files: [other.upload_id], all_files: true })))!;
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "f4-2", words: "And the table", clear_draft: next.updated_at })).status).toBe(200);
    const left = server.store.replyDraft(thread_id)!;
    expect(left.body).toBe("");
    expect(ids(left)).toEqual([other.upload_id]);
    expect(left.updated_at > next.updated_at).toBe(true);
    expect(pending(server, other.upload_id)).toBe(true);
    expect((await rowOf(server, thread_id)).unsent?.reply_at).toBe(left.updated_at);
    const deadline = Date.now() + 3000;
    const heard = `event: drafts\ndata: {"thread_id":"${thread_id}"}`;
    while (!text.includes(heard) && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain(heard);

    // A stale version with the same words, not carrying the file: another window's work, kept whole.
    const words = (await draftOf(await save(server, thread_id, { body: "Table attached", base: left.updated_at, files: [other.upload_id], all_files: true })))!;
    expect((await post(server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "f4-3", words: "Table attached", clear_draft: left.updated_at })).status).toBe(200);
    expect(server.store.replyDraft(thread_id)).toEqual(words);
  });

  test("the sweep keeps a reply draft's file at any age; after Discard it goes once a day old, while a blob a sent message shares stays", async () => {
    const { dataDir, server, send } = await setup();
    const { thread_id, message_id } = await send("Here is the dashboard.", "ses_f5");
    const kept = await upload(server, "kept.png", PNG);
    expect((await save(server, thread_id, { body: "", base: null, files: [kept.upload_id], all_files: true })).status).toBe(200);
    /** Two days old, as the sweep sees it. */
    const age = (dir: string, id: string) => {
      const path = join(dir, "uploads", "pending", `${id}.json`);
      const record = JSON.parse(readFileSync(path, "utf8")) as InboxUpload;
      writeFileSync(path, JSON.stringify({ ...record, created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }));
    };
    age(server.store.dir, kept.upload_id);
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    // The Inbox sweeps as it starts: the draft's file is still there.
    let again = await start(dataDir);
    expect(pending(again.server, kept.upload_id)).toBe(true);
    expect(ids(again.server.store.replyDraft(thread_id))).toEqual([kept.upload_id]);

    // Discard: no draft names it, so the next sweep forgets it.
    expect((await post(again.server, `/api/inbox/threads/${thread_id}/draft/delete`, {})).status).toBe(200);
    // A sent reply holds the same bytes as another pending upload: their blob stays when that upload goes.
    const sharedBytes = Uint8Array.from([...PNG, 9]);
    const shared = await upload(again.server, "shared.png", sharedBytes);
    const twin = await upload(again.server, "twin.png", sharedBytes);
    expect(twin.sha256).toBe(shared.sha256);
    expect((await post(again.server, `/api/inbox/messages/${message_id}/reply`, { idempotency_key: "f5-1", words: "Shared", uploads: [shared.upload_id] })).status).toBe(200);
    age(again.server.store.dir, twin.upload_id);
    again.server.stop();
    servers.splice(servers.indexOf(again.server), 1);
    again = await start(dataDir);
    expect(pending(again.server, kept.upload_id)).toBe(false);
    expect(pending(again.server, twin.upload_id)).toBe(false);
    const sentFile = again.server.store.thread(thread_id)!.messages.at(-1)!.attachments![0]!;
    expect(existsSync(sentFile.path)).toBe(true);
  });

  test("an agent never sees a draft's file: not in the event log, read_thread or search", async () => {
    const { server, client, send } = await setup();
    const { thread_id } = await send("Here is the dashboard.", "ses_f6");
    const secret = await upload(server, "SECRET-DRAFT-FILE.png", PNG);
    const cursor = server.store.cursor();
    expect((await save(server, thread_id, { body: "", base: null, files: [secret.upload_id], all_files: true })).status).toBe(200);
    expect(server.store.changesSince(cursor)).toEqual([]);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id, agent_session: "ses_f6" } });
    expect(JSON.stringify(read)).not.toContain("SECRET-DRAFT-FILE");
    const search = await (await fetch(url(server, "/api/inbox/search?q=SECRET"))).json();
    expect(JSON.stringify(search)).not.toContain("SECRET-DRAFT-FILE");
  });
});

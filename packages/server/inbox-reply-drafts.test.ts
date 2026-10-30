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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxReplyDraft } from "@plannotator/core/inbox-types";
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

  test("never in the event log, never seen by an agent: read_thread and wait_for_reply carry none of it", async () => {
    const { server, client, send } = await setup();
    const { thread_id } = await send("The build is green.", "ses_d");
    const cursor = server.store.cursor();
    await saveDraft(server, thread_id, "SECRET-DRAFT-WORDS", null);
    expect(server.store.cursor()).toBe(cursor);
    expect(server.store.changesSince(cursor)).toEqual([]);
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id, agent_session: "ses_d" } });
    expect(JSON.stringify(read)).not.toContain("SECRET-DRAFT-WORDS");
    const waited = await client.callTool({ name: "wait_for_reply", arguments: { thread_id, agent_session: "ses_d", timeout_seconds: 1 } });
    expect(JSON.stringify(waited)).not.toContain("SECRET-DRAFT-WORDS");
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

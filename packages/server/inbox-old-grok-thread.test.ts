/**
 * A thread the removed Grok Build runner wrote (0.28.34 to 0.28.36): the
 * person's first message addressed to `{ host: "grok", session: run_… }`,
 * Grok Build's answers authored `grok` / "Grok Build". With the runner gone
 * the thread still reads as an ordinary agent thread, and a reply in it is
 * stored like a reply to any session that is not live: it waits, nothing
 * fails. The runner's `inbox/acp/sessions.json` and config.json's `inboxRun`
 * are left alone and never read: a setting saved now keeps `inboxRun`. A
 * reply written to a live session instead lands there, told it was written
 * to Grok Build; a message no turn took moves there (Send to another
 * session) and lands. The
 * test's own temp data dir is PLANNOTATOR_DATA_DIR while it runs (config.json
 * is read from there), restored after.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxListModel, InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const RUN = "run_01JZ8N3W6Q2R5T7V9X1Y3Z5A7B";

describe("a thread the removed Grok Build runner wrote", () => {
  test("reads as an ordinary Grok Build thread, takes a reply that waits, and leaves the runner's files alone", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-old-grok-")));
    roots.push(root);
    const project = join(root, "billing");
    mkdirSync(project, { recursive: true });
    const data = join(root, "data");
    // config.json is read and saved under PLANNOTATOR_DATA_DIR: this test's folder while it runs.
    process.env.PLANNOTATOR_DATA_DIR = data;
    // What 0.28.34–0.28.36 left in the data dir: the runner's session table (its shape, `{ v: 1, sessions }`) and the Settings toggle.
    mkdirSync(join(data, "inbox", "acp"), { recursive: true });
    const table = `${JSON.stringify(
      {
        v: 1,
        sessions: [{ key: RUN, agent: "grok", acp_session_id: "grok-own-id", cwd: project, project_id: "prj_x", thread_id: "msg_x", created_at: "2026-10-27T10:00:00.000Z", turns: [] }],
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(data, "inbox", "acp", "sessions.json"), table);
    writeFileSync(join(data, "config.json"), JSON.stringify({ inboxRun: { grok: false } }));

    const server = await startInboxServer({ dataDir: data });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // The thread as the runner wrote it: compose's Send addressed to the run, then Grok Build's answer (posted with wakes, as its turns were).
    const place = server.store.ensureProject({ name: "billing", root: project });
    const started = server.store.startPersonThread({ project_id: place.id, body: "Look at the refund retries.", to: { host: "grok", session: RUN }, idempotency_key: "old-start" });
    const threadId = started.message.thread_id;
    const answer = server.store.sendMessage({
      project_id: place.id,
      author: { kind: "agent", host: "grok", session: RUN, name: "Grok Build" },
      body: "The retries back off twice, then give up. Want a third?",
      reply_to: started.message.id,
      idempotency_key: `acp-final-${started.message.id}`,
      wakes: true,
    });

    // The list and the thread read without a `run` and without error; the answer is Grok Build's.
    const list = (await (await fetch(`${base}/api/inbox/threads`)).json()) as InboxListModel;
    const row = list.sections.flatMap((section) => section.threads).find((r) => r.thread_id === threadId);
    expect(row).toBeDefined();
    expect(row && "run" in row).toBe(false);
    const read = await fetch(`${base}/api/inbox/threads/${threadId}`);
    expect(read.status).toBe(200);
    const thread = ((await read.json()) as { thread: InboxThread }).thread;
    expect(thread.messages.map((m) => m.author)).toEqual([
      { kind: "person" },
      { kind: "agent", host: "grok", session: RUN, name: "Grok Build" },
    ]);

    // A reply: stored and waiting for that session, as for any session that is not live.
    const replied = await fetch(`${base}/api/inbox/messages/${answer.message.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "old-reply", words: "Yes, a third with a longer wait." }),
    });
    expect(replied.status).toBe(200);
    const reply = ((await replied.json()) as { reply: { id: string; delivery?: unknown } }).reply;
    expect(server.store.pendingReplies(RUN, { tags: false }).map((r) => r.id)).toContain(reply.id);
    expect((await fetch(`${base}/api/inbox/threads/${threadId}`)).status).toBe(200);

    // The ways out, to a live session in the project.
    const poll = async () => {
      const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ session: "ses-live", host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false }),
      });
      expect(response.status).toBe(200);
      return parseInboxBridgeCommands(await response.text());
    };
    expect(await poll()).toEqual([]);
    // A reply written to another session (the reply route's `to`, as the window sends it when the asker is gone):
    // the live session gets it, told it was written to Grok Build.
    const redirected = await fetch(`${base}/api/inbox/messages/${answer.message.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "old-reply-2", words: "Claude, take this one.", to: { host: "claude-code", session: "ses-live" } }),
    });
    expect(redirected.status).toBe(200);
    const sentOn = ((await redirected.json()) as { reply: { id: string } }).reply;
    const commands = await poll();
    expect(commands.map((c) => c.id)).toEqual([sentOn.id]);
    expect(inboxWakeText(commands[0]!)).toContain("written to another Grok Build session");
    const taken = await fetch(`${base}${INBOX_BRIDGE_EVENT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "ses-live", host: "claude-code", type: "delivered", id: sentOn.id }),
    });
    expect(taken.status).toBe(200);
    // Send to another session: a message addressed to the runner's session that no turn took (its first turn never ran)
    // moves to the live session, and lands there.
    const unstarted = server.store.startPersonThread({ project_id: place.id, body: "Rename the refunds queue.", to: { host: "grok", session: RUN }, idempotency_key: "old-start-2" });
    const moved = await fetch(`${base}/api/inbox/messages/${unstarted.message.id}/to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, to: { host: "claude-code", session: "ses-live" } }),
    });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { row: InboxListRow }).row.addressee).toEqual({ host: "claude-code", session: "ses-live" });
    expect(server.store.pendingReplies(RUN, { tags: false }).map((r) => r.id)).not.toContain(unstarted.message.id);
    expect((await poll()).map((c) => c.id)).toEqual([unstarted.message.id]);

    // The runner's routes are gone; its session table is untouched; a setting saved now keeps `inboxRun`.
    expect((await fetch(`${base}/api/inbox/acp`)).status).toBe(404);
    const saved = await fetch(`${base}/api/inbox/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, board: { on: true } }),
    });
    expect(saved.status).toBe(200);
    const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as { inboxBoard?: unknown; inboxRun?: unknown };
    expect(config.inboxBoard).toBe(true);
    expect(config.inboxRun).toEqual({ grok: false });
    expect(readFileSync(join(data, "inbox", "acp", "sessions.json"), "utf8")).toBe(table);
  });
});

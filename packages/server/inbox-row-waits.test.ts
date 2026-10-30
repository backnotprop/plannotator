/**
 * The list row's `waits` (approval "inbox-row-badges"): what a Stopped or
 * Holds up badge holds, for the window's hover card. Proved against a real
 * Inbox through its doors (the MCP SDK client for the agent, real fetch for
 * the window and the phone):
 *
 *  - each open question or action item that stops the agent or holds
 *    something up, in thread order, with its message, key, place, prompt,
 *    `Stopped:` line and `Holds up:` entries; a question with neither, a
 *    question picked, and a row with no badge carry nothing;
 *  - capped (at most 8 questions, the words cut);
 *  - never in what agents read (read_thread's list, wait_for_reply);
 *  - the phone door forwards it unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  INBOX_ROW_WAITS_MAX,
  INBOX_ROW_WAIT_ENTRY_MAX,
  INBOX_ROW_WAIT_HOLDS_MAX,
  INBOX_ROW_WAIT_TEXT_MAX,
  type InboxListRow,
  type InboxListSection,
} from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(opts: { phones?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-row-waits-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), ...(opts.phones ? { phones: true } : {}) });
  servers.push(server);
  const client = new Client({ name: "inbox-row-waits-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string, extra: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: "ses_rows", agent_host: "claude-code", body, ...extra } });
    if ((result as { isError?: boolean }).isError) throw new Error(JSON.stringify(result));
    return (result as { structuredContent: { message_id: string; thread_id: string } }).structuredContent;
  };
  const rows = async (): Promise<InboxListRow[]> => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`);
    expect(res.status).toBe(200);
    const model = (await res.json()) as { sections: InboxListSection[] };
    return model.sections.flatMap((s) => s.threads);
  };
  return { root, project, server, client, send, rows };
}

const block = (prompt: string, lines: string[] = [], kind = "question") => [`:::${kind}`, prompt, ...lines, ...(kind === "action" ? [] : ["- Yes", "- No"]), ":::"].join("\n");

describe("the list row's waits", () => {
  test("each question that stops the agent or holds work up, in order, with its message, key, place and words", async () => {
    const w = await world();
    const sent = await w.send(
      [
        "Two things before I go on.",
        "",
        block("Which way should the worker go on a Stripe 409?", ["Stopped: the retry worker cannot ship without this."]),
        "",
        block("Ship it behind a flag?", ["Holds up: the retry worker; the admin retry view"]),
        "",
        block("Rename the queue?"),
      ].join("\n"),
      { thread: "retry-worker" },
    );
    // A later message in the same thread: an action item that holds work up.
    const later = await w.send(block("Approve the 2FA prompt for the npm org", ["Holds up: the 0.29 publish"], "action"), { thread: "retry-worker" });
    const [row] = await w.rows();
    expect(row!.section).toBe("stopped");
    expect(row!.waits).toEqual([
      { message_id: sent.message_id, key: expect.stringMatching(/^q-/), position: 0, prompt: "Which way should the worker go on a Stripe 409?", stopped: "the retry worker cannot ship without this.", holds_up: [] },
      { message_id: sent.message_id, key: expect.stringMatching(/^q-/), position: 1, prompt: "Ship it behind a flag?", stopped: null, holds_up: ["the retry worker", "the admin retry view"] },
      { message_id: later.message_id, key: expect.stringMatching(/^a-/), position: 0, prompt: "Approve the 2FA prompt for the npm org", stopped: null, holds_up: ["the 0.29 publish"] },
    ]);
    // The keys are the questions' own (the thread names them the same way).
    const thread = (await (await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: { messages: { id: string; questions?: { key: string; prompt: string }[] }[] } };
    const keys = thread.thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.key));
    for (const wait of row!.waits!) expect(keys).toContain(wait.key);
  });

  test("a picked question leaves the card; a row whose questions hold nothing carries no waits", async () => {
    const w = await world();
    const sent = await w.send(block("Ship it behind a flag?", ["Holds up: the retry worker"]), { thread: "flag" });
    const plain = await w.send(block("Rename the queue?"), { thread: "rename" });
    let rows = await w.rows();
    const flag = rows.find((r) => r.thread_id === sent.thread_id)!;
    expect(flag.section).toBe("holding");
    expect(flag.waits).toHaveLength(1);
    expect(rows.find((r) => r.thread_id === plain.thread_id)!.waits).toBeUndefined();

    // The person picks: the question is no longer open, so the badge goes and so do the waits.
    const thread = (await (await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { serverSession: string; thread: { messages: { questions?: { key: string; kind: string; prompt: string; revision: number }[] }[] } };
    const q = thread.thread.messages[0]!.questions![0]!;
    const pick = await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/messages/${sent.message_id}/picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: w.server.serverSession, questions: [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }] }),
    });
    expect(pick.status).toBe(200);
    rows = await w.rows();
    const after = rows.find((r) => r.thread_id === sent.thread_id)!;
    expect(after.section).not.toBe("holding");
    expect(after.waits).toBeUndefined();
  });

  test("capped: at most 8 questions, the prompt and Stopped line cut, at most 8 entries each, each cut", async () => {
    const w = await world();
    const long = "x".repeat(INBOX_ROW_WAIT_TEXT_MAX + 50);
    const entries = Array.from({ length: INBOX_ROW_WAIT_HOLDS_MAX + 3 }, (_, i) => `item ${i} ${"y".repeat(INBOX_ROW_WAIT_ENTRY_MAX)}`);
    const blocks = Array.from({ length: INBOX_ROW_WAITS_MAX + 2 }, (_, i) => block(`Question ${i} ${long}`, [`Stopped: ${long}`, `Holds up: ${entries.join("; ")}`]));
    await w.send(blocks.join("\n\n"), { thread: "many" });
    const [row] = await w.rows();
    expect(row!.waits).toHaveLength(INBOX_ROW_WAITS_MAX);
    for (const wait of row!.waits!) {
      expect([...wait.prompt].length).toBeLessThanOrEqual(INBOX_ROW_WAIT_TEXT_MAX);
      expect(wait.prompt.endsWith("…")).toBe(true);
      expect([...wait.stopped!].length).toBeLessThanOrEqual(INBOX_ROW_WAIT_TEXT_MAX);
      expect(wait.holds_up).toHaveLength(INBOX_ROW_WAIT_HOLDS_MAX);
      for (const h of wait.holds_up) expect([...h].length).toBeLessThanOrEqual(INBOX_ROW_WAIT_ENTRY_MAX);
    }
  });

  test("agents never read it: read_thread's list and wait_for_reply", async () => {
    const w = await world();
    const sent = await w.send(block("Ship it behind a flag?", ["Holds up: the retry worker"]), { thread: "flag" });
    expect((await w.rows())[0]!.waits).toHaveLength(1);
    const listed = await w.client.callTool({ name: "read_thread", arguments: { project_path: w.project, agent_session: "ses_rows" } });
    const text = JSON.stringify(listed);
    expect(text).not.toContain('"waits"');
    expect(text).toContain(sent.thread_id);
    const waited = await w.client.callTool({ name: "wait_for_reply", arguments: { project_path: w.project, agent_session: "ses_rows", thread_id: sent.thread_id, timeout_seconds: 1 } });
    expect(JSON.stringify(waited)).not.toContain('"waits"');
  });

  test("the phone door forwards it unchanged", async () => {
    const w = await world({ phones: true });
    await w.send(block("Which way on a 409?", ["Stopped: the deploy", "Holds up: the retry worker"]), { thread: "door" });
    const base = `http://127.0.0.1:${w.server.port}`;
    const offer = await fetch(`${base}/api/inbox/pairing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession }) });
    expect(offer.status).toBe(201);
    const { offer: made } = (await offer.json()) as { offer: { code: string } };
    const paired = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.code, name: "iPhone", platform: "ios" }) });
    expect(paired.status).toBe(201);
    const { token } = (await paired.json()) as { token: string };
    const res = await fetch(`${base}/api/inbox/device/threads`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const doorRows = ((await res.json()) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads);
    const windowRows = await w.rows();
    expect(doorRows[0]!.waits).toEqual(windowRows[0]!.waits);
    expect(doorRows[0]!.waits).toEqual([expect.objectContaining({ stopped: "the deploy", holds_up: ["the retry worker"] })]);
  });
});

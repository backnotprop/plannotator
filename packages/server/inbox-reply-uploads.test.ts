/**
 * Files pasted into the reply box, through the server's real doors: the
 * reply route takes `uploads` as compose's thread does. The uploads become
 * ordinary attachments on the person's reply; the agent reads them as
 * `Attached:` lines on its wake, and as attachment records in `read_thread`; a reply of files alone is a reply (words-only:
 * nothing answered, the still-open line); a replay copies nothing; an id
 * that is gone, a bad list and an archived thread are refused with nothing
 * written and nothing left behind. Every test uses its own temp data dir; the
 * connection is plain HTTP with the registry's token, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage, InboxThread, InboxUpload } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000009d74c6e10000000d49444154789c636060000000040001f61738550000000049454e44ae426082", "hex"));
const QUESTION = ["The chart is rendered.", "", ":::question", "Does the legend read right?", "- Yes", "- No", ":::"].join("\n");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-uploads-")));
  roots.push(root);
  const ledger = join(root, "ledger");
  mkdirSync(ledger, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-reply-uploads-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const inboxDir = join(dataDir, "inbox");

  /** The agent asks through the MCP, as the session `ses-pi` whose connection wakes it. */
  const ask = async (body: string, session = "ses-pi") => {
    const result = (await client.callTool({ name: "send_message", arguments: { body, project_path: ledger, agent_session: session, agent_host: "pi" } })) as {
      structuredContent: { message_id: string; thread_id: string };
    };
    return result.structuredContent;
  };
  const upload = async (name: string, bytes: Uint8Array | string): Promise<InboxUpload> => {
    const response = await fetch(`${base}/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`, { method: "POST", body: bytes });
    expect(response.status).toBe(200);
    return ((await response.json()) as { upload: InboxUpload }).upload;
  };
  const reply = (messageId: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, questions: [], ...body }),
    });
  const poll = async (session = "ses-pi") => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, host: "pi", waitMs: 0 }),
    });
    expect(response.status).toBe(200);
    return parseInboxBridgeCommands(await response.text());
  };
  const thread = async (id: string) => ((await (await fetch(`${base}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
  const sentFiles = () => {
    try {
      return readdirSync(join(inboxDir, "uploads")).filter((name) => name.startsWith("att_"));
    } catch {
      return [];
    }
  };
  const pending = (id: string) => existsSync(join(inboxDir, "uploads", "pending", `${id}.json`));
  return { server, client, base, ledger, inboxDir, ask, upload, reply, poll, thread, sentFiles, pending };
}

describe("a reply carrying pasted files", () => {
  test("the uploads become the reply's attachments; the agent reads them on its wake and in read_thread", async () => {
    const { client, ask, upload, reply, poll, thread, inboxDir, pending } = await setup();
    const asked = await ask(QUESTION);
    const shot = await upload("pasted-image-2026-10-16-0912.png", PNG);
    const notes = await upload("notes.md", "# Notes\n");

    const response = await reply(asked.message_id, { idempotency_key: "r1", words: "The legend overlaps.", uploads: [shot.upload_id, notes.upload_id] });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { reply: InboxMessage; replayed: boolean };
    expect(sent.replayed).toBe(false);
    const attachments = sent.reply.attachments!;
    expect(attachments.map((a) => [a.name, a.kind])).toEqual([
      ["pasted-image-2026-10-16-0912.png", "image"],
      ["notes.md", "markdown"],
    ]);
    for (const attachment of attachments) {
      // A real, read-only file under uploads/, with its own name.
      expect(attachment.path.startsWith(realpathSync(join(inboxDir, "uploads")))).toBe(true);
      expect(statSync(attachment.path).mode & 0o222).toBe(0);
    }
    expect(readFileSync(attachments[1]!.path, "utf8")).toBe("# Notes\n");
    // Sent: the pending records are gone.
    expect(pending(shot.upload_id)).toBe(false);
    expect(pending(notes.upload_id)).toBe(false);

    const attached = attachments.map((a) => `Attached: ${a.name} (${a.path})`).join("\n");
    const [command] = await poll();
    expect(command).toMatchObject({ type: "reply", id: sent.reply.id });
    // The reply as the store wrote it (the words, then the still-open line), then one line per file.
    expect(sent.reply.body.startsWith("The legend overlaps.")).toBe(true);
    expect(command!.body).toBe(`${sent.reply.body}\n\n${attached}`);

    const read =(await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-pi" } })) as {
      structuredContent: { thread: InboxThread };
    };
    const inThread = read.structuredContent.thread.messages.find((m) => m.id === sent.reply.id)!;
    expect(inThread.attachments!.map((a) => a.path)).toEqual(attachments.map((a) => a.path));

    // The window's thread lists them under the reply, like compose's files.
    const opened = await thread(asked.thread_id);
    expect(opened.messages.at(-1)!.attachments!.map((a) => a.name)).toEqual(["pasted-image-2026-10-16-0912.png", "notes.md"]);
  });

  test("files alone (no words, no answers) are a reply, read as a words-only one: nothing answered, the questions stay open", async () => {
    const { ask, upload, reply, poll, thread } = await setup();
    const asked = await ask(QUESTION);
    const shot = await upload("pasted-image-2026-10-16-0913.png", PNG);
    const response = await reply(asked.message_id, { idempotency_key: "r1", words: "", uploads: [shot.upload_id] });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { reply: InboxMessage; questions: { state: string }[] };
    expect(sent.questions.map((q) => q.state)).toEqual(["open"]);
    // The still-open line, as a words-only reply carries it; then the file.
    expect(sent.reply.body).toMatch(/^No question answered yet; it is still open\./);
    const [command] = await poll();
    expect(command!.body).toBe(`${sent.reply.body}\n\nAttached: ${shot.name} (${sent.reply.attachments![0]!.path})`);
    expect((await thread(asked.thread_id)).messages.at(-1)!.attachments).toHaveLength(1);

    // With no question to keep open, the body is empty and the agent reads the file line alone.
    const news = await ask("The chart is rendered; nothing to decide.", "ses-b");
    const second = await upload("pasted-image-2026-10-16-0914.png", PNG);
    const plain = (await (await reply(news.message_id, { idempotency_key: "r2", words: "", uploads: [second.upload_id] })).json()) as { reply: InboxMessage };
    expect(plain.reply.body).toBe("");
    const commands = await poll("ses-b");
    const latest = commands.find((c) => c.id === plain.reply.id)!;
    expect(latest.body).toBe(`Attached: ${second.name} (${plain.reply.attachments![0]!.path})`);
  });

  test("a replay answers the reply it wrote and copies nothing; a gone id, a bad list and an archived thread are refused, nothing written or left behind", async () => {
    const { server, base, ask, upload, reply, sentFiles, pending } = await setup();
    const asked = await ask(QUESTION);
    const shot = await upload("pasted-image-2026-10-16-0915.png", PNG);
    const body = { idempotency_key: "r1", words: "See this.", uploads: [shot.upload_id] };
    const first = (await (await reply(asked.message_id, body)).json()) as { reply: InboxMessage };
    expect(sentFiles()).toHaveLength(1);
    const cursor = server.store.cursor();

    const again = await reply(asked.message_id, body);
    expect(again.status).toBe(200);
    const replayed = (await again.json()) as { reply: InboxMessage; replayed: boolean };
    expect(replayed).toMatchObject({ replayed: true, reply: { id: first.reply.id } });
    expect(server.store.cursor()).toBe(cursor);
    expect(sentFiles()).toHaveLength(1);

    const gone = await reply(asked.message_id, { ...body, idempotency_key: "r2" });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe("upload_not_found");
    const notList = await reply(asked.message_id, { idempotency_key: "r3", words: "x", uploads: "upl_x" });
    expect(notList.status).toBe(422);
    const unknown = await reply("msg_01K70000000000000000000000", { idempotency_key: "r4", words: "x", uploads: [shot.upload_id] });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("message_not_found");
    expect(server.store.cursor()).toBe(cursor);
    expect(sentFiles()).toHaveLength(1);

    // An archived thread: refused after the copy was made, and the copy is removed; the upload stays for another Send.
    const other = await ask("Another run finished.");
    const kept = await upload("pasted-image-2026-10-16-0916.png", PNG);
    const archived = await fetch(`${base}/api/inbox/messages/${other.message_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, resolved: true }),
    });
    expect(archived.status).toBe(200);
    const before = server.store.cursor();
    const refused = await reply(other.message_id, { idempotency_key: "r5", words: "x", uploads: [kept.upload_id] });
    expect(refused.status).toBe(409);
    expect(server.store.cursor()).toBe(before);
    expect(sentFiles()).toHaveLength(1);
    expect(pending(kept.upload_id)).toBe(true);
  });
});

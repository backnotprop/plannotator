/**
 * A paired cloud agent fetches the files of a thread (contract section 13, point 6), through the agent door's own
 * handler in-process (no server): the files a local agent attached, a file the person attached to a reply and the
 * person's drawing on an image come whole across pieces with the Inbox's hash, by `plannotator inbox call`'s own
 * loop; nothing that is not a file of a message the agent may read comes out; a local agent's read_thread is as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPairedFile } from "../../apps/hook/server/inbox-call-fetch";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { callInboxThroughRelay } from "@plannotator/shared/inbox/agent-relay-client";
import { inboxBlobPath, recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { writeInboxMarkup } from "@plannotator/shared/inbox/markups";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload } from "@plannotator/shared/inbox/uploads";
import { INBOX_AGENT_FETCH_PIECE_BYTES } from "./inbox-agent-files";
import { createInboxAgentDoor } from "./inbox-agent-door";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TOKEN = "door-token-0123456789";
// A 1x1 PNG: a drawing must be an image by its bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-files-")));
  roots.push(root);
  const projectRoot = join(root, "ledger");
  mkdirSync(projectRoot, { recursive: true });
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "ledger", root: projectRoot });
  const mcp = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async () => project,
    recordAttachments: (paths: readonly string[], _project: unknown, base: string) => recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
  } as unknown as InboxMcpContext;
  const tools = (createInboxMcpServer(mcp) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;

  const big = randomBytes(INBOX_AGENT_FETCH_PIECE_BYTES * 2 + 12_345);
  writeFileSync(join(projectRoot, "demo.bin"), big);
  writeFileSync(join(projectRoot, "notes.md"), "# Notes\n");
  const sent = await tools.send_message!.handler(
    { project_path: projectRoot, agent_session: "ses_local", agent_host: "claude-code", agent_name: "Builder", subject: "Demo", body: "The demo.", attachments: ["notes.md", "demo.bin"] },
    {},
  );
  expect(sent.isError).toBeUndefined();
  const threadId = String(sent.structuredContent!.thread_id);
  const root0 = store.thread(threadId)!.messages[0]!;

  const at = new Date().toISOString();
  const shot = Buffer.from("the person's screenshot");
  const upload = await receiveInboxUpload(store.dir, "shot.txt", new Response(shot).body, { at });
  const drawing = writeInboxMarkup(store.dir, PNG);
  const reply = store.sendReply(root0.id, {
    words: "See my drawing and the file.",
    feedback: `**Attached images:**\n- [demo-markup] \`${drawing.path}\`\n`,
    attachments: await inboxUploadAttachments(store.dir, [upload.upload_id], at),
    idempotency_key: "reply-1",
  }).reply;

  const agent = { session: "cloud.0123456789ab", name: "Nightly fixer", preset: "other", url: null, key: null, project_id: null, created_at: at, key_set_at: null, key_rejected_at: null, device_id: "dev_1" } as InboxCloudAgent;
  const agents = {
    byDevice: (id: string) => (id === "dev_1" ? agent : null),
    homeRoot: () => join(root, "data", "inbox", "cloud-agents", agent.session),
    home: () => project,
    homeName: () => "Nightly fixer",
    seen: () => {},
  } as unknown as InboxCloudAgents;
  const device = { id: "dev_1", revoked_at: null };
  const door = createInboxAgentDoor({
    store,
    agents,
    mcp,
    devices: () => ({ byToken: (token: string) => (token === TOKEN ? device : null), byId: () => device, isOtherDevice: () => false, touch: () => {} }) as never,
  });
  const call = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    const answer = await door.handle(new Request("http://127.0.0.1/api/inbox/agent/call", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ tool, arguments: args }) }));
    return ((await answer.json()) as { result: Result }).result;
  };
  const refusal = async (args: Record<string, unknown>) => {
    const result = await call(INBOX_AGENT_FETCH_FILE, args);
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  };
  // `plannotator inbox call fetch_file`'s own loop, with the door in place of the relay.
  const fetchFile = (args: Record<string, unknown>, folder?: string) =>
    fetchPairedFile({ ...args, ...(folder ? { folder } : {}) }, root, async (tool, body) => {
      const result = await call(tool, body);
      if (result.isError) {
        const [, code = "inbox_error", message = ""] = /^([a-z_]+): ([\s\S]*)$/.exec(result.content[0]!.text) ?? [];
        return { ok: false, code, message };
      }
      return { ok: true, structured: result.structuredContent };
    });
  return { root, store, tools, threadId, root0, reply, big, shot, drawing, call, refusal, fetchFile };
}

describe("a paired cloud agent fetches the files of a thread", () => {
  test("read_thread through the door lists every file with its command and no path on the person's disk", async () => {
    const w = await world();
    const read = await w.call("read_thread", { thread_id: w.threadId });
    expect(read.isError).toBeUndefined();
    const text = read.content[0]!.text;
    const files = (id: string) => (read.structuredContent!.thread.messages as { id: string; files?: { file: string; name: string; fetch: string }[]; attachments?: unknown }[]).find((m) => m.id === id)!;
    const first = files(w.root0.id);
    const answer = files(w.reply.id);
    expect(first.attachments).toBeUndefined();
    expect(first.files!.map((f) => f.name)).toEqual(["notes.md", "demo.bin"]);
    expect(answer.files!.map((f) => f.name)).toEqual(["shot.txt", w.drawing.name]);
    for (const file of [...first.files!, ...answer.files!]) {
      const id = first.files!.includes(file) ? w.root0.id : w.reply.id;
      expect(file.fetch).toBe(`plannotator inbox call fetch_file '{"message_id":"${id}","file":"${file.file}"}'`);
      expect(text).toContain(file.fetch);
    }
    for (const attachment of [...w.root0.attachments!, ...w.store.message(w.reply.id)!.attachments!]) expect(text).not.toContain(attachment.path);
  });

  test("each file comes whole, across pieces, with the Inbox's hash; by its id or its name; an earlier copy is kept", async () => {
    const w = await world();
    const demo = w.root0.attachments!.find((a) => a.name === "demo.bin")!;
    const one = await w.fetchFile({ message_id: w.root0.id, file: demo.id }, "got");
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.saved.path).toBe(join(w.root, "got", "demo.bin"));
    expect(one.saved.size).toBe(w.big.length);
    expect(sha(readFileSync(one.saved.path))).toBe(sha(w.big));
    expect(one.saved.sha256).toBe(sha(w.big));

    const again = await w.fetchFile({ message_id: w.root0.id, file: "demo.bin" }, "got");
    expect(again.ok && again.saved.path).toBe(join(w.root, "got", "demo-2.bin"));

    const shot = await w.fetchFile({ message_id: w.reply.id, file: "shot.txt" });
    expect(shot.ok && readFileSync(shot.saved.path, "utf8")).toBe(w.shot.toString());
    const drawing = await w.fetchFile({ message_id: w.reply.id, file: w.drawing.name });
    expect(drawing.ok && sha(readFileSync(drawing.saved.path))).toBe(sha(PNG));
    expect(drawing.ok && drawing.saved.content_type).toBe("image/png");

    const piece = await w.call(INBOX_AGENT_FETCH_FILE, { message_id: w.root0.id, file: demo.id, offset: INBOX_AGENT_FETCH_PIECE_BYTES });
    expect(piece.structuredContent).toMatchObject({ offset: INBOX_AGENT_FETCH_PIECE_BYTES, next_offset: INBOX_AGENT_FETCH_PIECE_BYTES * 2, size: w.big.length, sha256: sha(w.big) });
    expect(Buffer.from(piece.structuredContent!.data, "base64").equals(w.big.subarray(INBOX_AGENT_FETCH_PIECE_BYTES, INBOX_AGENT_FETCH_PIECE_BYTES * 2))).toBe(true);
  });

  test("nothing but a file recorded on a message the agent may read comes out", async () => {
    const w = await world();
    const notes = w.root0.attachments!.find((a) => a.name === "notes.md")!;
    // Another message's file, named under this message.
    expect(await w.refusal({ message_id: w.reply.id, file: notes.id })).toStartWith("file_not_found:");
    // Paths and traversal, however written.
    for (const file of [notes.path, "../../notes.md", "..\\notes.md", `markups/${w.drawing.name}`, "..", "/etc/passwd"]) {
      expect(await w.refusal({ message_id: w.root0.id, file })).toStartWith("path_refused:");
    }
    // A drawing the message's words do not name, however real.
    const other = writeInboxMarkup(w.store.dir, Buffer.concat([PNG, Buffer.from([0])]));
    expect(await w.refusal({ message_id: w.reply.id, file: other.name })).toStartWith("file_not_found:");
    // No such message; a field it does not take; a bad offset; an offset past the end.
    expect(await w.refusal({ message_id: "msg_nope", file: notes.id })).toStartWith("message_not_found:");
    expect(await w.refusal({ message_id: w.root0.id, file: notes.id, path: notes.path })).toStartWith("validation_error:");
    expect(await w.refusal({ message_id: w.root0.id, file: notes.id, offset: -1 })).toStartWith("validation_error:");
    expect(await w.refusal({ message_id: w.root0.id, file: notes.id, offset: 9 })).toStartWith("validation_error:");
  });

  test("a reply the person took back is not the agent's to read, nor its file", async () => {
    const w = await world();
    const file = w.store.message(w.reply.id)!.attachments![0]!;
    w.store.takeBack(w.reply.id);
    expect(await w.refusal({ message_id: w.reply.id, file: file.id })).toStartWith("message_not_found:");
  });

  test("the Inbox's copy is read with no symlink followed, and a file past 100 MB is refused", async () => {
    const w = await world();
    const notes = w.root0.attachments!.find((a) => a.name === "notes.md")!;
    const blob = inboxBlobPath(w.store.dir, notes.sent_sha256);
    const secret = join(w.root, "secret.txt");
    writeFileSync(secret, "not for the cloud");
    renameSync(blob, `${blob}.moved`);
    symlinkSync(secret, blob);
    const text = await w.refusal({ message_id: w.root0.id, file: notes.id });
    expect(text).toStartWith("attachment_missing:");
    expect(text).not.toContain("not for the cloud");

    const demo = w.root0.attachments!.find((a) => a.name === "demo.bin")!;
    truncateSync(inboxBlobPath(w.store.dir, demo.sent_sha256), 100 * 1024 * 1024 + 1);
    expect(await w.refusal({ message_id: w.root0.id, file: demo.id })).toStartWith("file_too_large:");
  });

  test("a local agent's read_thread still gives each file's path, and fetch_file is no tool of /mcp", async () => {
    const w = await world();
    const read = await w.tools.read_thread!.handler({ thread_id: w.threadId, agent_session: "ses_local", agent_host: "claude-code" }, {});
    const [notes, demo] = w.root0.attachments!;
    expect(read.content[0]!.text).toContain(`Files: notes.md (markdown, 8 B): ${notes!.path}; demo.bin (file, ${(w.big.length / 1024).toFixed(1)} KB): ${demo!.path}\n`);
    expect(read.content[0]!.text).not.toContain("fetch_file");
    const message = (read.structuredContent!.thread.messages as { id: string; files?: unknown; attachments: unknown }[]).find((m) => m.id === w.root0.id)!;
    expect(message.files).toBeUndefined();
    expect(message.attachments).toEqual(w.root0.attachments!.map((a) => ({ name: a.name, kind: a.kind, size: a.size, path: a.path })));
    expect(w.tools[INBOX_AGENT_FETCH_FILE]).toBeUndefined();
  });
});


test("while the person's computer is asleep a fetch is a read: refused at once, nothing left waiting at the relay", async () => {
  const posted: string[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posted.push(url);
    return Response.json(url.includes("/items") ? { items: [], inbox_online: false } : { inbox_online: false });
  }) as typeof fetch;
  const pairing = { device_id: "dev_1", token: TOKEN, secret: randomBytes(32).toString("base64url"), relay: { url: "https://relay.example", mailbox_id: "mbx_1" } };
  const outcome = await callInboxThroughRelay(pairing, INBOX_AGENT_FETCH_FILE, { message_id: "msg_1", file: "att_1", offset: 0 }, { fetch: stub });
  expect(outcome).toMatchObject({ kind: "refused", code: "computer_asleep" });
  expect(posted).toEqual([]);
});

/**
 * A paired cloud agent fetches the files of a thread (contract section 13, point 6), through the agent door's own
 * handler in-process (no server): the files a local agent attached, a file the person attached to a reply and the
 * person's drawing on an image come whole across pieces with the Inbox's hash, by `plannotator inbox call`'s own
 * loop; read_thread gives each file's path on the person's computer too, as a local agent's does; nothing that is not
 * a file of a message the agent may read comes out; a local agent's read_thread is as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fetchPairedFile } from "../../apps/hook/server/inbox-call-fetch";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { callInboxThroughRelay } from "@plannotator/shared/inbox/agent-relay-client";
import { inboxBlobPath, recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { writeInboxMarkup } from "@plannotator/shared/inbox/markups";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload } from "@plannotator/shared/inbox/uploads";
import { INBOX_AGENT_FETCH_PIECE_BYTES, inboxAgentFetchAction } from "./inbox-agent-files";
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
  test("read_thread through the door lists every file with its path on the person's computer and the command that fetches it", async () => {
    const w = await world();
    const read = await w.call("read_thread", { thread_id: w.threadId });
    expect(read.isError).toBeUndefined();
    const text = read.content[0]!.text;
    const files = (id: string) => (read.structuredContent!.thread.messages as { id: string; files?: { file: string; name: string; path: string; fetch: string }[]; attachments?: unknown }[]).find((m) => m.id === id)!;
    const first = files(w.root0.id);
    const answer = files(w.reply.id);
    expect(first.attachments).toBeUndefined();
    expect(first.files!.map((f) => [f.name, f.path])).toEqual(w.root0.attachments!.map((a) => [a.name, a.path]));
    expect(answer.files!.map((f) => [f.name, f.path])).toEqual([["shot.txt", w.store.message(w.reply.id)!.attachments![0]!.path], [w.drawing.name, w.drawing.path]]);
    for (const file of [...first.files!, ...answer.files!]) {
      const id = first.files!.includes(file) ? w.root0.id : w.reply.id;
      expect(file.fetch).toBe(`plannotator inbox call fetch_file '{"message_id":"${id}","file":"${file.file}"}'`);
      expect(text).toContain(`${file.path} (to your machine: ${file.fetch})`);
    }
    // The project's folder and the person's words about a drawing, as a local agent reads them.
    expect(text).toContain(`(${w.store.project(w.root0.project_id)!.root})`);
    expect(text).toContain(`- [demo-markup] \`${w.drawing.path}\``);
  });

  test("format full gives the records as a local agent gets them, paths included", async () => {
    const w = await world();
    const full = await w.call("read_thread", { thread_id: w.threadId, format: "full" });
    const local = await w.tools.read_thread!.handler({ thread_id: w.threadId, format: "full", agent_session: "ses_other", agent_host: "claude-code" }, {});
    expect(full.isError).toBeUndefined();
    const records = (result: Result) => (result.structuredContent!.thread.messages as { attachments?: { path: string }[] }[]).map((m) => m.attachments?.map((a) => a.path) ?? []);
    expect(records(full)).toEqual(records(local));
    expect(records(full).flat()).toContain(w.root0.attachments![0]!.path);
  });

  test("each file comes whole, across pieces, with the Inbox's hash; by its id, its path or its name; an earlier copy is kept", async () => {
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
    const byPath = await w.fetchFile({ message_id: w.root0.id, file: demo.path }, "got");
    expect(byPath.ok && sha(readFileSync(byPath.saved.path))).toBe(sha(w.big));

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
    // A path that is not one of the message's files, however written, names nothing.
    for (const file of ["../../notes.md", "..\\notes.md", `markups/${w.drawing.name}`, "..", "/etc/passwd", join(w.root, "ledger", "other.bin")]) {
      expect(await w.refusal({ message_id: w.root0.id, file })).toStartWith("file_not_found:");
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

describe("pictures a body shows, by who wrote the message", () => {
  test("a cloud agent's own picture, captured at send from the file it attached, is listed and fetched whole", async () => {
    const w = await world();
    const sent = await w.call("send_message", { reply_to: w.reply.id, body: "Fixed: ![after](after.png)", attachments: [{ name: "after.png", data: PNG.toString("base64") }] });
    expect(sent.isError).toBeUndefined();
    const id = String(sent.structuredContent!.message_id);
    const image = w.store.message(id)!.inline_images![0]!;
    const read = await w.call("read_thread", { thread_id: w.threadId, message_id: id });
    const mine = (read.structuredContent!.thread.messages as { id: string; files?: { file: string }[] }[]).find((m) => m.id === id)!;
    expect(mine.files!.map((f) => f.file)).toEqual([image.id]);
    const got = await w.fetchFile({ message_id: id, file: "after.png" });
    expect(got.ok && sha(readFileSync(got.saved.path))).toBe(sha(PNG));
  });

  test("a picture a body shows is handed out from the Inbox's copy, whoever wrote the message and wherever it was read from", async () => {
    const w = await world();
    const onDisk = join(w.root, "ledger", "desk.png");
    writeFileSync(onDisk, PNG);
    const blob = inboxBlobPath(w.store.dir, sha(PNG));
    writeFileSync(blob, PNG);
    const picture = (id: string, extra: Record<string, unknown> = {}) => ({ id, path: onDisk, named_path: null, name: `${id}.png`, kind: "image", sent_sha256: sha(PNG), size: PNG.length, sent_at: "2026-11-21T00:00:00.000Z", sent_mtime: "2026-11-21T00:00:00.000Z", media_type: "image/png", ref: `${id}.png`, ...extra });
    const fromUpload = picture("att_UPLOAD", { path: realpathSync(blob) });
    const disk = picture("att_DISK");
    const onOpen = picture("att_OPEN", { path: realpathSync(blob), captured: "on_open", captured_at: "2026-11-21T00:00:01.000Z" });
    const storeWith = (author: Record<string, unknown>) => {
      const message = { id: "msg_PIC", thread_id: "msg_PIC", reply_to: null, author, body: "Look.", inline_images: [fromUpload, disk, onOpen] };
      return { dir: w.store.dir, message: () => message, agentThread: () => ({ messages: [message] }) } as unknown as InboxStore;
    };
    const fetchFrom = (store: InboxStore, file: string) => inboxAgentFetchAction(store, "cloud.0123456789ab", INBOX_AGENT_FETCH_FILE, { message_id: "msg_PIC", file }).then(
      (result) => result!.structuredContent!.sha256 as string,
      (error: { code: string }) => error.code,
    );
    for (const author of [{ kind: "agent", host: "cloud", session: "cloud.0123456789ab", name: "Nightly fixer" }, { kind: "agent", host: "claude-code", session: "ses_local", name: "Builder" }]) {
      for (const file of ["att_UPLOAD", "att_DISK", "att_OPEN"]) expect([author.host, file, await fetchFrom(storeWith(author), file)]).toEqual([author.host, file, sha(PNG)]);
    }
  });

  test("a file in the dotenv family is never handed out, whatever the record says", async () => {
    const w = await world();
    const bytes = Buffer.from("TOKEN=1\n");
    writeFileSync(inboxBlobPath(w.store.dir, sha(bytes)), bytes);
    const record = { id: "att_ENV", path: join(w.root, ".env"), named_path: null, name: ".env", kind: "text", sent_sha256: sha(bytes), size: bytes.length, sent_at: "2026-11-21T00:00:00.000Z", sent_mtime: "2026-11-21T00:00:00.000Z" };
    const message = { id: "msg_ENV", thread_id: "msg_ENV", reply_to: null, author: { kind: "agent", host: "claude-code", session: "ses_local" }, body: "Env.", attachments: [record] };
    const store = { dir: w.store.dir, message: () => message, agentThread: () => ({ messages: [message] }) } as unknown as InboxStore;
    const refused = await inboxAgentFetchAction(store, "cloud.0123456789ab", INBOX_AGENT_FETCH_FILE, { message_id: "msg_ENV", file: "att_ENV" }).catch((error: { code: string; message: string }) => error);
    expect(refused).toMatchObject({ code: "attachment_refused" });
    expect(JSON.stringify(refused)).not.toContain("TOKEN");
  });
});

describe("inbox call fetch_file saves under a safe name, inside the folder it was given", () => {
  const hostile = ["../../x", "/etc/passwd", "a\u0000b.txt", ".", "..", "...", "\\server\\share\\x.txt", `${"long-".repeat(80)}.png`, "line\nbreak.txt"];
  test.each(hostile)("%j", async (name) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-fetch-name-")));
    roots.push(root);
    const bytes = Buffer.from("payload");
    const result = await fetchPairedFile({ message_id: "msg_1", file: "att_1", folder: "saved" }, root, async () => ({
      ok: true,
      structured: { name, size: bytes.length, sha256: sha(bytes), content_type: "text/plain", offset: 0, next_offset: null, data: bytes.toString("base64") },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const folder = join(root, "saved");
    expect(dirname(result.saved.path)).toBe(folder);
    expect(readdirSync(folder)).toEqual([basename(result.saved.path)]);
    expect(Buffer.byteLength(basename(result.saved.path))).toBeLessThanOrEqual(200);
    expect(basename(result.saved.path)).not.toMatch(/[\x00-\x1f\\/]|^\.+$/);
    expect(readFileSync(result.saved.path, "utf8")).toBe("payload");
    expect(readdirSync(root)).toEqual(["saved"]);
  });
});

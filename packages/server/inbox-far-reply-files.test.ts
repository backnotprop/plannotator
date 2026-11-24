/**
 * An agent's answer with files in another computer's thread, while that computer is away (inbox-mcp-far-reply.ts,
 * inbox-outbox-files.ts, the sender loop's `send` in inbox-peer-link.ts). This computer's real outbox, store folder,
 * attachment rules and upload sweep in a temp data folder; the thread's computer is a stand-in door (its `uploads`
 * and `agent-reply` routes), reached through PeerLink's own send. What regresses: files refused while that computer is
 * away; a held file lost when the agent's file changes, or taken by a sweep while it waits; a file sent twice, or the
 * answer twice, after a retry; a refusal there with nobody told, or its files kept for ever; a file that computer would
 * refuse held for hours before it says so; the words-only path changed; an older computer's answer held.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath, recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { listInboxUploads, sweepInboxUploads } from "@plannotator/shared/inbox/uploads";
import { farAgentReply, FAR_REPLY_WORDS, type FarReplyDeps } from "./inbox-mcp-far-reply";
import { InboxOutbox, type OutboxEntry } from "./inbox-outbox";
import { holdOutboxFiles, outboxHeldUploadsOnDisk, sendWithFiles } from "./inbox-outbox-files";
import { PeerLink } from "./inbox-peer-link";
import type { InboxPeerTransport } from "./inbox-transport";

const STUDIO = "ibx_01JZ00000000000000000000S1";
const THREAD = "msg_01JZ0000000000000000000000";
const DAY = 24 * 3600_000;
const temp = (name: string) => mkdtempSync(join(tmpdir(), `plannotator-far-files-${name}-`));
const next = async () => "NEXT";

/** The thread's computer's door: its uploads (bytes kept by id) and the answers it wrote. */
function studioDoor(script: { upload?: (n: number) => Response | null; reply?: (body: Record<string, any>, n: number) => Response | null } = {}) {
  const uploads = new Map<string, { name: string; bytes: string }>();
  const replies: Record<string, any>[] = [];
  const auth: (string | undefined)[] = [];
  let n = 0;
  let r = 0;
  const transport = {
    spec: { kind: "tailnet", address: "studio.test.ts.net:8443" },
    describe: () => "studio",
    events: () => new Promise<Response>(() => {}),
    request: async (route: string, search: string, init: { headers: Record<string, string>; body?: BodyInit | null }) => {
      auth.push(init.headers.Authorization);
      if (route === "uploads") {
        const scripted = script.upload?.(n);
        n += 1;
        if (scripted === null) throw new Error("the line went down");
        if (scripted) return scripted;
        const id = `upl_01JZ00000000000000000000${String(uploads.size).padStart(2, "0")}`;
        uploads.set(id, { name: new URLSearchParams(search).get("name")!, bytes: await new Response(init.body).text() });
        return Response.json({ upload: { upload_id: id } });
      }
      if (route === "agent-reply") {
        const body = JSON.parse(String(init.body)) as Record<string, any>;
        const scripted = script.reply?.(body, r);
        r += 1;
        if (scripted === null) throw new Error("the line went down");
        if (scripted) return scripted;
        // One message per key, as that computer's door and store answer a key seen before.
        if (!replies.some((seen) => seen.idempotency_key === body.idempotency_key)) replies.push(body);
        const files = (body.args.attachments ?? []).map((id: string) => uploads.get(id)?.bytes ?? "MISSING");
        return Response.json({ text: `Wrote: ${body.args.body} [${files.join(" | ")}]`, structured: {} });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  };
  return { transport: transport as unknown as InboxPeerTransport, uploads, replies, auth, uploadTries: () => n };
}

/** This computer: the agent's, with its real outbox and store folder; `door` plays the thread's computer. */
function laptop(door: ReturnType<typeof studioDoor>, more: Partial<FarReplyDeps> = {}, dataDir = temp("laptop")) {
  const outbox = InboxOutbox.open(dataDir);
  const storeDir = inboxDir(dataDir);
  const state = { online: false };
  const link = new PeerLink({
    link: { id: STUDIO, name: "Studio", token: "tok_laptop", transport: { kind: "tailnet", address: "studio.test.ts.net:8443" } as never, device_id: null, linked_at: "2026-11-24T09:00:00.000Z" },
    transport: door.transport,
    outbox,
    onRecord: () => {},
    onChange: () => {},
    onRevoked: () => {},
  });
  const send = (entry: OutboxEntry) => (link as unknown as { send: (e: OutboxEntry) => Promise<unknown> }).send(entry) as never;
  /** That computer is back: the sender loop runs, as on its hello. */
  const back = async () => {
    state.online = true;
    return outbox.drain(STUDIO, send);
  };
  const deps: FarReplyDeps = {
    placeOf: async (id) => (id === THREAD ? { machine: STUDIO, thread_id: THREAD } : null),
    nameOf: () => "Studio",
    takes: () => true,
    holdWrite: (machine, route, body, thread, waitMs, own = {}) => {
      const { entry } = outbox.submit(machine, route, body, thread, false, null, true, own);
      if (!state.online) return outbox.waitSettled(entry.key, 0);
      return outbox.drain(machine, send).then(() => outbox.waitSettled(entry.key, waitMs));
    },
    heldWrite: (key) => outbox.get(key),
    dismissHeld: (key) => void outbox.dismiss(key),
    readFiles: (paths, base) => recordInboxAttachments(storeDir, paths, { base: base ?? "/", at: new Date().toISOString() }),
    holdFiles: (files) => holdOutboxFiles(storeDir, files, new Date().toISOString()),
    ...more,
  };
  return { outbox, storeDir, dataDir, state, deps, back, send };
}

/** The agent's working folder with two files the body names. */
function workFolder() {
  const folder = temp("work");
  writeFileSync(join(folder, "notes.md"), "# Notes v1\n");
  writeFileSync(join(folder, "shot.png"), "png-bytes-v1");
  return folder;
}

const only = (outbox: InboxOutbox) => {
  const entries = outbox.list(STUDIO);
  expect(entries).toHaveLength(1);
  return entries[0]!;
};

describe("an answer with files for a computer that is away", () => {
  test("is held with the words-only line, keeps its files here as they were, and goes once with words and files when that computer is back", async () => {
    const door = studioDoor();
    const { deps, outbox, back } = laptop(door);
    const folder = workFolder();
    const words = await farAgentReply(deps, { body: "Words only.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "w1" }, next, folder);
    const held = await farAgentReply(deps, { body: "See ![shot](shot.png).", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "f1", attachments: ["notes.md"] }, next, folder);
    // The same line as words alone: nothing was refused.
    expect(held!.text).toBe(`${FAR_REPLY_WORDS.held(THREAD, "Studio")} NEXT`);
    expect(held!.text).toBe(words!.text);
    expect(held!.structured).toMatchObject({ held: true, thread_id: THREAD });
    expect(door.uploadTries()).toBe(0);
    // The agent's files change and go while it waits: what it sent is what goes.
    writeFileSync(join(folder, "notes.md"), "# Notes v2\n");
    writeFileSync(join(folder, "shot.png"), "png-bytes-v2");
    expect(await back()).toBe("empty");
    expect(door.replies).toHaveLength(2);
    const sent = door.replies[1]!;
    expect(sent.args.body).toBe("See ![shot](shot.png).");
    expect(sent.args.attachments).toHaveLength(2);
    expect(sent.args.attachments.map((id: string) => door.uploads.get(id))).toEqual([
      { name: "notes.md", bytes: "# Notes v1\n" },
      { name: "shot.png", bytes: "png-bytes-v1" },
    ]);
    // Every request carried the link's token.
    expect(new Set(door.auth)).toEqual(new Set(["Bearer tok_laptop"]));
    const entry = outbox.list(STUDIO).find((e) => e.files)!;
    expect(entry.state).toBe("delivered");
    expect((entry.answer as { text: string }).text).toBe("Wrote: See ![shot](shot.png). [# Notes v1\n | png-bytes-v1]");
    // The agent's retry is the first send's answer: nothing goes again.
    const again = await farAgentReply(deps, { body: "See ![shot](shot.png).", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "f1", attachments: ["notes.md"] }, next, folder);
    expect(again!.text).toBe("Wrote: See ![shot](shot.png). [# Notes v1\n | png-bytes-v1]");
    expect(await back()).toBe("empty");
    expect(door.uploadTries()).toBe(2);
    expect(door.replies).toHaveLength(2);
  });

  test("a retry after a crash between the files and the answer sends no file twice and the answer once", async () => {
    // The line goes down after the first file, then after both files before the answer lands.
    const door = studioDoor({ upload: (n) => (n === 1 ? null : undefined) as never, reply: (_body, r) => (r === 0 ? null : undefined) as never });
    const first = laptop(door);
    const folder = workFolder();
    await farAgentReply(first.deps, { body: "Both files.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "c1", attachments: ["notes.md", "shot.png"] }, next, folder);
    expect(await first.back()).toBe("unreachable");
    const after = only(first.outbox);
    expect([after.state, after.left, after.sent_files]).toEqual(["sending", true, [...door.uploads.keys()]]);
    expect(door.uploads.size).toBe(1);
    // Back: only the second file goes, then the answer, which never arrives.
    expect(await first.back()).toBe("unreachable");
    expect(door.uploads.size).toBe(2);
    expect(only(first.outbox).sent_files).toHaveLength(2);
    // This Inbox stops here (a crash) and starts again: the outbox is read from disk.
    const restarted = laptop(door, {}, first.dataDir);
    expect(await restarted.back()).toBe("empty");
    expect(door.uploads.size).toBe(2);
    expect(door.replies).toHaveLength(1);
    expect(door.replies[0]!.args.attachments).toEqual([...door.uploads.keys()]);
    expect(only(restarted.outbox).state).toBe("delivered");
  });

  test("ids that computer forgot while it was away (its day-old uploads swept) are sent again once", async () => {
    const door = studioDoor({ reply: (body, r) => (r === 0 ? null : r === 1 ? Response.json({ code: "validation_error", error: "attachments[0]: not a file sent to this computer." }, { status: 422 }) : undefined) as never });
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Late.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "s1", attachments: ["notes.md"] }, next, workFolder());
    expect(await back()).toBe("unreachable");
    expect(await back()).toBe("empty");
    expect(door.uploadTries()).toBe(2);
    expect(only(outbox).state).toBe("delivered");
    expect(door.replies[0]!.args.attachments).toEqual([[...door.uploads.keys()][1]]);
  });

  test("refused there later: a notice under the thread, its files kept until it is dismissed, then swept", async () => {
    const door = studioDoor({ upload: () => Response.json({ code: "upload_refused", error: "The file could not be received; try again." }, { status: 400 }) });
    const { deps, outbox, back, storeDir, dataDir } = laptop(door);
    await farAgentReply(deps, { body: "Refused file.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "r1", attachments: ["notes.md"] }, next, workFolder());
    const [upload] = listInboxUploads(storeDir);
    const blob = inboxBlobPath(storeDir, upload!.sha256);
    expect(await back()).toBe("empty");
    expect(door.replies).toEqual([]);
    expect(outbox.notices()).toEqual([expect.objectContaining({ state: "refused", thread: THREAD, answer: { code: "upload_refused", error: "The file could not be received; try again." } })]);
    // A day later, its notice still up: the sweep keeps the file.
    const sweep = () => sweepInboxUploads(storeDir, { keep: new Set(outboxHeldUploadsOnDisk(dataDir)), usedBlobs: new Set(), now: Date.now() + DAY + 60_000 });
    expect(sweep()).toEqual([]);
    expect(existsSync(blob)).toBe(true);
    outbox.dismiss(only(outbox).key);
    expect(outboxHeldUploadsOnDisk(dataDir)).toEqual([]);
    expect(sweep()).toEqual([upload!.upload_id]);
    expect(existsSync(blob)).toBe(false);
  });

  test("the thread deleted there meanwhile: the same notice, the files released once it is dismissed", async () => {
    const door = studioDoor({ reply: () => Response.json({ code: "message_not_found", error: "No message." }, { status: 404 }) });
    const { deps, outbox, back, dataDir } = laptop(door);
    await farAgentReply(deps, { body: "Gone thread.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "d1", attachments: ["notes.md"] }, next, workFolder());
    expect(outboxHeldUploadsOnDisk(dataDir)).toHaveLength(1);
    expect(await back()).toBe("empty");
    expect(outbox.notices()).toEqual([expect.objectContaining({ state: "refused", answer: { code: "message_not_found", error: "No message." } })]);
    expect(outboxHeldUploadsOnDisk(dataDir)).toHaveLength(1);
    outbox.dismiss(only(outbox).key);
    expect(outboxHeldUploadsOnDisk(dataDir)).toEqual([]);
  });

  test("no sweep takes a held file while it waits: not the day-old upload sweep, not the store's after a deletion", async () => {
    const door = studioDoor();
    const { deps, back, storeDir, dataDir } = laptop(door);
    await farAgentReply(deps, { body: "Wait.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "k1", attachments: ["notes.md"] }, next, workFolder());
    const [upload] = listInboxUploads(storeDir);
    const blob = inboxBlobPath(storeDir, upload!.sha256);
    expect(sweepInboxUploads(storeDir, { keep: new Set(outboxHeldUploadsOnDisk(dataDir)), usedBlobs: new Set(), now: Date.now() + 3 * DAY })).toEqual([]);
    // A thread deleted here sweeps every blob nothing uses: a held file is used.
    const store = InboxStore.open(dataDir);
    const project = store.ensureProject({ name: "api", root: "/work/api" });
    const thread = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_x", name: null }, body: "Delete me." }).message;
    store.deleteThread(thread.thread_id);
    expect(existsSync(blob)).toBe(true);
    expect(await back()).toBe("empty");
    expect([...door.uploads.values()]).toEqual([{ name: "notes.md", bytes: "# Notes v1\n" }]);
  });

  test("a file that computer's uploads would refuse is refused now, nothing held", async () => {
    const door = studioDoor();
    const { deps, outbox, storeDir } = laptop(door);
    const folder = workFolder();
    mkdirSync(join(folder, "docs"));
    writeFileSync(join(folder, ".env"), "TOKEN=1\n");
    await expect(farAgentReply(deps, { body: "A folder.", reply_to: THREAD, agent_session: "ses_one", attachments: ["docs"] }, next, folder)).rejects.toMatchObject({ code: "validation_error" });
    await expect(farAgentReply(deps, { body: "A secret.", reply_to: THREAD, agent_session: "ses_one", attachments: [".env"] }, next, folder)).rejects.toMatchObject({ code: "validation_error" });
    // Past the size that computer takes, in its own words; the other file of the send is not held either.
    const read = await recordInboxAttachments(storeDir, [join(folder, "notes.md")], { base: folder, at: new Date().toISOString() });
    const big: InboxAttachment = { ...read[0]!, size: INBOX_UPLOAD_MAX_BYTES + 1 };
    const oversize = laptop(door, { readFiles: async () => [read[0]!, big] });
    await expect(farAgentReply(oversize.deps, { body: "Too big.", reply_to: THREAD, agent_session: "ses_one", attachments: ["notes.md", "huge.bin"] }, next, folder)).rejects.toMatchObject({
      code: "upload_too_large",
      message: `Not attached: a file is at most ${INBOX_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    });
    // A name that computer refuses (a control character).
    await expect(holdOutboxFiles(storeDir, [{ attachment: read[0]!, name: "bad\u0007name.md" }], new Date().toISOString())).rejects.toMatchObject({ code: "upload_refused" });
    expect(outbox.list(STUDIO)).toEqual([]);
    expect(oversize.outbox.list(STUDIO)).toEqual([]);
    expect(listInboxUploads(storeDir)).toEqual([]);
    expect(listInboxUploads(oversize.storeDir)).toEqual([]);
  });

  test("words alone go exactly as before: no file step, the body as held", async () => {
    const door = studioDoor();
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Words.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "t1" }, next, undefined);
    const entry = only(outbox);
    expect(entry.files).toBeUndefined();
    expect(await back()).toBe("empty");
    expect(door.uploadTries()).toBe(0);
    expect(door.replies).toEqual([entry.body]);
    // The file step alone: an entry with no files posts its body untouched.
    const posted: unknown[] = [];
    await sendWithFiles(entry, { storeDir: "", machineName: "Studio", upload: async () => Response.json({}), note: () => {}, post: async (body) => (posted.push(body), null) });
    expect(posted).toEqual([entry.body]);
  });

  test("an older Plannotator there is refused at once, as before: nothing held, no file kept", async () => {
    const door = studioDoor();
    const { deps, outbox, storeDir } = laptop(door, { takes: () => false });
    await expect(farAgentReply(deps, { body: "x", reply_to: THREAD, agent_session: "ses_one", attachments: ["notes.md"] }, next, workFolder())).rejects.toMatchObject({ code: "thread_on_other_machine" });
    expect(outbox.list(STUDIO)).toEqual([]);
    expect(listInboxUploads(storeDir)).toEqual([]);
  });
});

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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath, inboxBlobsDir, recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { listInboxUploads, sweepInboxUploads } from "@plannotator/shared/inbox/uploads";
import { farAgentReply, FAR_REPLY_WORDS, readFarFiles, type FarReplyDeps } from "./inbox-mcp-far-reply";
import { rawCommandKeyRefusal } from "./inbox-devices";
import { InboxOutbox, OUTBOX_MAX_SERVER_ERRORS, outboxWaitsForFiles, type OutboxEntry } from "./inbox-outbox";
import { holdOutboxFiles, outboxHeldUploadsOnDisk, sendWithFiles } from "./inbox-outbox-files";
import type { OutboxFileLane } from "./inbox-outbox-file-lane";
import { PeerLink } from "./inbox-peer-link";
import type { InboxPeerTransport } from "./inbox-transport";

const STUDIO = "ibx_01JZ00000000000000000000S1";
const THREAD = "msg_01JZ0000000000000000000000";
const DAY = 24 * 3600_000;
const temp = (name: string) => mkdtempSync(join(tmpdir(), `plannotator-far-files-${name}-`));
const next = async () => "NEXT";

type DoorScript = {
  upload?: (n: number) => Response | null | undefined;
  /** How the door takes a file's bytes (a slow line, one that stops); default: all at once. */
  take?: (body: ReadableStream<Uint8Array>, signal: AbortSignal, n: number) => Promise<string>;
  /** The file landed there but its answer never came back (this Inbox crashed, the line went down). */
  lost?: (n: number) => boolean;
  reply?: (body: Record<string, any>, n: number) => Response | null | undefined;
};

/**
 * The thread's computer's door: its uploads (bytes kept by id) and the answers it wrote. Its `uploads` route refuses a
 * file without a key exactly as the real door does (its own `rawCommandKeyRefusal`), and answers a key it has seen
 * with the first answer, as the real door's `claim` does.
 */
function studioDoor(script: DoorScript = {}) {
  const uploads = new Map<string, { name: string; bytes: string }>();
  const replies: Record<string, any>[] = [];
  const others: string[] = [];
  const auth: (string | undefined)[] = [];
  const keys: (string | null)[] = [];
  const answered = new Map<string, unknown>();
  // The door's `claim`: a key whose first request is still running there makes the next one wait for it.
  const running = new Map<string, Promise<unknown>>();
  let n = 0;
  let r = 0;
  /** That door's side of one upload: it runs on there even when the sender has given up on it. */
  const take = async (key: string, query: URLSearchParams, init: { body?: BodyInit | null }, signal: AbortSignal): Promise<Response> => {
    while (running.has(key)) await running.get(key)!.catch(() => {});
    if (answered.has(key)) return Response.json(answered.get(key), { headers: { "Idempotent-Replayed": "true" } });
    const tried = n;
    const scripted = script.upload?.(tried);
    n += 1;
    if (scripted === null) throw new Error("the line went down");
    if (scripted) return scripted;
    const bytes = script.take ? await script.take(init.body as ReadableStream<Uint8Array>, signal, tried) : await new Response(init.body).text();
    const id = `upl_01JZ00000000000000000000${String(uploads.size).padStart(2, "0")}`;
    uploads.set(id, { name: query.get("name")!, bytes });
    answered.set(key, { upload: { upload_id: id } });
    if (script.lost?.(tried)) throw new Error("the answer never came back");
    return Response.json({ upload: { upload_id: id } });
  };
  const transport = {
    spec: { kind: "tailnet", address: "studio.test.ts.net:8443" },
    describe: () => "studio",
    events: () => new Promise<Response>(() => {}),
    request: async (route: string, search: string, init: { headers: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }) => {
      auth.push(init.headers.Authorization);
      if (route === "uploads") {
        const query = new URLSearchParams(search);
        keys.push(query.get("idempotency_key"));
        const missing = rawCommandKeyRefusal(query);
        if (missing) return missing;
        const key = query.get("idempotency_key")!;
        const signal = init.signal ?? new AbortController().signal;
        const work = take(key, query, init, signal);
        running.set(key, work);
        void work.catch(() => {}).finally(() => running.get(key) === work && running.delete(key));
        // The sender gives up when its signal aborts; that door's side may go on (a half-open request).
        return Promise.race([work, new Promise<never>((_resolve, reject) => (signal.aborted ? reject(signal.reason) : signal.addEventListener("abort", () => reject(signal.reason), { once: true })))]);
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
      if (route === "threads/msg_01JZ0000000000000000000000/read") {
        others.push(route);
        return Response.json({ ok: true });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  };
  return { transport: transport as unknown as InboxPeerTransport, uploads, replies, others, auth, keys, uploadTries: () => n };
}

/** A door that takes a file's bytes a piece at a time, `ms` apart (a slow line that keeps moving). */
const slowly = (ms: number) => async (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  let length = 0;
  for (;;) {
    const piece = await reader.read();
    if (piece.done) return `${length} bytes`;
    length += piece.value.length;
    await Bun.sleep(ms);
  }
};

/** A door that takes the first piece, then no more: the request ends only when the sender gives up. */
const stalls = async (body: ReadableStream<Uint8Array>, signal: AbortSignal) => {
  await body.getReader().read();
  return new Promise<string>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
};

/**
 * This computer: the agent's, with its real outbox and store folder; `door` plays the thread's computer. `fileIdleMs`:
 * the link's no-progress limit for a file. `waitScale`: the agent's wait, scaled down so a test runs in a second.
 */
function laptop(door: ReturnType<typeof studioDoor>, more: Partial<FarReplyDeps> = {}, dataDir = temp("laptop"), opts: { fileIdleMs?: number; waitScale?: number; fileRetryMinMs?: number } = {}) {
  const outbox = InboxOutbox.open(dataDir);
  const storeDir = inboxDir(dataDir);
  const state = { online: false };
  const waits: number[] = [];
  let drained: Promise<unknown> = Promise.resolve();
  const link = new PeerLink({
    // A failed file's pause is none here, so each `back` is the next try; its own test sets one.
    timings: { fileRetryMinMs: opts.fileRetryMinMs ?? 0, ...(opts.fileIdleMs ? { fileIdleMs: opts.fileIdleMs } : {}) },
    link: { id: STUDIO, name: "Studio", token: "tok_laptop", transport: { kind: "tailnet", address: "studio.test.ts.net:8443" } as never, device_id: null, linked_at: "2026-11-24T09:00:00.000Z" },
    transport: door.transport,
    outbox,
    onRecord: () => {},
    onChange: () => {},
    onRevoked: () => {},
  });
  const send = (entry: OutboxEntry) => (link as unknown as { send: (e: OutboxEntry) => Promise<unknown> }).send(entry) as never;
  // The link's own file lane (its uploads, its keys, its idle limit).
  const lane = (link as unknown as { files: OutboxFileLane }).files;
  /** What PeerLink.flush starts: the file lane and the write queue side by side, the queue again once files are up. */
  const flush = () => Promise.all([outbox.drain(STUDIO, send), lane.run().then((files) => outbox.drain(STUDIO, send).then(() => files))]);
  /** That computer is back: the lane, then the queue (and once more for files that go again); the lane's result when it did not finish, else the queue's. */
  const back = async (): Promise<string> => {
    state.online = true;
    for (let i = 0; ; i++) {
      const files = await lane.run();
      const words = await outbox.drain(STUDIO, send);
      if (files !== "empty") return files;
      if (i > 0 || !outbox.list(STUDIO, "pending").some(outboxWaitsForFiles)) return words;
    }
  };
  const deps: FarReplyDeps = {
    placeOf: async (id) => (id === THREAD ? { machine: STUDIO, thread_id: THREAD } : null),
    nameOf: () => "Studio",
    takes: () => true,
    // As inbox-machines.ts holds it: sent now while online (the sender loop runs on), the agent waiting up to `waitMs`.
    holdWrite: (machine, route, body, thread, waitMs, own = {}) => {
      const { entry } = outbox.submit(machine, route, body, thread, false, null, true, own);
      waits.push(waitMs);
      if (!state.online) return outbox.waitSettled(entry.key, 0);
      drained = flush();
      return outbox.waitSettled(entry.key, waitMs * (opts.waitScale ?? 1));
    },
    heldWrite: (key) => outbox.get(key),
    dismissHeld: (key) => void outbox.dismiss(key),
    readFiles: (paths, base) => readFarFiles(storeDir, paths, base),
    holdFiles: (files) => holdOutboxFiles(storeDir, files, new Date().toISOString()),
    ...more,
  };
  return { outbox, storeDir, dataDir, state, deps, back, send, lane, waits, drained: () => drained };
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
    // The line went down: unreachable, nothing counted; the answer itself never left the queue.
    expect(await first.back()).toBe("unreachable");
    const after = only(first.outbox);
    expect([after.state, after.left, after.errors, after.sent_files]).toEqual(["queued", false, 0, [...door.uploads.keys()]]);
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
    // That computer's refusal as its door sends it (inbox-far-send.ts through `farTagWrite`): the field names the file.
    const forgot = () => Response.json({ error: "attachments[0]: not a file sent to this computer.", code: "validation_error", field: "attachments[0]" }, { status: 422 });
    const door = studioDoor({ reply: (_body, r) => (r === 0 ? null : r === 1 ? forgot() : undefined) });
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
    await sendWithFiles(entry, { forgot: () => false, post: async (body) => (posted.push(body), null) });
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

describe("its files at that computer's door", () => {
  test("each file goes under its own key, the door's rule: a file with none is refused there", async () => {
    // The stand-in refuses as the real door does, by the door's own function.
    const bare = await (studioDoor().transport.request("uploads", "?name=notes.md", { method: "POST", headers: {}, body: "x" }) as Promise<Response>);
    expect(bare.status).toBe(422);
    expect(await bare.json()).toEqual(await rawCommandKeyRefusal(new URLSearchParams("name=notes.md"))!.json());
    const door = studioDoor();
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Two.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "k2", attachments: ["notes.md", "shot.png"] }, next, workFolder());
    expect(await back()).toBe("empty");
    expect(only(outbox).state).toBe("delivered");
    expect(door.keys).toHaveLength(2);
    expect(new Set(door.keys).size).toBe(2);
    for (const key of door.keys) expect(key).toStartWith(only(outbox).key);
  });

  test("a file that landed but whose answer was lost is not taken twice: the retry, under the same key, gets its id", async () => {
    const door = studioDoor({ lost: (n) => n === 0 });
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Once.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "o1", attachments: ["notes.md"] }, next, workFolder());
    expect(await back()).toBe("unreachable");
    expect([only(outbox).sent_files ?? [], only(outbox).errors]).toEqual([[], 0]);
    expect(await back()).toBe("empty");
    expect(door.uploads.size).toBe(1);
    expect(door.keys[0]).toBe(door.keys[1]!);
    expect(door.replies).toHaveLength(1);
    expect(door.replies[0]!.args.attachments).toEqual([...door.uploads.keys()]);
  });

  test("a slow file that keeps moving goes, however long it takes", async () => {
    const door = studioDoor({ take: slowly(40) });
    const { deps, outbox, back } = laptop(door, {}, undefined, { fileIdleMs: 150 });
    const folder = workFolder();
    // Ten pieces, 40 ms apart: longer in all than the no-progress limit.
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(10 * 64 * 1024, 7));
    await farAgentReply(deps, { body: "Big.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "b1", attachments: ["big.bin"] }, next, folder);
    const started = Date.now();
    expect(await back()).toBe("empty");
    expect(Date.now() - started).toBeGreaterThan(150);
    expect(only(outbox).state).toBe("delivered");
    expect([...door.uploads.values()]).toEqual([{ name: "big.bin", bytes: `${10 * 64 * 1024} bytes` }]);
  });

  test("a file that stops moving: the person's write behind it goes, the line stays up, and after the tries it is a notice", async () => {
    const door = studioDoor({ take: stalls });
    const { deps, outbox, back } = laptop(door, {}, undefined, { fileIdleMs: 60 });
    await farAgentReply(deps, { body: "Stuck.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "st1", attachments: ["notes.md"] }, next, workFolder());
    // The person marks that computer's thread read in this window, behind the agent's answer.
    const person = outbox.submit(STUDIO, "threads/msg_01JZ0000000000000000000000/read", { idempotency_key: "read-1" }, THREAD).entry;
    // Not "unreachable": counted, tried again after a pause, and the link's stream stays up.
    expect(await back()).toBe("server_error");
    expect(outbox.get(person.key)!.state).toBe("delivered");
    expect(door.others).toHaveLength(1);
    const files = outbox.list(STUDIO).find((e) => e.files)!;
    expect([files.state, files.errors]).toEqual(["queued", 1]);
    for (let i = 2; i <= OUTBOX_MAX_SERVER_ERRORS; i++) expect(await back()).toBe("server_error");
    // Each try after a stall under a new key, so none waits behind a stuck upload there.
    expect(new Set(door.keys).size).toBe(OUTBOX_MAX_SERVER_ERRORS);
    // Nothing of it reached that computer: "Not delivered" with why, never "may have been delivered".
    expect(outbox.notices()).toEqual([expect.objectContaining({ key: files.key, state: "refused", notice: expect.objectContaining({ kind: "refused" }), answer: { code: "upload_failed", error: "notes.md could not be sent to Studio." } })]);
    expect(door.replies).toEqual([]);
  });

  test("a refusal there that is not about the files never sends them again", async () => {
    // The line goes down after the files, before the answer; then the thread is gone there.
    const door = studioDoor({ reply: (_body, r) => (r === 0 ? null : Response.json({ code: "message_not_found", error: "No message." }, { status: 404 })) });
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Gone.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "g1", attachments: ["notes.md"] }, next, workFolder());
    expect(await back()).toBe("unreachable");
    expect(await back()).toBe("empty");
    expect(door.uploadTries()).toBe(1);
    expect(outbox.notices()).toEqual([expect.objectContaining({ state: "refused", answer: { code: "message_not_found", error: "No message." } })]);
  });

  test("a file past the size that computer takes is refused before it is copied: nothing in the blobs or pending uploads", async () => {
    const door = studioDoor();
    const { deps, outbox, storeDir } = laptop(door);
    const folder = workFolder();
    // Sparse: its size, none of its bytes.
    writeFileSync(join(folder, "huge.bin"), "");
    truncateSync(join(folder, "huge.bin"), INBOX_UPLOAD_MAX_BYTES + 1);
    await expect(farAgentReply(deps, { body: "Huge.", reply_to: THREAD, agent_session: "ses_one", attachments: ["notes.md", "huge.bin"] }, next, folder)).rejects.toMatchObject({ code: "upload_too_large" });
    expect(existsSync(inboxBlobsDir(storeDir)) ? readdirSync(inboxBlobsDir(storeDir)) : []).toEqual([]);
    expect(listInboxUploads(storeDir)).toEqual([]);
    expect(outbox.list(STUDIO)).toEqual([]);
  });

  test("a file that grows past that size after it was checked is cut off in the copy: refused, nothing kept", async () => {
    const door = studioDoor();
    const folder = workFolder();
    writeFileSync(join(folder, "log.txt"), "small");
    const growing = laptop(door, {
      readFiles: (paths, base) => {
        // Between the size check and the copy, it grows (sparse) past the bound.
        truncateSync(join(folder, "log.txt"), INBOX_UPLOAD_MAX_BYTES + 1);
        return readFarFiles(growing.storeDir, paths, base);
      },
    });
    await expect(farAgentReply(growing.deps, { body: "Log.", reply_to: THREAD, agent_session: "ses_one", attachments: ["notes.md", "log.txt"] }, next, folder)).rejects.toMatchObject({ code: "upload_too_large" });
    expect(existsSync(inboxBlobsDir(growing.storeDir)) ? readdirSync(inboxBlobsDir(growing.storeDir)) : []).toEqual([]);
    expect(listInboxUploads(growing.storeDir)).toEqual([]);
    expect(growing.outbox.list(STUDIO)).toEqual([]);
  });

  test("the line going down mid-file, again and again, counts for nothing: it waits, and goes when that computer is back", async () => {
    // Five tries the connection is reset after the first piece, as Wi-Fi dropping or a closed lid does.
    const door = studioDoor({
      take: async (body, _signal, n) => {
        const reader = body.getReader();
        await reader.read();
        if (n < OUTBOX_MAX_SERVER_ERRORS) throw new Error("connection reset");
        let text = "";
        for (;;) {
          const piece = await reader.read();
          if (piece.done) return `rest: ${text.length}`;
          text += new TextDecoder().decode(piece.value);
        }
      },
    });
    const { deps, outbox, back } = laptop(door);
    await farAgentReply(deps, { body: "Away.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "a1", attachments: ["notes.md"] }, next, workFolder());
    for (let i = 0; i < OUTBOX_MAX_SERVER_ERRORS; i++) expect(await back()).toBe("unreachable");
    expect([only(outbox).state, only(outbox).errors, only(outbox).notice]).toEqual(["queued", 0, null]);
    expect(outbox.notices()).toEqual([]);
    expect(await back()).toBe("empty");
    expect(only(outbox).state).toBe("delivered");
    expect(door.replies).toHaveLength(1);
  });

  test("a stalled upload still stuck at that door never holds up the next try: it goes under a new key", async () => {
    // The first try's request stays open there for ever (half-open), holding its key, as the door's claim does.
    const door = studioDoor({ take: (body, _signal, n) => (n === 0 ? body.getReader().read().then(() => new Promise<string>(() => {})) : new Response(body).text()) });
    const { deps, outbox, back } = laptop(door, {}, undefined, { fileIdleMs: 80 });
    await farAgentReply(deps, { body: "Unstuck.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "u1", attachments: ["notes.md"] }, next, workFolder());
    expect(await back()).toBe("server_error");
    expect(await back()).toBe("empty");
    expect(only(outbox).state).toBe("delivered");
    expect(door.keys[0]).not.toBe(door.keys[1]!);
  });

  test("a slow file never holds up the person's writes, nor other agents' answers; that agent's later answer in the thread waits its turn", async () => {
    const door = studioDoor({ take: slowly(40) });
    const { deps, outbox, lane, send, state } = laptop(door, {}, undefined, { fileIdleMs: 1000 });
    const folder = workFolder();
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(10 * 64 * 1024, 7));
    await farAgentReply(deps, { body: "Big first.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "q1", attachments: ["big.bin"] }, next, folder);
    await farAgentReply(deps, { body: "Then this.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "q2" }, next, folder);
    await farAgentReply(deps, { body: "Another agent.", reply_to: THREAD, agent_session: "ses_two", idempotency_key: "q3" }, next, folder);
    state.online = true;
    // The file is on its way (about 400 ms) when the person presses something.
    const files = lane.run();
    await Bun.sleep(50);
    const person = outbox.submit(STUDIO, "threads/msg_01JZ0000000000000000000000/read", { idempotency_key: "read-2" }, THREAD).entry;
    const started = Date.now();
    expect(await outbox.drain(STUDIO, send)).toBe("empty");
    expect(Date.now() - started).toBeLessThan(200);
    expect(outbox.get(person.key)!.state).toBe("delivered");
    expect(door.uploads.size).toBe(0);
    expect(door.replies.map((reply) => reply.args.body)).toEqual(["Another agent."]);
    expect(await files).toBe("empty");
    expect(await outbox.drain(STUDIO, send)).toBe("empty");
    expect(door.replies.map((reply) => reply.args.body)).toEqual(["Another agent.", "Big first.", "Then this."]);
  });

  test("a held file that cannot be read here fails every try: counted, and after the tries a notice, never retried for ever", async () => {
    const door = studioDoor();
    const { deps, outbox, back, storeDir } = laptop(door);
    await farAgentReply(deps, { body: "Unreadable.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "e1", attachments: ["notes.md"] }, next, workFolder());
    const [upload] = listInboxUploads(storeDir);
    // The held copy cannot be read (as an I/O error does): the stream errors on this side, before a byte goes.
    chmodSync(inboxBlobPath(storeDir, upload!.sha256), 0o000);
    for (let i = 1; i < OUTBOX_MAX_SERVER_ERRORS; i++) {
      expect(await back()).toBe("server_error");
      expect([only(outbox).state, only(outbox).errors]).toEqual(["queued", i]);
    }
    expect(await back()).toBe("server_error");
    expect(await back()).toBe("empty");
    expect(outbox.notices()).toEqual([expect.objectContaining({ state: "refused", notice: expect.objectContaining({ kind: "refused" }), answer: { code: "upload_failed", error: "notes.md could not be sent to Studio." } })]);
    expect(door.uploads.size).toBe(0);
    expect(door.replies).toEqual([]);
  });

  test("a failed file waits out its pause, however often the lane is run; a line failure's pause ends when the link is back", async () => {
    let fail: "server" | "line" | null = "server";
    const door = studioDoor({ upload: () => (fail === "server" ? Response.json({ code: "internal", error: "Busy." }, { status: 500 }) : fail === "line" ? null : undefined) as never });
    const { deps, outbox, lane, state } = laptop(door, {}, undefined, { fileRetryMinMs: 400 });
    await farAgentReply(deps, { body: "Paused.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "p1", attachments: ["notes.md"] }, next, workFolder());
    state.online = true;
    expect(await lane.run()).toBe("server_error");
    expect(door.uploadTries()).toBe(1);
    // Every request the link makes runs the lane: inside the pause, nothing goes.
    for (let i = 0; i < 3; i++) expect(await lane.run()).toBe("empty");
    expect(door.uploadTries()).toBe(1);
    expect(only(outbox).errors).toBe(1);
    expect(lane.nextTryIn()).toBeGreaterThan(0);
    await Bun.sleep(450);
    fail = "line";
    expect(await lane.run()).toBe("unreachable");
    expect(door.uploadTries()).toBe(2);
    expect(await lane.run()).toBe("empty");
    expect(door.uploadTries()).toBe(2);
    // The link's hello: the line is back, so the file goes at once.
    fail = null;
    lane.lineBack();
    expect(await lane.run()).toBe("empty");
    expect(door.uploads.size).toBe(1);
    expect(lane.nextTryIn()).toBeNull();
  });

  test("taken back or unlinked while its file goes: the upload stops at once and the entry's other files never start", async () => {
    for (const end of ["taken back", "unlinked"] as const) {
      const door = studioDoor({ take: slowly(40) });
      const { deps, outbox, lane, state } = laptop(door, {}, undefined, { fileIdleMs: 1000 });
      const folder = workFolder();
      writeFileSync(join(folder, "big.bin"), Buffer.alloc(20 * 64 * 1024, 7));
      await farAgentReply(deps, { body: `Big, ${end}.`, reply_to: THREAD, agent_session: "ses_one", idempotency_key: `tb-${end}`, attachments: ["big.bin", "notes.md"] }, next, folder);
      state.online = true;
      const files = lane.run();
      await Bun.sleep(60);
      const key = only(outbox).key;
      if (end === "taken back") expect(outbox.cancel(key)!.state).toBe("cancelled");
      else outbox.dropMachine(STUDIO, "Studio");
      const started = Date.now();
      await files;
      // About 800 ms of file was left: it stopped at once.
      expect(Date.now() - started).toBeLessThan(200);
      // Nor does that door, reading on, ever take a part of it as the file.
      await Bun.sleep(150);
      expect(door.uploads.size).toBe(0);
      expect(door.keys).toHaveLength(1);
      expect(only(outbox).state).toBe(end === "taken back" ? "cancelled" : "dropped");
    }
  });

  test("online, the agent waits less than a host's tool time limit, then hears it waits; the answer goes once, later", async () => {
    const door = studioDoor({ take: slowly(30) });
    // The agent's wait scaled down a thousand times: 45 ms for the files' 45 s.
    const { deps, outbox, state, drained, waits } = laptop(door, {}, undefined, { waitScale: 1 / 1000 });
    state.online = true;
    const folder = workFolder();
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(8 * 64 * 1024, 1));
    const sent = { body: "Later.", reply_to: THREAD, agent_session: "ses_one", idempotency_key: "l1", attachments: ["big.bin"] };
    const result = await farAgentReply(deps, sent, next, folder);
    expect(result!.text).toBe(`${FAR_REPLY_WORDS.held(THREAD, "Studio")} NEXT`);
    expect(door.replies).toEqual([]);
    await drained();
    expect(door.replies).toHaveLength(1);
    expect(only(outbox).state).toBe("delivered");
    // Codex's MCP tool limit is 60 s by default: the agent's wait with files stays well under it, with time to spare.
    expect(waits[0]!).toBeLessThanOrEqual(60_000 - 15_000);
    const again = await farAgentReply(deps, sent, next, folder);
    expect(again!.text).toStartWith("Wrote: Later.");
    expect(door.replies).toHaveLength(1);
    expect(door.uploads.size).toBe(1);
  });
});

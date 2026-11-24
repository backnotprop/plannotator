/**
 * Plannotator Inbox: `GET /api/inbox/messages/<id>/image?path=<src>`, the
 * images a message shows (#1813). Mounted in the Inbox server's
 * route table (packages/server/inbox.ts), behind its Host allowlist; it sets
 * no CORS headers.
 *
 * Every decision is in packages/shared/inbox/message-images.ts: the path
 * must be an image the message's own body references; for an agent's message
 * anywhere the person's user can read, for a person's own message inside its
 * project or the folder it was sent from; never, outside those, a hidden
 * folder of the home folder or of `/` (`~/.ssh`), nor a dotenv file anywhere
 * (judged as named and by realpath); an image by extension and by its magic bytes, at
 * most 10 MB and 50 megapixels. This file adds the
 * transport: a cross-site request is refused before anything is read, and
 * every answer carries nosniff, a sandbox CSP and a same-origin CORP, so
 * another site can neither embed nor read an image, and an SVG opened
 * directly never runs. A 200 carries an ETag (the SHA-256 of the bytes
 * served) and `Cache-Control: private, no-cache`; If-None-Match with that tag
 * answers 304 with the same headers. The phone door forwards here as is.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { isInboxId, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { inboxBlobPath, inboxBlobsDir } from "@plannotator/shared/inbox/attachments";
import { INBOX_MESSAGE_IMAGE_CSP, inboxMessageShownFileRefsInOrder, readInboxMessageImageAsync, readInboxPictureAsync, type InboxMessageImageResult } from "@plannotator/shared/inbox/message-images";
import { captureInboxInlineImages, yieldToLoop } from "@plannotator/shared/inbox/inline-images";
import { openInboxMessageMedia } from "@plannotator/shared/inbox/message-media";
import { inboxInlineMediaKind } from "@plannotator/core/inbox-inline-media";
import { byteRangeResponse, decideByteRange } from "./inbox-byte-range";
import { inboxImageScales, inboxImageWidth, scaledEtag, scaleInboxImage } from "./inbox-image-scale";
import { syncSection } from "./inbox-perf";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_MESSAGE_IMAGE_ROUTE = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/image$/;

const GUARD_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": INBOX_MESSAGE_IMAGE_CSP,
  "Cross-Origin-Resource-Policy": "same-origin",
};

function refuse(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { ...GUARD_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Answers the image route, or null when the path is not it. `shown`: an image it served (the capture's wait on it
 * ends, `InboxImageCapture.shown`).
 */
export async function inboxMessageImageRoute(req: Request, url: URL, store: InboxStore, shown?: (messageId: string, ref: string) => void): Promise<Response | null> {
  const match = INBOX_MESSAGE_IMAGE_ROUTE.exec(url.pathname);
  if (!match) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method_not_allowed", "Use GET.");
  // The window's own <img> is same-origin; a typed URL is "none". A page on
  // another site (or another localhost port) never gets an answer.
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return refuse(403, "cross_origin", "Cross-origin requests are not accepted.");
  const id = match[1]!;
  const message = isInboxId("msg", id) ? store.message(id) : null;
  if (!message) return refuse(404, "message_not_found", `No message ${id}.`);
  const project = store.project(message.project_id);
  if (!project) return refuse(404, "project_not_found", "The message's project is gone.");

  // A picture sent as bytes (a cloud agent's, inbox-cloud-pictures.ts) is in no folder on disk: it is shown from the
  // Inbox's own copy, captured at send, before any file of that name. Every other picture is read live, as below.
  const src = url.searchParams.get("path");
  const fromBytes = src ? message.inline_images?.find((image) => image.ref === src && inboxPictureFromUpload(store.dir, image)) : undefined;
  if (fromBytes) return inboxImageResponse(req, await capturedPicture(store.dir, fromBytes), inboxImageWidth(url));

  const input = {
    body: message.body,
    root: project.root,
    base: message.base_path ?? null,
    path: url.searchParams.get("path"),
    // An agent's images come from anywhere; a person's own message (a phone, the relay, a tailnet login) from its project.
    anywhere: message.author.kind === "agent",
  };
  if (input.path && inboxInlineMediaKind(input.path)) {
    const media = await openInboxMessageMedia(input);
    if (!media.ok) return refuse(media.status, media.code, media.error);
    // On disk now: it becomes a file of the thread (an artifact) as a shown picture does.
    shown?.(message.id, input.path);
    const decision = decideByteRange(req.headers.get("range"), media.size, { ifRange: req.headers.get("if-range"), etag: media.etag });
    return byteRangeResponse(media.handle, media.size, decision, {
      ...GUARD_HEADERS,
      "Content-Type": media.contentType,
      "Content-Disposition": contentDisposition("inline", basename(media.named)),
      "Cache-Control": "private, no-cache",
      ETag: media.etag,
    }, { head: req.method === "HEAD" });
  }
  const result = await readInboxMessageImageAsync(input);
  if (result.ok && input.path) shown?.(message.id, input.path);
  return inboxImageResponse(req, result, inboxImageWidth(url));
}

/**
 * Whether a message's picture was captured at send from bytes sent with it (an upload): its recorded realpath is the
 * Inbox's own blob of those bytes, not a file of the agent's.
 */
export function inboxPictureFromUpload(inboxDirPath: string, image: InboxInlineImage): boolean {
  if (image.captured !== undefined || typeof image.path !== "string") return false;
  if (image.path === inboxBlobPath(inboxDirPath, image.sent_sha256)) return true;
  try {
    return image.path === join(realpathSync(inboxBlobsDir(inboxDirPath)), image.sent_sha256);
  } catch {
    return false;
  }
}

/** A picture the capture at send took from bytes sent with the message, read from its blob. */
async function capturedPicture(inboxDirPath: string, image: InboxInlineImage): Promise<InboxMessageImageResult> {
  const read = await readInboxPictureAsync(inboxBlobPath(inboxDirPath, image.sent_sha256), () => false);
  return read.ok ? { ...read, named: image.name } : read;
}

/** `filename` (an ASCII fallback) and `filename*` (the real name, percent-encoded) for Content-Disposition. */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Safe image bytes and cache validators shared by message bodies and Markdown attachments. `to`: the width the
 * window draws it at (`?w=`), served as a smaller copy when the picture is wider (inbox-image-scale.ts).
 */
export async function inboxImageResponse(req: Request, result: InboxMessageImageResult, to: number | null = null): Promise<Response> {
  if (!result.ok) return refuse(result.status, result.code, result.error);
  // The validator is the SHA-256 of the bytes served (read once, at most the
  // cap), so it changes whenever the file does. `no-cache`: the file lives on
  // disk and can change, so a client (the window, a phone caching by message
  // id + path) revalidates with If-None-Match and gets a 304 when unchanged.
  const etag = `"${createHash("sha256").update(result.bytes).digest("hex")}"`;
  const headers: Record<string, string> = {
    ...GUARD_HEADERS,
    "Content-Type": result.contentType,
    "Cache-Control": "private, no-cache",
    // Shown in place, under the name the body gave it: a browser's Save Image As saves "empty-cart.png", not "image.png".
    "Content-Disposition": contentDisposition("inline", basename(result.named)),
    ETag: etag,
    // As code review's image route: the header's size, when it parses.
    ...(result.width !== undefined && result.height !== undefined
      ? { "X-Image-Width": String(result.width), "X-Image-Height": String(result.height) }
      : {}),
  };
  if (inboxImageScales(result.contentType, result.width, to, result.bytes.byteLength)) {
    const scaledTag = scaledEtag(etag, to);
    const scaledHeaders = { ...headers, ETag: scaledTag };
    if (ifNoneMatchHits(req.headers.get("if-none-match"), scaledTag)) return new Response(null, { status: 304, headers: scaledHeaders });
    const scaled = await scaleInboxImage(new Uint8Array(result.bytes), result.contentType, to, etag);
    if (scaled) {
      const sized = { ...scaledHeaders, "Content-Type": scaled.contentType, "X-Image-Width": String(scaled.width), "X-Image-Height": String(scaled.height) };
      return new Response(req.method === "HEAD" ? null : scaled.bytes, { headers: { ...sized, "Content-Length": String(scaled.bytes.byteLength) } });
    }
  }
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : new Uint8Array(result.bytes), {
    headers: { ...headers, "Content-Length": String(result.bytes.byteLength) },
  });
}

/** RFC 9110 If-None-Match: `*`, or any listed tag equal to `etag` by weak comparison. */
function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || strip(tag) === etag);
}


/** How many bytes one background pass reads before it pauses (and lets everything else run). */
export const INBOX_IMAGE_CAPTURE_PASS_BYTES = 32 * 1024 * 1024;
/** The pause between passes. */
export const INBOX_IMAGE_CAPTURE_PAUSE_MS = 25;
/** A source a read could not capture is tried again after this long (a transient `image_changed`, a file written later). */
export const INBOX_IMAGE_CAPTURE_RETRY_MS = 60_000;
/**
 * A source refused before any read (not on disk yet, hidden, outside its project) is tried again after these waits,
 * one more each time it is refused again, the last repeating: a thread opened again and again reads nothing for it
 * meanwhile (#2788: an agent may name a path anywhere, a sleeping disk or an automount included). The window still
 * shows such an image through the image route, and a route answer that serves it ends the wait at once (`shown`).
 */
export const INBOX_IMAGE_CAPTURE_MISS_WAITS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];
/** The most sources one message's background capture takes per pass. */
const MESSAGE_BATCH = 64;
/** Messages the retry table remembers (least recently tried dropped first). */
const ATTEMPTS_MAX_MESSAGES = 10_000;
/** Refusals that cost a read of the file (or will fail the same way at once): not tried again until the retry window passes. */
const COSTLY_REFUSALS = new Set(["not_an_image", "not_media", "image_changed", "image_too_large", "image_unreadable", "image_read_failed"]);

/** A source the capture could not take (`createInboxImageCapture`'s retry table). */
interface Attempt {
  due: number;
  misses: number;
  shownAt?: number;
}

export interface InboxImageCapture {
  /** Capture the thread's uncaptured images in the background (a read never waits for it). */
  schedule: (threadId: string) => void;
  /** The image route served `ref` of message `messageId`: a wait on it ends, and its thread's capture runs again. */
  shown: (messageId: string, ref: string) => void;
  /** Resolves once nothing is queued or running (tests). */
  idle: () => Promise<void>;
  /** The server stopped: nothing more is read or written; a capture in flight discards its copies (a film's copy ends at its next chunk). */
  stop: () => void;
}

/**
 * The images a thread's messages show that have no captured record yet
 * (approval "inbox-image-viewer"; `store.imageCaptureGaps`): copied after a
 * read of the thread asked for them, off the request path. The read answers
 * at once; each message's new records arrive as one more line for it (the
 * event stream carries it, and the window reads the thread again). One thread
 * at a time, every read and write asynchronous (inline-images.ts), a yield
 * between images and messages, and a pause after each
 * INBOX_IMAGE_CAPTURE_PASS_BYTES read, so health, streams, the bridge and the
 * MCP keep answering. The copies are staged as temp files and moved into
 * `blobs/` only right after the records that use them are written, so a
 * deletion's blob sweep (which keeps only blobs a record names) can never
 * remove a copy no record names yet. A source refused after a read (not an
 * image, changed while read, too many pixels) is tried again only after
 * INBOX_IMAGE_CAPTURE_RETRY_MS; a copy that could not be written (a full
 * disk) after the longest miss wait; one refused before any read (not on disk yet,
 * hidden) after INBOX_IMAGE_CAPTURE_MISS_WAITS_MS, or as soon as the image
 * route serves it or its thread changes (a new message: the window keeps a
 * picture that failed as it is and never asks the route again). A thread
 * whose every gap waits is settled until the first wait ends. Records are marked `captured: "on_open"`. After `stop`, nothing
 * is written.
 */
export function createInboxImageCapture(
  store: InboxStore,
  options: {
    passBytes?: number;
    pauseMs?: number;
    retryMs?: number;
    missWaitsMs?: readonly number[];
    /** A copy that could not be written (`write_failed`) is tried again after this long (default the longest miss wait). */
    writeFailedMs?: number;
    /** Messages the retry table remembers (tests). */
    maxMessages?: number;
    now?: () => number;
    /** The capture itself (tests count it). */
    capture?: typeof captureInboxInlineImages;
  } = {},
): InboxImageCapture {
  const passBytes = options.passBytes ?? INBOX_IMAGE_CAPTURE_PASS_BYTES;
  const pauseMs = options.pauseMs ?? INBOX_IMAGE_CAPTURE_PAUSE_MS;
  const retryMs = options.retryMs ?? INBOX_IMAGE_CAPTURE_RETRY_MS;
  const missWaits = options.missWaitsMs ?? INBOX_IMAGE_CAPTURE_MISS_WAITS_MS;
  const writeFailedMs = options.writeFailedMs ?? Math.max(retryMs, ...missWaits);
  const maxMessages = Math.max(1, options.maxMessages ?? ATTEMPTS_MAX_MESSAGES);
  const clock = options.now ?? Date.now;
  const capture = options.capture ?? captureInboxInlineImages;
  const queue = new Set<string>();
  /**
   * Threads with nothing to capture now, at the thread's version then (`store.threadVersion`), until `until` (a
   * remembered refusal's wait ends; Infinity when nothing was left): a read of one that has not changed since starts
   * no pass.
   */
  const settled = new Map<string, { version: string; until: number }>();
  /**
   * Per message (least recently tried first), each refused source: when it may be tried again, how many times in a
   * row it was refused before any read (`misses`, which picks its next wait), and when the image route last served
   * it (`shownAt`: a capture that began before then and found nothing waits for nothing).
   */
  const attempts = new Map<string, Map<string, Attempt>>();
  /**
   * Per thread, its version (`store.threadVersion`) when its misses were last tried, counting that pass's own lines:
   * a thread changed since (a new message, often the one whose agent just wrote the file) tries them again at once.
   */
  const triedAt = new Map<string, string>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const remember = (messageId: string, ref: string, attempt: Attempt) => {
    const refs = attempts.get(messageId) ?? new Map<string, Attempt>();
    attempts.delete(messageId);
    refs.set(ref, attempt);
    attempts.set(messageId, refs);
    while (attempts.size > maxMessages) attempts.delete(attempts.keys().next().value!);
  };
  /** A capture that began at `began` could not take `ref`. */
  const tried = (messageId: string, ref: string, code: string, began: number) => {
    const before = attempts.get(messageId)?.get(ref);
    // A full disk is not filled again every minute while the thread is open, nor at once when it changes.
    if (code === "write_failed") return remember(messageId, ref, { due: clock() + writeFailedMs, misses: 0 });
    if (COSTLY_REFUSALS.has(code)) return remember(messageId, ref, { due: clock() + retryMs, misses: 0 });
    // Served by the route while this capture ran: it is on disk now, and the thread's capture runs again.
    if (before?.shownAt !== undefined && before.shownAt >= began) return remember(messageId, ref, { due: -Infinity, misses: 0 });
    const misses = (before?.misses ?? 0) + 1;
    remember(messageId, ref, { due: clock() + (missWaits[Math.min(misses, missWaits.length) - 1] ?? 0), misses });
  };
  /** When `ref` may be read again; a miss (not on disk yet) at once when its thread `changed` since it was tried. */
  const dueAt = (messageId: string, ref: string, changed: boolean) => {
    const attempt = attempts.get(messageId)?.get(ref);
    if (!attempt) return -Infinity;
    return changed && attempt.misses > 0 ? -Infinity : attempt.due;
  };
  const settle = (threadId: string, version: string, until: number) => {
    settled.delete(threadId);
    settled.set(threadId, { version, until });
    while (settled.size > maxMessages) settled.delete(settled.keys().next().value!);
  };

  const captureThread = async (threadId: string, budget: { bytes: number }) => {
    const version = store.threadVersion(threadId);
    const gaps = syncSection("image-capture:gaps", () => store.imageCaptureGaps(threadId, inboxMessageShownFileRefsInOrder));
    const start = clock();
    const last = triedAt.get(threadId);
    const changed = last !== undefined && last !== version;
    // Every gap waiting (or none): nothing is read until the first wait ends, or the thread changes.
    let firstDue = Infinity;
    for (const { message, refs } of gaps) for (const ref of refs) firstDue = Math.min(firstDue, dueAt(message.id, ref, changed));
    if (gaps.length === 0 || firstDue > start) {
      settle(threadId, version, gaps.length === 0 ? Infinity : firstDue);
      return;
    }
    // The version this pass tries the misses against: its own lines move it on; any other line during it does not.
    let ours = version;
    let raced = false;
    for (const { message, refs } of gaps) {
      if (stopped) return;
      const now = clock();
      const due = refs.filter((ref) => dueAt(message.id, ref, changed) <= now).slice(0, MESSAGE_BATCH);
      if (due.length === 0) continue;
      // The pictures in one go, then each sound or video on its own: a film's copy is written and committed, and the
      // pass's budget checked, before the next film is read.
      const pictures = due.filter((ref) => !inboxInlineMediaKind(ref));
      const groups = [...(pictures.length > 0 ? [pictures] : []), ...due.filter((ref) => inboxInlineMediaKind(ref)).map((ref) => [ref])];
      for (const group of groups) {
        if (stopped) return;
        const began = clock();
        await yieldToLoop();
        try {
          const project = store.project(message.project_id);
          if (!project) break;
          const latest = store.message(message.id);
          if (!latest || stopped) break;
          const captured = await capture(store.dir, {
            body: latest.body,
            root: project.root,
            base: latest.base_path ?? null,
            anywhere: latest.author.kind === "agent",
            sentAt: latest.created_at,
            capturedOnOpenAt: new Date().toISOString(),
            refs: group,
            max: MESSAGE_BATCH,
            stage: true,
            attached: latest.attachments,
            stopped: () => stopped,
          });
          // A refusal decided before any read (missing, hidden, outside its project) waits
          // INBOX_IMAGE_CAPTURE_MISS_WAITS_MS; one that cost a read (not an image, changed while read) INBOX_IMAGE_CAPTURE_RETRY_MS;
          // a copy that could not be written (a full disk) the longest miss wait.
          for (const failure of captured.failures) tried(message.id, failure.ref, failure.code, began);
          // Still there (a deletion may have run meanwhile) and the server still running: the records go on
          // it, in text order, and only then do the copies move into blobs/ (no await in between).
          if (stopped || !store.message(message.id)) {
            await captured.discard();
            break;
          }
          if (store.threadVersion(threadId) !== ours) raced = true;
          syncSection("image-capture:write", () => store.addCapturedImages(message.id, captured.images, inboxMessageShownFileRefsInOrder(latest.body)));
          ours = store.threadVersion(threadId);
          await captured.commit();
          budget.bytes += captured.bytes;
          if (budget.bytes >= passBytes) {
            budget.bytes = 0;
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
        } catch {
          // Left for a later read.
        }
      }
    }
    // A line not this pass's (a message that came meanwhile): the next read tries the misses again.
    if (store.threadVersion(threadId) !== ours) raced = true;
    triedAt.delete(threadId);
    triedAt.set(threadId, raced ? version : ours);
    while (triedAt.size > maxMessages) triedAt.delete(triedAt.keys().next().value!);
  };

  const run = async () => {
    const budget = { bytes: 0 };
    while (queue.size > 0 && !stopped) {
      const threadId = queue.values().next().value!;
      queue.delete(threadId);
      if (store.thread(threadId)) await captureThread(threadId, budget);
    }
  };

  const schedule = (threadId: string) => {
    if (stopped) return;
    const rest = settled.get(threadId);
    if (rest && rest.version === store.threadVersion(threadId) && clock() < rest.until) return;
    queue.add(threadId);
    if (running) return;
    running = (async () => {
      try {
        await yieldToLoop();
        await run();
      } finally {
        running = null;
      }
    })();
  };

  return {
    schedule,
    shown(messageId, ref) {
      if (stopped) return;
      const message = store.message(messageId);
      if (!message || (message.inline_images ?? []).some((image) => image.ref === ref)) return;
      const kept = attempts.get(messageId)?.get(ref);
      // One whose read failed (not an image, changed while read) waits its retry.
      if (kept && kept.misses === 0 && kept.due > clock()) return;
      remember(messageId, ref, { due: -Infinity, misses: 0, shownAt: clock() });
      settled.delete(message.thread_id);
      schedule(message.thread_id);
    },
    async idle() {
      while (running) await running;
    },
    stop() {
      stopped = true;
      queue.clear();
    },
  };
}

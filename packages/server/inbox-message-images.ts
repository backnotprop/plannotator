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
import { isInboxId } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_IMAGE_CSP, inboxMessageImageRefsInOrder, readInboxMessageImageAsync, type InboxMessageImageResult } from "@plannotator/shared/inbox/message-images";
import { captureInboxInlineImages, yieldToLoop } from "@plannotator/shared/inbox/inline-images";
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

/** Answers the image route, or null when the path is not it. */
export async function inboxMessageImageRoute(req: Request, url: URL, store: InboxStore): Promise<Response | null> {
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

  const result = await readInboxMessageImageAsync({
    body: message.body,
    root: project.root,
    base: message.base_path ?? null,
    path: url.searchParams.get("path"),
    // An agent's images come from anywhere; a person's own message (a phone, the relay, a tailnet login) from its project.
    anywhere: message.author.kind === "agent",
  });
  return inboxImageResponse(req, result);
}

/** Safe image bytes and cache validators shared by message bodies and Markdown attachments. */
export function inboxImageResponse(req: Request, result: InboxMessageImageResult): Response {
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
    ETag: etag,
    // As code review's image route: the header's size, when it parses.
    ...(result.width !== undefined && result.height !== undefined
      ? { "X-Image-Width": String(result.width), "X-Image-Height": String(result.height) }
      : {}),
  };
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
/** The most sources one message's background capture takes per pass. */
const MESSAGE_BATCH = 64;
/** Messages the retry table remembers (least recently tried dropped first). */
const ATTEMPTS_MAX_MESSAGES = 10_000;
/** Refusals that cost a read of the file (or will fail the same way at once): not tried again until the retry window passes. */
const COSTLY_REFUSALS = new Set(["not_an_image", "image_changed", "image_too_large", "write_failed", "image_unreadable", "image_read_failed"]);

export interface InboxImageCapture {
  /** Capture the thread's uncaptured images in the background (a read never waits for it). */
  schedule: (threadId: string) => void;
  /** Resolves once nothing is queued or running (tests). */
  idle: () => Promise<void>;
  /** The server stopped: nothing more is read or written; a capture in flight discards its copies. */
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
 * INBOX_IMAGE_CAPTURE_RETRY_MS; one refused before any read (not on disk yet)
 * on the next read. Records are marked `captured: "on_open"`. After `stop`,
 * nothing is written.
 */
export function createInboxImageCapture(
  store: InboxStore,
  options: { passBytes?: number; pauseMs?: number; retryMs?: number } = {},
): InboxImageCapture {
  const passBytes = options.passBytes ?? INBOX_IMAGE_CAPTURE_PASS_BYTES;
  const pauseMs = options.pauseMs ?? INBOX_IMAGE_CAPTURE_PAUSE_MS;
  const retryMs = options.retryMs ?? INBOX_IMAGE_CAPTURE_RETRY_MS;
  const queue = new Set<string>();
  /** Per message (least recently tried first), when each costly refusal was last tried. */
  const attempts = new Map<string, Map<string, number>>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const tried = (messageId: string, ref: string) => {
    const refs = attempts.get(messageId) ?? new Map<string, number>();
    attempts.delete(messageId);
    refs.set(ref, Date.now());
    attempts.set(messageId, refs);
    while (attempts.size > ATTEMPTS_MAX_MESSAGES) attempts.delete(attempts.keys().next().value!);
  };
  const lastTried = (messageId: string, ref: string) => attempts.get(messageId)?.get(ref) ?? -Infinity;

  const captureThread = async (threadId: string, budget: { bytes: number }) => {
    for (const { message, refs } of store.imageCaptureGaps(threadId, inboxMessageImageRefsInOrder)) {
      if (stopped) return;
      const now = Date.now();
      const due = refs.filter((ref) => now - lastTried(message.id, ref) >= retryMs).slice(0, MESSAGE_BATCH);
      if (due.length === 0) continue;
      await yieldToLoop();
      try {
        const project = store.project(message.project_id);
        if (!project) continue;
        const latest = store.message(message.id);
        if (!latest || stopped) continue;
        const captured = await captureInboxInlineImages(store.dir, {
          body: latest.body,
          root: project.root,
          base: latest.base_path ?? null,
          anywhere: latest.author.kind === "agent",
          sentAt: latest.created_at,
          capturedOnOpenAt: new Date().toISOString(),
          refs: due,
          max: MESSAGE_BATCH,
          stage: true,
        });
        // A refusal decided before any read (missing, hidden, too large by its size) is tried again on
        // the next read; one that cost a read (not an image, changed while read) waits INBOX_IMAGE_CAPTURE_RETRY_MS.
        for (const failure of captured.failures) if (COSTLY_REFUSALS.has(failure.code)) tried(message.id, failure.ref);
        // Still there (a deletion may have run meanwhile) and the server still running: the records go on
        // it, in text order, and only then do the copies move into blobs/ (no await in between).
        if (stopped || !store.message(message.id)) {
          await captured.discard();
          continue;
        }
        store.addCapturedImages(message.id, captured.images, inboxMessageImageRefsInOrder(latest.body));
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
  };

  const run = async () => {
    const budget = { bytes: 0 };
    while (queue.size > 0 && !stopped) {
      const threadId = queue.values().next().value!;
      queue.delete(threadId);
      if (store.thread(threadId)) await captureThread(threadId, budget);
    }
  };

  return {
    schedule(threadId) {
      if (stopped) return;
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

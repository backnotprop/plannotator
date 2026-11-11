import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_IMAGE_CSP, inboxMessageImageRefsInOrder, readInboxMessageImageAsync, type InboxMessageImageResult } from "@plannotator/shared/inbox/message-images";
import { captureInboxInlineImages, yieldToLoop } from "@plannotator/shared/inbox/inline-images";
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

export async function inboxMessageImageRoute(req: Request, url: URL, store: InboxStore): Promise<Response | null> {
  const match = INBOX_MESSAGE_IMAGE_ROUTE.exec(url.pathname);
  if (!match) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method_not_allowed", "Use GET.");
  // Same-origin only: a page on another site or another localhost port never gets an answer.
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
    anywhere: message.author.kind === "agent",
  });
  return inboxImageResponse(req, result, inboxImageWidth(url));
}

export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function inboxImageResponse(req: Request, result: InboxMessageImageResult, to: number | null = null): Promise<Response> {
  if (!result.ok) return refuse(result.status, result.code, result.error);
  // The ETag is the SHA-256 of the bytes served; `no-cache` because the file can change on disk, so clients revalidate with If-None-Match.
  const etag = `"${createHash("sha256").update(result.bytes).digest("hex")}"`;
  const headers: Record<string, string> = {
    ...GUARD_HEADERS,
    "Content-Type": result.contentType,
    "Cache-Control": "private, no-cache",
    "Content-Disposition": contentDisposition("inline", basename(result.named)),
    ETag: etag,
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

function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || strip(tag) === etag);
}


export const INBOX_IMAGE_CAPTURE_PASS_BYTES = 32 * 1024 * 1024;
export const INBOX_IMAGE_CAPTURE_PAUSE_MS = 25;
export const INBOX_IMAGE_CAPTURE_RETRY_MS = 60_000;
const MESSAGE_BATCH = 64;
const ATTEMPTS_MAX_MESSAGES = 10_000;
const COSTLY_REFUSALS = new Set(["not_an_image", "image_changed", "image_too_large", "write_failed", "image_unreadable", "image_read_failed"]);

export interface InboxImageCapture {
  schedule: (threadId: string) => void;
  idle: () => Promise<void>;
  stop: () => void;
}

/** Captured copies are staged as temp files and moved into `blobs/` only right after the records naming them are written, so a deletion's blob sweep never removes a copy no record names yet. */
export function createInboxImageCapture(
  store: InboxStore,
  options: { passBytes?: number; pauseMs?: number; retryMs?: number } = {},
): InboxImageCapture {
  const passBytes = options.passBytes ?? INBOX_IMAGE_CAPTURE_PASS_BYTES;
  const pauseMs = options.pauseMs ?? INBOX_IMAGE_CAPTURE_PAUSE_MS;
  const retryMs = options.retryMs ?? INBOX_IMAGE_CAPTURE_RETRY_MS;
  const queue = new Set<string>();
  const settled = new Map<string, string>();
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
    const version = store.threadVersion(threadId);
    const gaps = syncSection("image-capture:gaps", () => store.imageCaptureGaps(threadId, inboxMessageImageRefsInOrder));
    if (gaps.length === 0) {
      settled.delete(threadId);
      settled.set(threadId, version);
      while (settled.size > ATTEMPTS_MAX_MESSAGES) settled.delete(settled.keys().next().value!);
      return;
    }
    for (const { message, refs } of gaps) {
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
        for (const failure of captured.failures) if (COSTLY_REFUSALS.has(failure.code)) tried(message.id, failure.ref);
        if (stopped || !store.message(message.id)) {
          await captured.discard();
          continue;
        }
        syncSection("image-capture:write", () => store.addCapturedImages(message.id, captured.images, inboxMessageImageRefsInOrder(latest.body)));
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
      if (settled.get(threadId) === store.threadVersion(threadId)) return;
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

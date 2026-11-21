/**
 * HTTP Range for the Inbox's byte routes (an attachment's `video` and
 * `download`), decided here and served from a descriptor the route already
 * opened and checked. `new Response(Bun.file(path))` would answer Range by
 * itself, but it opens the file again by its path, which loses the
 * `O_NOFOLLOW` + dev/ino check every read takes (packages/shared/inbox/
 * attachments.ts), so the 206 is built by hand.
 *
 * The rules (RFC 9110 section 14, as the contract in
 * adr/implementation/inbox-mobile.md states them):
 * - one range, `bytes=a-b`, `bytes=a-` or `bytes=-n`: `206` with
 *   `Content-Range: bytes a-b/size` (an end past the file is the last byte),
 *   at most `BYTE_RANGE_MAX_ANSWER` (8 MiB) of it: an open-ended or longer
 *   range gets its first 8 MiB, and the client asks again from there;
 * - none, or a header that is not a byte range we read: the full `200`;
 * - several ranges: the full `200` (no multipart);
 * - a range that starts past the end (or `-0`, or any range of an empty
 *   file): `416` whose `Content-Range` names only the size (`bytes *` then `/size`);
 * - `If-Range` that is not exactly this version's (strong) ETag, by strong
 *   comparison, so a weak tag never matches (or a date): the
 *   full `200`, so a player that resumes a file the agent re-rendered starts
 *   over instead of splicing two films.
 */

import type { FileHandle } from "node:fs/promises";

export type ByteRangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** What one `Range` header asks of a file of `size` bytes, with `If-Range` judged against `etag`. */
/**
 * The most one `206` carries. Bun 1.3.14 pulls a streamed body as fast as
 * the file reads, whatever the client's socket takes (every stream form it
 * offers does: measured, a client at 400 KB/s on `bytes=0-` of a 200 MB film
 * had all 200 MB read into memory in 0.1 s). Bun 1.4.4 waits for the client
 * (the same client: 4 MiB read in 3 s); the cap still bounds one answer on
 * any runtime. So an open-ended range, or one longer than this, is answered
 * with its first 8 MiB and the matching `Content-Range`; RFC 9110 lets a server send less than was asked for, and a
 * player asks again from where the answer ended (Chromium, AVPlayer and
 * ExoPlayer do). A full `200` (a download with no Range) is not capped.
 */
export const BYTE_RANGE_MAX_ANSWER = 8 * 1024 * 1024;

export function decideByteRange(
  range: string | null,
  size: number,
  options: { ifRange?: string | null; etag?: string; maxLength?: number } = {},
): ByteRangeDecision {
  const decided = decideRequestedRange(range, size, options);
  const max = options.maxLength ?? BYTE_RANGE_MAX_ANSWER;
  if (decided.kind === "partial" && decided.end - decided.start + 1 > max) return { kind: "partial", start: decided.start, end: decided.start + max - 1 };
  return decided;
}

/** The range as asked for, before the answer cap. */
function decideRequestedRange(range: string | null, size: number, options: { ifRange?: string | null; etag?: string }): ByteRangeDecision {
  if (range === null) return { kind: "full" };
  if (options.ifRange != null && options.ifRange.trim() !== options.etag) return { kind: "full" };
  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(range);
  if (!match) return { kind: "full" };
  const specs = match[1]!.split(",").map((spec) => spec.trim()).filter(Boolean);
  if (specs.length !== 1) return { kind: "full" };
  const spec = /^(\d*)\s*-\s*(\d*)$/.exec(specs[0]!);
  if (!spec || (spec[1] === "" && spec[2] === "")) return { kind: "full" };
  if (spec[1] === "") {
    // The last n bytes.
    const n = Number(spec[2]);
    if (!Number.isSafeInteger(n)) return { kind: "full" };
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(spec[1]);
  const last = spec[2] === "" ? null : Number(spec[2]);
  if (!Number.isSafeInteger(start) || (last !== null && !Number.isSafeInteger(last))) return { kind: "full" };
  // An end before the start makes the header invalid: it is ignored.
  if (last !== null && last < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

/**
 * A streamed body not pulled for this long has lost its reader: its file
 * handle is closed and the stream ends with an error (a player that only
 * paused asks again with a Range). Five minutes, not less: Bun 1.4 pulls only
 * as fast as the client reads, so a player paused with a full buffer, or a
 * slow download, leaves a live answer unpulled; at 30 s Bun 1.4.4 cut such an
 * answer short (measured: a 200 KB/s client lost its 8 MiB answer at 14 s
 * with a 2 s watchdog). Bun 1.4.4 cancels a gone client itself, so this is a
 * backstop for a runtime that does not.
 */
export const STREAM_IDLE_CLOSE_MS = 5 * 60_000;

/**
 * Bytes `start..end` (inclusive; to the end of the file when `end` is
 * omitted) of a file handle, read in 1 MiB chunks. The handle is closed at
 * the end, on an error, when the reader cancels, and by an idle watchdog.
 *
 * Two Bun 1.3.14 facts shape this (measured against the Inbox, with `lsof`;
 * Bun 1.4.4 fixed both, and the guards stay for any runtime that has them):
 * - A client that aborts mid-answer does get `cancel` called, but Bun pulls
 *   ahead, so a read is in flight then, and `FileHandle.close()` called while
 *   a read is in flight never closes the descriptor: it stays open for good.
 *   So a close asked for during a read is done when that read returns. (On
 *   1.4.4 a close during a read closes it, and `cancel` rarely meets a read.)
 * - A client that is gone before the answer starts (it closed the socket
 *   while the handler was still opening the file) gets a stream Bun neither
 *   reads to the end nor cancels. Only a watchdog can close that handle: a
 *   body not pulled for `STREAM_IDLE_CLOSE_MS` closes itself. The same covers
 *   any runtime that never calls `cancel`. (Bun 1.4.4 cancels these.)
 * No Bun mechanism does this for us: `server.timeout(req, s)` and
 * `idleTimeout` end a socket, never the stream's own resources, and the
 * Inbox's handler is async (opening and checking the file), so the answer
 * cannot be made synchronously.
 */
export function handleRangeStream(handle: FileHandle, start: number, end = Number.POSITIVE_INFINITY, options: { idleMs?: number } = {}): ReadableStream<Uint8Array> {
  const idleMs = options.idleMs ?? STREAM_IDLE_CLOSE_MS;
  let position = start;
  let reading = false;
  let closing = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** Close the descriptor now (never while a read is in flight: that close would be lost). */
  const finish = () => {
    if (closed) return;
    closed = true;
    stopTimer();
    void handle.close().catch(() => {});
  };
  /** Ask to close: now, or when the read in flight returns. */
  const close = () => {
    closing = true;
    stopTimer();
    if (!reading) finish();
  };
  const arm = () => {
    stopTimer();
    timer = setTimeout(close, idleMs);
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closing) {
        finish();
        controller.error(new Error("The file was closed: this answer went unread too long."));
        return;
      }
      stopTimer();
      const left = end + 1 - position;
      if (left <= 0) {
        close();
        controller.close();
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, left));
      let bytesRead: number;
      reading = true;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
      } catch (error) {
        reading = false;
        close();
        controller.error(error);
        return;
      } finally {
        reading = false;
      }
      if (closing) {
        // Cancelled (or idle) while this read ran: close now that it returned.
        finish();
        return;
      }
      if (bytesRead === 0) {
        // The file shrank under the stream: end it short rather than hang.
        close();
        controller.close();
        return;
      }
      position += bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
      arm();
    },
    cancel() {
      close();
    },
  });
}

/**
 * An answer up to this long is read whole and sent with its `Content-Length`
 * (a player's probe, `bytes=0-1`, and most of its seeks). Bun sends a longer,
 * streamed body chunked and drops the header (checked on Bun 1.3.14 and
 * 1.4.4: a ReadableStream body over a few hundred bytes loses an explicit
 * Content-Length, even one that is complete at once), so the size of a long answer is in its `Content-Range`
 * (206), and in the attachment's record (200).
 */
export const BYTE_RANGE_WHOLE_MAX = 1024 * 1024;

/** Exactly `length` bytes at `start` (fewer when the file shrank under the read). */
async function readSlice(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

/**
 * The answer for an opened file under a Range decision: `206` with the
 * slice, the full `200`, or `416`. `headers` are the route's own (type,
 * disposition, CSP, ETag); `Accept-Ranges`, `Content-Length` and
 * `Content-Range` are added here. The handle is closed once the answer is
 * read (or at once for a 416, a HEAD, an empty answer and a short one).
 */
export async function byteRangeResponse(
  handle: FileHandle,
  size: number,
  decision: ByteRangeDecision,
  headers: Record<string, string>,
  options: { head?: boolean; idleMs?: number } = {},
): Promise<Response> {
  const base = { ...headers, "Accept-Ranges": "bytes" };
  if (decision.kind === "unsatisfiable") {
    void handle.close().catch(() => {});
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
  }
  const start = decision.kind === "partial" ? decision.start : 0;
  const end = decision.kind === "partial" ? decision.end : size - 1;
  const length = Math.max(0, end - start + 1);
  const out: Record<string, string> = { ...base, "Content-Length": String(length) };
  if (decision.kind === "partial") out["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = decision.kind === "partial" ? 206 : 200;
  if (options.head || length === 0) {
    void handle.close().catch(() => {});
    return new Response(null, { status, headers: out });
  }
  if (length <= BYTE_RANGE_WHOLE_MAX) {
    try {
      const bytes = await readSlice(handle, start, length);
      out["Content-Length"] = String(bytes.length);
      return new Response(new Uint8Array(bytes), { status, headers: out });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return new Response(handleRangeStream(handle, start, end, { idleMs: options.idleMs }), { status, headers: out });
}

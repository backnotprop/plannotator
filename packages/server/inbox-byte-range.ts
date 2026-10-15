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
 *   `Content-Range: bytes a-b/size` (an end past the file is the last byte);
 * - none, or a header that is not a byte range we read: the full `200`;
 * - several ranges: the full `200` (no multipart);
 * - a range that starts past the end (or `-0`, or any range of an empty
 *   file): `416` whose `Content-Range` names only the size (`bytes *` then `/size`);
 * - `If-Range` that is not exactly this version's ETag (or is a date): the
 *   full `200`, so a player that resumes a file the agent re-rendered starts
 *   over instead of splicing two films.
 */

import type { FileHandle } from "node:fs/promises";

export type ByteRangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** What one `Range` header asks of a file of `size` bytes, with `If-Range` judged against `etag`. */
export function decideByteRange(range: string | null, size: number, options: { ifRange?: string | null; etag?: string } = {}): ByteRangeDecision {
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

/** Bytes `start..end` (inclusive) of a file handle, read in 1 MiB chunks and closed at its end or when the reader goes away. */
export function handleRangeStream(handle: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void handle.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const left = end + 1 - position;
        if (left <= 0) {
          close();
          controller.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, left));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
          // The file shrank under the stream: end it short rather than hang.
          close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
}

/**
 * An answer up to this long is read whole and sent with its `Content-Length`
 * (a player's probe, `bytes=0-1`, and most of its seeks). Bun sends a longer,
 * streamed body chunked and drops the header (checked on Bun 1.3.14: a
 * ReadableStream that does not finish at once loses an explicit
 * Content-Length), so the size of a long answer is in its `Content-Range`
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
  options: { head?: boolean } = {},
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
  return new Response(handleRangeStream(handle, start, end), { status, headers: out });
}

/**
 * The HTTP Range decision (RFC 9110 section 14) shared by every byte route
 * that answers one: the Inbox's attachment `video` and `download`
 * (packages/server/inbox-byte-range.ts builds those answers) and the local
 * Markdown video route of the annotate and plan servers, Bun and Pi
 * (`/api/annotate-media`). Pure, so Pi vendors it.
 *
 * - one range, `bytes=a-b`, `bytes=a-` or `bytes=-n`: partial, `a-b` (an end
 *   past the file is the last byte), at most `maxLength` of it;
 * - none, or a header that is not a byte range we read: the full file;
 * - several ranges: the full file (no multipart);
 * - a range that starts past the end (or `-0`, or any range of an empty
 *   file): unsatisfiable (`416`, `Content-Range: bytes *` then `/size`);
 * - `If-Range` that is not exactly `etag`, by strong comparison: the full file.
 */

export type ByteRangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

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

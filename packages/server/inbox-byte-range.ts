/** HTTP Range answers are built by hand: `new Response(Bun.file(path))` reopens the file by path and loses the `O_NOFOLLOW` + dev/ino check every read takes. */

import type { FileHandle } from "node:fs/promises";

export type ByteRangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** The most one 206 carries: Bun 1.3.14 pulls a streamed body as fast as the file reads, so a longer range gets its first 8 MiB and the client asks again. */
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
    const n = Number(spec[2]);
    if (!Number.isSafeInteger(n)) return { kind: "full" };
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(spec[1]);
  const last = spec[2] === "" ? null : Number(spec[2]);
  if (!Number.isSafeInteger(start) || (last !== null && !Number.isSafeInteger(last))) return { kind: "full" };
  if (last !== null && last < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

/** A streamed body not pulled for this long has its handle closed. Five minutes, because Bun 1.4 pulls only as fast as the client reads and a paused player must not be cut off. */
export const STREAM_IDLE_CLOSE_MS = 5 * 60_000;

/** Bytes `start..end` of a file handle in 1 MiB chunks. On Bun 1.3.14 a close during a read in flight never closes the descriptor, so it waits for the read; an idle watchdog covers clients that vanish without `cancel`. */
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
        finish();
        return;
      }
      if (bytesRead === 0) {
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

/** An answer up to this long is read whole and sent with its `Content-Length`: Bun drops that header on a longer streamed body. */
export const BYTE_RANGE_WHOLE_MAX = 1024 * 1024;

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

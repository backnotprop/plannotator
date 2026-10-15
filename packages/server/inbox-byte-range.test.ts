/**
 * HTTP Range as the Inbox's `video` and `download` routes decide it
 * (inbox-byte-range.ts): one range is a 206, none or several the full 200, a
 * range past the end a 416, and an If-Range that is not this version's ETag
 * the full 200.
 */
import { describe, expect, test } from "bun:test";
import { BYTE_RANGE_MAX_ANSWER, byteRangeResponse, decideByteRange, handleRangeStream } from "./inbox-byte-range";

const ETAG = '"1-2-3-4"';

describe("decideByteRange", () => {
  test("one range: a-b, a-, -n (an end past the file is its last byte)", () => {
    expect(decideByteRange("bytes=0-1", 1000)).toEqual({ kind: "partial", start: 0, end: 1 });
    expect(decideByteRange("bytes=100-", 1000)).toEqual({ kind: "partial", start: 100, end: 999 });
    expect(decideByteRange("bytes=-200", 1000)).toEqual({ kind: "partial", start: 800, end: 999 });
    expect(decideByteRange("bytes=-5000", 1000)).toEqual({ kind: "partial", start: 0, end: 999 });
    expect(decideByteRange("bytes=990-5000", 1000)).toEqual({ kind: "partial", start: 990, end: 999 });
    expect(decideByteRange("bytes = 5 - 9", 1000)).toEqual({ kind: "partial", start: 5, end: 9 });
    expect(decideByteRange("BYTES=999-999", 1000)).toEqual({ kind: "partial", start: 999, end: 999 });
  });

  test("no range, a header we do not read, or several ranges: the full file", () => {
    expect(decideByteRange(null, 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("items=0-1", 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=abc", 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=-", 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=9-2", 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=0-1, 5-9", 1000)).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=0-1,", 1000)).toEqual({ kind: "partial", start: 0, end: 1 });
  });

  test("unsatisfiable: a start at or past the end, -0, and any range of an empty file", () => {
    expect(decideByteRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(decideByteRange("bytes=5000-6000", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(decideByteRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(decideByteRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(decideByteRange("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  test("If-Range: this version's ETag keeps the range; another tag or a date asks for the full file", () => {
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: ETAG, etag: ETAG })).toEqual({ kind: "partial", start: 10, end: 19 });
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: '"1-2-3-5"', etag: ETAG })).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: "Wed, 21 Oct 2026 07:28:00 GMT", etag: ETAG })).toEqual({ kind: "full" });
    // Strong comparison (RFC 9110): a weak form of the same tag does not match.
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: `W/${ETAG}`, etag: ETAG })).toEqual({ kind: "full" });
    // A stale If-Range never turns an unsatisfiable range into a 416: the full file is the answer.
    expect(decideByteRange("bytes=5000-", 1000, { ifRange: '"old"', etag: ETAG })).toEqual({ kind: "full" });
  });
});

/** A stand-in file handle: reads resolve when `release` is called, and close is counted (and ignored while a read runs, as Bun's is). */
function fakeHandle(size: number) {
  const state = { closes: 0, closedWhileReading: 0, reading: 0, release: [] as (() => void)[] };
  const handle = {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      state.reading += 1;
      await new Promise<void>((resolve) => state.release.push(resolve));
      state.reading -= 1;
      const n = Math.max(0, Math.min(length, size - position));
      buffer.fill(7, offset, offset + n);
      return { bytesRead: n, buffer };
    },
    async close() {
      if (state.reading > 0) state.closedWhileReading += 1;
      else state.closes += 1;
    },
  };
  return { handle: handle as unknown as import("node:fs/promises").FileHandle, state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("handleRangeStream", () => {
  test("a cancel while a read is in flight closes the handle once that read returns (Bun loses a close made mid-read)", async () => {
    const { handle, state } = fakeHandle(4 * 1024 * 1024);
    const reader = handleRangeStream(handle, 0, undefined, { idleMs: 60_000 }).getReader();
    const first = reader.read();
    await tick();
    state.release.shift()!();
    expect((await first).value!.length).toBe(1024 * 1024);
    // The stream pulls ahead: a second read is now in flight.
    await tick();
    expect(state.reading).toBe(1);
    const cancelled = reader.cancel();
    await tick();
    expect(state.closes).toBe(0);
    expect(state.closedWhileReading).toBe(0);
    state.release.shift()!();
    await cancelled;
    await tick();
    expect(state.closes).toBe(1);
    expect(state.closedWhileReading).toBe(0);
  });

  test("a stream nobody pulls closes its handle after the idle time; a later pull errors", async () => {
    const { handle, state } = fakeHandle(4 * 1024 * 1024);
    const stream = handleRangeStream(handle, 0, undefined, { idleMs: 40 });
    // The stream reads its first chunk ahead by itself; then nobody pulls.
    await tick();
    state.release.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(state.closes).toBe(1);
    const reader = stream.getReader();
    // The chunk read ahead is still delivered; the next pull finds the handle closed.
    expect((await reader.read()).value!.length).toBe(1024 * 1024);
    await expect(reader.read()).rejects.toThrow(/went unread/);
    expect(state.closes).toBe(1);
  });

  test("a reader that keeps pulling is never closed by the watchdog, and the end closes the handle once", async () => {
    const { handle, state } = fakeHandle(3 * 1024 * 1024 + 10);
    const reader = handleRangeStream(handle, 0, undefined, { idleMs: 30 }).getReader();
    let total = 0;
    for (;;) {
      const next = reader.read();
      await tick();
      while (state.release.length) state.release.shift()!();
      const { done, value } = await next;
      if (done) break;
      total += value.length;
      // Slower than the idle time between reads, but each pull re-arms it.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(total).toBe(3 * 1024 * 1024 + 10);
    expect(state.closes).toBe(1);
  });
});

describe("the 8 MiB answer cap", () => {
  const MiB = 1024 * 1024;
  const FILM = 200 * MiB;

  test("an open-ended or longer range is answered with its first 8 MiB; a shorter one is untouched", () => {
    expect(BYTE_RANGE_MAX_ANSWER).toBe(8 * MiB);
    expect(decideByteRange("bytes=0-", FILM)).toEqual({ kind: "partial", start: 0, end: 8 * MiB - 1 });
    expect(decideByteRange("bytes=100000000-", FILM)).toEqual({ kind: "partial", start: 100000000, end: 100000000 + 8 * MiB - 1 });
    expect(decideByteRange("bytes=0-99999999", FILM)).toEqual({ kind: "partial", start: 0, end: 8 * MiB - 1 });
    // The last 100 MB: from where that starts, 8 MiB of it.
    expect(decideByteRange("bytes=-100000000", FILM)).toEqual({ kind: "partial", start: FILM - 100000000, end: FILM - 100000000 + 8 * MiB - 1 });
    // At or under the cap, and near the end of the file, the range is as asked.
    expect(decideByteRange(`bytes=0-${8 * MiB - 1}`, FILM)).toEqual({ kind: "partial", start: 0, end: 8 * MiB - 1 });
    expect(decideByteRange(`bytes=${FILM - 10}-`, FILM)).toEqual({ kind: "partial", start: FILM - 10, end: FILM - 1 });
    expect(decideByteRange("bytes=0-1", FILM)).toEqual({ kind: "partial", start: 0, end: 1 });
    // No range is the full file, never capped (a plain download).
    expect(decideByteRange(null, FILM)).toEqual({ kind: "full" });
  });

  test("one capped answer reads at most 8 MiB from the file, however much was asked for", async () => {
    let read = 0;
    const handle = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        const n = Math.max(0, Math.min(length, FILM - position));
        read += n;
        return { bytesRead: n, buffer };
      },
      async close() {},
    } as unknown as import("node:fs/promises").FileHandle;
    const answer = await byteRangeResponse(handle, FILM, decideByteRange("bytes=0-", FILM), {});
    expect(answer.status).toBe(206);
    expect(answer.headers.get("content-range")).toBe(`bytes 0-${8 * MiB - 1}/${FILM}`);
    expect((await answer.arrayBuffer()).byteLength).toBe(8 * MiB);
    expect(read).toBe(8 * MiB);
  });
});

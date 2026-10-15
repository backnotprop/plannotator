/**
 * HTTP Range as the Inbox's `video` and `download` routes decide it
 * (inbox-byte-range.ts): one range is a 206, none or several the full 200, a
 * range past the end a 416, and an If-Range that is not this version's ETag
 * the full 200.
 */
import { describe, expect, test } from "bun:test";
import { decideByteRange } from "./inbox-byte-range";

const ETAG = 'W/"1-2-3-4"';

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
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: 'W/"1-2-3-5"', etag: ETAG })).toEqual({ kind: "full" });
    expect(decideByteRange("bytes=10-19", 1000, { ifRange: "Wed, 21 Oct 2026 07:28:00 GMT", etag: ETAG })).toEqual({ kind: "full" });
    // A stale If-Range never turns an unsatisfiable range into a 416: the full file is the answer.
    expect(decideByteRange("bytes=5000-", 1000, { ifRange: '"old"', etag: ETAG })).toEqual({ kind: "full" });
  });
});

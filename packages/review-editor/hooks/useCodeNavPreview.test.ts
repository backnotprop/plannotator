/**
 * The sentence the code-nav preview shows for a refused file must be true.
 * A file just over the 5 MB cap rounds to "5 MB", which once read
 * "too large to preview (5 MB; the limit is 5 MB)".
 */
import { describe, expect, test } from "bun:test";
import { codeNavPreviewErrorMessage } from "./useCodeNavPreview";

const LIMIT = 5 * 1024 * 1024;
const sizesIn = (message: string) => message.match(/\d+(\.\d+)? MB/g) ?? [];

describe("codeNavPreviewErrorMessage too-large", () => {
  test("a file one byte over the limit does not show two equal sizes", () => {
    const sizes = sizesIn(codeNavPreviewErrorMessage({ reason: "too-large", size: LIMIT + 1, maxBytes: LIMIT }));
    expect(sizes).toContain("5 MB");
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  test("a clearly larger file shows its size and the limit", () => {
    const sizes = sizesIn(codeNavPreviewErrorMessage({ reason: "too-large", size: 6 * 1024 * 1024, maxBytes: LIMIT }));
    expect(sizes).toEqual(expect.arrayContaining(["6 MB", "5 MB"]));
    expect(new Set(sizes).size).toBe(2);
  });
});

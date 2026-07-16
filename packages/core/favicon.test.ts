import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FAVICON_PNG_BYTES,
  FAVICON_PNG_DATA_URL,
  FAVICON_SVG,
} from "./favicon";

describe("production favicon", () => {
  test("embeds the canonical 64px PNG exactly", () => {
    expect(createHash("sha256").update(FAVICON_PNG_BYTES).digest("hex")).toBe(
      "8467d50dba314f3b72ab73ba37d406baabd8d74ed72529e853613442a8c65073",
    );
    expect(Array.from(FAVICON_PNG_BYTES.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const view = new DataView(
      FAVICON_PNG_BYTES.buffer,
      FAVICON_PNG_BYTES.byteOffset,
      FAVICON_PNG_BYTES.byteLength,
    );
    expect(view.getUint32(16)).toBe(64);
    expect(view.getUint32(20)).toBe(64);
  });

  test("keeps the SVG export as a wrapper around the canonical PNG", () => {
    expect(FAVICON_PNG_DATA_URL).toStartWith("data:image/png;base64,");
    expect(FAVICON_SVG).toContain(FAVICON_PNG_DATA_URL);
    expect(FAVICON_SVG).not.toContain("<text");
    expect(FAVICON_SVG).not.toContain("#070b14");
  });
});

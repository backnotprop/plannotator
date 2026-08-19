import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLASSIC_FAVICON_DATA_URL,
  CLASSIC_FAVICON_SVG,
  FAVICON_PNG_BYTES,
  FAVICON_PNG_DATA_URL,
  FAVICON_SVG,
  faviconDataUrl,
  isFaviconStyle,
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
    expect(view.getUint8(24)).toBe(8);
    expect(view.getUint8(25)).toBe(6);
  });

  test("keeps the SVG export as a wrapper around the canonical PNG", () => {
    expect(FAVICON_PNG_DATA_URL).toStartWith("data:image/png;base64,");
    expect(FAVICON_SVG).toContain(FAVICON_PNG_DATA_URL);
    expect(FAVICON_SVG).not.toContain("<text");
    expect(FAVICON_SVG).not.toContain("#070b14");
  });
});

describe("favicon style switcher", () => {
  test("embeds the historical pre-Totman SVG exactly", () => {
    // Pinned on purpose: the classic style is an archival asset, byte-identical
    // to the FAVICON_SVG that shipped at 5b91c543^. A "harmless" reformat of the
    // template literal would silently ship a different icon under the same name.
    expect(createHash("sha256").update(CLASSIC_FAVICON_SVG).digest("hex")).toBe(
      "27d33cff3d4515801f48e1cbaceec777ba802a7d341b22b2c0444d82b303cb49",
    );
  });

  test("faviconDataUrl('totman') returns exact production PNG data URL", () => {
    expect(faviconDataUrl("totman")).toBe(FAVICON_PNG_DATA_URL);
  });

  test("faviconDataUrl('classic') returns base64 SVG data URL matching historical asset", () => {
    const dataUrl = faviconDataUrl("classic");
    expect(dataUrl).toBe(CLASSIC_FAVICON_DATA_URL);
    expect(dataUrl).toStartWith("data:image/svg+xml;base64,");

    const base64Payload = dataUrl.replace("data:image/svg+xml;base64,", "");
    const decodedSvg = atob(base64Payload);

    expect(decodedSvg).toBe(CLASSIC_FAVICON_SVG);
    expect(decodedSvg).toContain("#070b14");
    expect(decodedSvg).toContain("#E0BA55");
    expect(decodedSvg).toContain("<text");
    expect(decodedSvg).toContain(">P</text>");
  });

  test("isFaviconStyle validates only known styles", () => {
    expect(isFaviconStyle("totman")).toBe(true);
    expect(isFaviconStyle("classic")).toBe(true);
    expect(isFaviconStyle("")).toBe(false);
    expect(isFaviconStyle("unknown")).toBe(false);
    expect(isFaviconStyle(null)).toBe(false);
    expect(isFaviconStyle(undefined)).toBe(false);
    expect(isFaviconStyle(123)).toBe(false);
    expect(isFaviconStyle({})).toBe(false);
  });
});

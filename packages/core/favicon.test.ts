import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLASSIC_FAVICON_DATA_URL,
  CLASSIC_FAVICON_SVG,
  DEFAULT_FAVICON_STYLE,
  FACE_FAVICON_PNG_BYTES,
  FACE_FAVICON_PNG_DATA_URL,
  FAVICON_ICO_BYTES,
  FAVICON_ICO_DATA_URL,
  FAVICON_PNG_BYTES,
  FAVICON_PNG_DATA_URL,
  FAVICON_STYLE_CHOICES,
  FAVICON_SVG,
  YELLOW_FAVICON_ICO_BYTES,
  YELLOW_FAVICON_ICO_DATA_URL,
  YELLOW_FAVICON_PNG_BYTES,
  YELLOW_FAVICON_PNG_DATA_URL,
  faviconBody,
  faviconDataUrl,
  faviconIcoBody,
  faviconLinkType,
  faviconPngDataUrl,
  isFaviconStyle,
} from "./favicon";

describe("production favicon", () => {
  test("the tab icon is the studio's web/favicon.ico exactly: 16, 32 and 48 frames", () => {
    expect(createHash("sha256").update(FAVICON_ICO_BYTES).digest("hex")).toBe(
      "7402e8509ac4ab49194fa387ab0722766cfab5ab94230c798facfd0e97771c59",
    );
    const view = new DataView(FAVICON_ICO_BYTES.buffer, FAVICON_ICO_BYTES.byteOffset, FAVICON_ICO_BYTES.byteLength);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    const count = view.getUint16(4, true);
    const sizes = Array.from({ length: count }, (_, i) => `${view.getUint8(6 + 16 * i)}x${view.getUint8(7 + 16 * i)}`);
    expect(sizes).toEqual(["16x16", "32x32", "48x48"]);
    expect(FAVICON_ICO_DATA_URL).toStartWith("data:image/x-icon;base64,");
  });

  test("the one-PNG build is the studio's pixel/fav-32.png exactly", () => {
    expect(createHash("sha256").update(FAVICON_PNG_BYTES).digest("hex")).toBe(
      "02dd9afe0ab91344168142cc4aa7cdac952e2f88e1cd55c089798b7f79520d2b",
    );
    expect(Array.from(FAVICON_PNG_BYTES.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const view = new DataView(
      FAVICON_PNG_BYTES.buffer,
      FAVICON_PNG_BYTES.byteOffset,
      FAVICON_PNG_BYTES.byteLength,
    );
    expect(view.getUint32(16)).toBe(32);
    expect(view.getUint32(20)).toBe(32);
    expect(view.getUint8(24)).toBe(8);
    expect(view.getUint8(25)).toBe(6);
  });

  test("the Yellow icon is the yellow glass set's web/favicon.ico and pixel/fav-32.png, byte for byte", () => {
    expect(createHash("sha256").update(YELLOW_FAVICON_ICO_BYTES).digest("hex")).toBe(
      "2c5bbca9b41885f9d07b8b17b50b65e88e236760888ede779192ccb59ff1f8e4",
    );
    const ico = new DataView(YELLOW_FAVICON_ICO_BYTES.buffer, YELLOW_FAVICON_ICO_BYTES.byteOffset, YELLOW_FAVICON_ICO_BYTES.byteLength);
    expect(ico.getUint16(2, true)).toBe(1);
    const sizes = Array.from({ length: ico.getUint16(4, true) }, (_, i) => `${ico.getUint8(6 + 16 * i)}x${ico.getUint8(7 + 16 * i)}`);
    expect(sizes).toEqual(["16x16", "32x32", "48x48"]);
    expect(YELLOW_FAVICON_ICO_DATA_URL).toStartWith("data:image/x-icon;base64,");

    expect(createHash("sha256").update(YELLOW_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "22f9b788ee9ce33caf76521b7c1e8962b82964805c54cbc139b072e7b2ba73db",
    );
    const png = new DataView(YELLOW_FAVICON_PNG_BYTES.buffer, YELLOW_FAVICON_PNG_BYTES.byteOffset, YELLOW_FAVICON_PNG_BYTES.byteLength);
    expect(png.getUint32(16)).toBe(32);
    expect(png.getUint32(20)).toBe(32);
    expect(YELLOW_FAVICON_PNG_DATA_URL).toStartWith("data:image/png;base64,");
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
    expect(createHash("sha256").update(CLASSIC_FAVICON_SVG).digest("hex")).toBe(
      "27d33cff3d4515801f48e1cbaceec777ba802a7d341b22b2c0444d82b303cb49",
    );
  });

  test("the Face icon is PR 2975's replaced favicon, byte for byte", () => {
    expect(createHash("sha256").update(FACE_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "8467d50dba314f3b72ab73ba37d406baabd8d74ed72529e853613442a8c65073",
    );
    const view = new DataView(FACE_FAVICON_PNG_BYTES.buffer, FACE_FAVICON_PNG_BYTES.byteOffset, FACE_FAVICON_PNG_BYTES.byteLength);
    expect(view.getUint32(16)).toBe(64);
    expect(view.getUint32(20)).toBe(64);
  });

  test("each stored id draws its icon: glass Glass, yellow Yellow, totman Face; classic (the removed P) the default", () => {
    expect(faviconDataUrl("glass")).toBe(FAVICON_ICO_DATA_URL);
    expect(faviconDataUrl("totman")).toBe(FACE_FAVICON_PNG_DATA_URL);
    expect(faviconDataUrl("yellow")).toBe(YELLOW_FAVICON_ICO_DATA_URL);
    expect(faviconBody("glass")).toEqual({ body: FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconBody("totman")).toEqual({ body: FACE_FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconBody("yellow")).toEqual({ body: YELLOW_FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconBody(undefined).body).toBe(FAVICON_PNG_BYTES);
    expect(faviconBody("navy").body).toBe(FAVICON_PNG_BYTES);
    expect(faviconBody("classic")).toEqual({ body: FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconIcoBody("classic")).toEqual({ body: FAVICON_ICO_BYTES, contentType: "image/x-icon" });
    expect(DEFAULT_FAVICON_STYLE).toBe("glass");
    expect(faviconIcoBody("glass")).toEqual({ body: FAVICON_ICO_BYTES, contentType: "image/x-icon" });
    expect(faviconIcoBody(undefined).body).toBe(FAVICON_ICO_BYTES);
    expect(faviconIcoBody("totman")).toEqual({ body: FACE_FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconIcoBody("yellow")).toEqual({ body: YELLOW_FAVICON_ICO_BYTES, contentType: "image/x-icon" });
    expect(faviconPngDataUrl("glass")).toBe(FAVICON_PNG_DATA_URL);
    expect(faviconPngDataUrl("totman")).toBe(FACE_FAVICON_PNG_DATA_URL);
    expect(faviconPngDataUrl("yellow")).toBe(YELLOW_FAVICON_PNG_DATA_URL);
    expect(faviconLinkType("glass")).toEqual({ type: "image/x-icon", sizes: "16x16 32x32 48x48" });
    expect(faviconLinkType("totman")).toEqual({ type: "image/png", sizes: "64x64" });
    expect(faviconLinkType("yellow")).toEqual({ type: "image/x-icon", sizes: "16x16 32x32 48x48" });
  });

  test("the picker offers Glass, Yellow and Face, in that order; P is gone", () => {
    expect(FAVICON_STYLE_CHOICES.map(({ id, label }) => `${id}:${label}`)).toEqual(["glass:Glass", "yellow:Yellow", "totman:Face"]);
    expect(FAVICON_STYLE_CHOICES.map(({ label }) => label).join(" ")).not.toContain("Totman");
  });

  test("the old navy P stays exported as a data URL of the archival SVG", () => {
    expect(atob(CLASSIC_FAVICON_DATA_URL.replace("data:image/svg+xml;base64,", ""))).toBe(CLASSIC_FAVICON_SVG);
  });

  test("isFaviconStyle validates only known styles", () => {
    expect(isFaviconStyle("glass")).toBe(true);
    expect(isFaviconStyle("totman")).toBe(true);
    expect(isFaviconStyle("yellow")).toBe(true);
    expect(isFaviconStyle("classic")).toBe(false);
    expect(isFaviconStyle("")).toBe(false);
    expect(isFaviconStyle("unknown")).toBe(false);
    expect(isFaviconStyle(null)).toBe(false);
    expect(isFaviconStyle(undefined)).toBe(false);
    expect(isFaviconStyle(123)).toBe(false);
    expect(isFaviconStyle({})).toBe(false);
  });
});

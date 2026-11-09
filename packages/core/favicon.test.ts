import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CLASSIC_FAVICON_DATA_URL,
  CLASSIC_FAVICON_SVG,
  DEFAULT_FAVICON_STYLE,
  FACE_FAVICON_PNG_BYTES,
  FACE_FAVICON_PNG_DATA_URL,
  FAVICON_PNG_BYTES,
  FAVICON_PNG_DATA_URL,
  FAVICON_STYLE_CHOICES,
  FAVICON_SVG,
  P_FAVICON_PNG_BYTES,
  P_FAVICON_PNG_DATA_URL,
  faviconBody,
  faviconDataUrl,
  isFaviconStyle,
} from "./favicon";

describe("production favicon", () => {
  test("embeds the studio's 192px goggles PNG exactly", () => {
    expect(createHash("sha256").update(FAVICON_PNG_BYTES).digest("hex")).toBe(
      "f4616566aad3e00fc8c04ebb1dcae8e4ebcd671af99db7fc50e50eefa09a05a5",
    );
    expect(Array.from(FAVICON_PNG_BYTES.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const view = new DataView(
      FAVICON_PNG_BYTES.buffer,
      FAVICON_PNG_BYTES.byteOffset,
      FAVICON_PNG_BYTES.byteLength,
    );
    expect(view.getUint32(16)).toBe(192);
    expect(view.getUint32(20)).toBe(192);
    expect(view.getUint8(24)).toBe(8);
    // Colour type 2 (RGB) or 6 (RGBA): the studio's file decides.
    expect([2, 6]).toContain(view.getUint8(25));
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

  test("the Face icon is PR 2975's replaced favicon, byte for byte", () => {
    // The 64px goggles face that FAVICON_PNG_BASE64 held at eede4aecf^1. Pinned
    // so the stored id 'totman' keeps showing exactly what people picked.
    expect(createHash("sha256").update(FACE_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "8467d50dba314f3b72ab73ba37d406baabd8d74ed72529e853613442a8c65073",
    );
    const view = new DataView(FACE_FAVICON_PNG_BYTES.buffer, FACE_FAVICON_PNG_BYTES.byteOffset, FACE_FAVICON_PNG_BYTES.byteLength);
    expect(view.getUint32(16)).toBe(64);
    expect(view.getUint32(20)).toBe(64);
  });

  test("the P icon is the studio's icon-192.png, byte for byte", () => {
    expect(createHash("sha256").update(P_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "f6bed7f06a78ae9d4de3d2019e7704ca447f9629c85d868ca77f5a25af82b4f8",
    );
    const view = new DataView(P_FAVICON_PNG_BYTES.buffer, P_FAVICON_PNG_BYTES.byteOffset, P_FAVICON_PNG_BYTES.byteLength);
    expect(view.getUint32(16)).toBe(192);
    expect(view.getUint32(20)).toBe(192);
  });

  test("each stored id draws its icon: glass Glass, totman Face, classic the P icon", () => {
    expect(faviconDataUrl("glass")).toBe(FAVICON_PNG_DATA_URL);
    expect(faviconDataUrl("totman")).toBe(FACE_FAVICON_PNG_DATA_URL);
    expect(faviconDataUrl("classic")).toBe(P_FAVICON_PNG_DATA_URL);
    expect(faviconBody("glass")).toEqual({ body: FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconBody("totman")).toEqual({ body: FACE_FAVICON_PNG_BYTES, contentType: "image/png" });
    expect(faviconBody("classic")).toEqual({ body: P_FAVICON_PNG_BYTES, contentType: "image/png" });
    // Nothing stored, or a value from somewhere else: the default, Glass.
    expect(faviconBody(undefined).body).toBe(FAVICON_PNG_BYTES);
    expect(faviconBody("navy").body).toBe(FAVICON_PNG_BYTES);
    expect(DEFAULT_FAVICON_STYLE).toBe("glass");
  });

  test("the picker offers Glass, Face and P, in that order", () => {
    expect(FAVICON_STYLE_CHOICES.map(({ id, label }) => `${id}:${label}`)).toEqual(["glass:Glass", "totman:Face", "classic:P"]);
    expect(FAVICON_STYLE_CHOICES.map(({ label }) => label).join(" ")).not.toContain("Totman");
  });

  test("the old navy P stays exported as a data URL of the archival SVG", () => {
    expect(atob(CLASSIC_FAVICON_DATA_URL.replace("data:image/svg+xml;base64,", ""))).toBe(CLASSIC_FAVICON_SVG);
  });

  test("isFaviconStyle validates only known styles", () => {
    expect(isFaviconStyle("glass")).toBe(true);
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

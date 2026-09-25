import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { openPackedApp, packApp, PACKED_ASSETS_MARKER } from "./packed-app";

const PAGE = '<!doctype html><script type="module" src="/assets/app.js"></script>';
// Non-ASCII, newlines and the marker itself inside asset data: the index
// addresses data by offset, so none of these may shift or split an asset.
const SCRIPT = `export const s = "é 🙂";\n// ${PACKED_ASSETS_MARKER}\n`;
const STYLE = "body { color: red }";
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]);

const app = openPackedApp(packApp(PAGE, {
  "/assets/app.js": { type: "text/javascript; charset=utf-8", text: SCRIPT },
  "/assets/style.css": { type: "text/css; charset=utf-8", text: STYLE },
  "/assets/font.woff2": { type: "font/woff2", base64: Buffer.from(FONT).toString("base64") },
}));

describe("packed app", () => {
  test("serves the page without the pack", () => {
    expect(app.html).toBe(PAGE);
  });

  test("text assets round-trip exactly, gzipped only when the client accepts it", () => {
    const gzipped = app.asset("/assets/app.js", "gzip, deflate, br")!;
    expect(gzipped.headers["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(gzipped.body).toString()).toBe(SCRIPT);
    expect(gzipped.headers["Vary"]).toBe("Accept-Encoding");

    const identity = app.asset("/assets/style.css", undefined)!;
    expect(identity.headers["Content-Encoding"]).toBeUndefined();
    expect(identity.body.toString()).toBe(STYLE);
    expect(identity.headers["Content-Type"]).toBe("text/css; charset=utf-8");
  });

  test("binary assets are decoded and never re-compressed", () => {
    const font = app.asset("/assets/font.woff2", "gzip")!;
    expect(new Uint8Array(font.body)).toEqual(FONT);
    expect(font.headers["Content-Encoding"]).toBeUndefined();
    expect(font.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  test("a path outside the pack is not an asset, so it falls through to the page", () => {
    expect(app.asset("/assets/missing.js", "gzip")).toBeUndefined();
    expect(app.asset("/", "gzip")).toBeUndefined();
  });

  test("an unpacked page serves as-is", () => {
    const plain = openPackedApp(PAGE);
    expect(plain.html).toBe(PAGE);
    expect(plain.asset("/assets/app.js", "gzip")).toBeUndefined();
  });
});

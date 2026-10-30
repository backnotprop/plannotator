import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
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

const text = (body: string | Buffer) => (typeof body === "string" ? body : body.toString("utf8"));

describe("packed app", () => {
  test("serves the page without the pack, at any path outside /assets/", async () => {
    expect(app.html).toBe(PAGE);
    for (const path of ["/", "/some/route", "/assets"]) {
      const page = await app.answer(path, "GET", "gzip", false);
      expect({ path, status: page.status, body: text(page.body) }).toEqual({ path, status: 200, body: PAGE });
      expect(page.headers["Content-Type"]).toBe("text/html");
    }
  });

  test("serves each asset by its exact name, as built, with its type, nosniff and an immutable cache", async () => {
    const script = await app.answer("/assets/app.js", "GET", "gzip, br", false);
    expect(script.status).toBe(200);
    expect(text(script.body)).toBe(SCRIPT);
    expect(script.headers).toMatchObject({
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(Buffer.byteLength(SCRIPT)),
    });
    // A local session never compresses (#1617's rule for the page).
    expect(script.headers["Content-Encoding"]).toBeUndefined();

    expect(text((await app.answer("/assets/style.css", "HEAD", null, false)).body)).toBe(STYLE);
    const font = await app.answer("/assets/font.woff2", "GET", null, false);
    expect(new Uint8Array(font.body as Buffer)).toEqual(FONT);
    expect(font.headers["Content-Type"]).toBe("font/woff2");
  });

  test("a name not in the pack is 404, never the page", async () => {
    for (const path of ["/assets/missing.js", "/assets/APP.js", "/assets/app.js/", "/assets/../assets/app.js", "/assets/"]) {
      const miss = await app.answer(path, "GET", null, false);
      expect({ path, status: miss.status }).toEqual({ path, status: 404 });
      expect(miss.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(text(miss.body)).not.toContain("<script");
    }
  });

  test("anything but GET and HEAD under /assets/ is 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const refused = await app.answer("/assets/app.js", method, null, false);
      expect({ method, status: refused.status }).toEqual({ method, status: 405 });
      expect(refused.headers.Allow).toBe("GET, HEAD");
    }
  });

  test("a compressing session sends text the client can decode, and binary as is", async () => {
    const gzip = await app.answer("/assets/app.js", "GET", "gzip, deflate", true);
    expect(gzip.headers["Content-Encoding"]).toBe("gzip");
    expect(gzip.headers.Vary).toBe("Accept-Encoding");
    expect(gunzipSync(gzip.body as Buffer).toString()).toBe(SCRIPT);

    const br = await app.answer("/assets/app.js", "GET", "gzip, br", true);
    expect(br.headers["Content-Encoding"]).toBe("br");
    expect(brotliDecompressSync(br.body as Buffer).toString()).toBe(SCRIPT);

    const identity = await app.answer("/assets/app.js", "GET", undefined, true);
    expect(identity.headers["Content-Encoding"]).toBeUndefined();
    expect(text(identity.body)).toBe(SCRIPT);

    const font = await app.answer("/assets/font.woff2", "GET", "gzip", true);
    expect(font.headers["Content-Encoding"]).toBeUndefined();
    expect(new Uint8Array(font.body as Buffer)).toEqual(FONT);
  });

  test("an unpacked page serves as-is and has no assets", async () => {
    const plain = openPackedApp(PAGE);
    expect(plain.html).toBe(PAGE);
    expect(text((await plain.answer("/", "GET", null, false)).body)).toBe(PAGE);
    expect((await plain.answer("/assets/app.js", "GET", null, false)).status).toBe(404);
  });
});

import { describe, expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { makeAppHtml } from "../../tests/helpers/app-html";
import { encodeAppHtml, negotiateAppHtmlEncoding, prepareAppHtml } from "./app-html";

describe("negotiateAppHtmlEncoding", () => {
  test.each([
    // [Accept-Encoding, expected]
    [undefined, "identity"],
    [null, "identity"],
    ["", "identity"],
    ["identity", "identity"],
    ["deflate", "identity"],
    ["zstd", "identity"],
    ["gzip, deflate, br, zstd", "br"], // Chromium, also on http://localhost
    ["gzip, deflate", "gzip"], // WebKit over plain http
    ["br", "br"],
    ["BR", "br"],
    ["x-gzip", "gzip"],
    ["br;q=0, gzip", "gzip"],
    ["br;q=0", "identity"],
    ["gzip;q=0", "identity"],
    ["br;q=0, gzip;q=0", "identity"],
    ["gzip;q=1, br;q=0.5", "gzip"], // client preference is honored
    ["gzip;q=0.5, br;q=0.5", "br"], // ties prefer br
    ["br;q=0.001", "br"],
    ["br;q=junk", "identity"], // an unparsable q refuses that coding
    ["*", "br"],
    ["*;q=0", "identity"],
    ["*, br;q=0", "gzip"],
    ["gzip , br ; q=0", "gzip"],
  ] as const)("%p -> %p", (header, expected) => {
    expect(negotiateAppHtmlEncoding(header)).toBe(expected);
  });
});

describe("prepareAppHtml", () => {
  test("identity returns the original string untouched", async () => {
    const html = makeAppHtml("identity-unit");
    const prepared = await prepareAppHtml(html, undefined, true);
    expect(prepared.encoding).toBe("identity");
    expect(prepared.body).toBe(html);
    expect(prepared.headers).toEqual({ "Content-Type": "text/html", Vary: "Accept-Encoding" });
  });

  test("a non-compressing (local) session returns the pre-#1617 response for any header", async () => {
    const html = makeAppHtml("local-unit");
    for (const header of ["gzip, deflate, br, zstd", "gzip", undefined]) {
      const prepared = await prepareAppHtml(html, header, false);
      expect(prepared.body).toBe(html);
      expect(prepared.headers).toEqual({ "Content-Type": "text/html" });
    }
  });

  test("br and gzip bodies decompress to the exact original bytes", async () => {
    const html = makeAppHtml("roundtrip-unit");
    const original = Buffer.from(html, "utf8");
    const br = await prepareAppHtml(html, "br", true);
    const gzip = await prepareAppHtml(html, "gzip", true);
    expect(brotliDecompressSync(br.body as Buffer).equals(original)).toBe(true);
    expect(gunzipSync(gzip.body as Buffer).equals(original)).toBe(true);
    expect(br.headers["Content-Length"]).toBe(String((br.body as Buffer).length));
    expect(br.headers["Content-Encoding"]).toBe("br");
    expect(gzip.headers["Content-Encoding"]).toBe("gzip");
  });

  test("each body is compressed once per encoding and then reused", async () => {
    const html = makeAppHtml("cache-unit");
    // Concurrent first requests share one in-flight compression.
    const [a, b] = await Promise.all([encodeAppHtml(html, "br"), encodeAppHtml(html, "br")]);
    expect(a).toBe(b);
    expect(await encodeAppHtml(html, "br")).toBe(a);
    // A different body does not collide with the cached one.
    const other = await encodeAppHtml(makeAppHtml("cache-unit-other"), "br");
    expect(other).not.toBe(a);
    expect(await encodeAppHtml(html, "br")).toBe(a);
  });
});

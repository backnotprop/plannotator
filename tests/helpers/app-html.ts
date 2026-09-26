import { expect } from "bun:test";
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * A raw HTTP request that never adds or strips an encoding. `fetch` would
 * advertise its own Accept-Encoding and transparently decode, hiding exactly
 * what these tests check.
 */
export function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A large, compressible, non-ASCII page so byte/char confusion would show. */
export function makeAppHtml(tag: string): string {
  const filler = Array.from({ length: 4000 }, (_, i) => `<p data-i="${i}">plan · ${tag} ✓ ${i}</p>`).join("");
  return `<!doctype html><html><head><title>${tag}</title></head><body>${filler}</body></html>`;
}

/**
 * A local-only session serves the page exactly as before #1617, whatever the
 * browser advertises: the original bytes, `Content-Type` only, no encoding
 * and no `Vary`.
 */
export async function expectUncompressedLocalPage(pageUrl: string, html: string): Promise<void> {
  const original = Buffer.from(html, "utf8");
  for (const headers of [{ "accept-encoding": "gzip, deflate, br, zstd" }, { "accept-encoding": "gzip" }, {}]) {
    const res = await rawRequest(pageUrl, { headers });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body.equals(original)).toBe(true);
  }
}

/**
 * The negotiation matrix every app-HTML route of a network-reachable session
 * (remote mode or --tailscale) must satisfy, against a live server. `pageUrl`
 * is any SPA route that falls through to the app page.
 */
export async function expectAppHtmlNegotiation(pageUrl: string, html: string): Promise<void> {
  const original = Buffer.from(html, "utf8");

  const brotli = await rawRequest(pageUrl, { headers: { "accept-encoding": "gzip, deflate, br, zstd" } });
  expect(brotli.status).toBe(200);
  expect(brotli.headers["content-encoding"]).toBe("br");
  expect(brotli.headers.vary).toBe("Accept-Encoding");
  expect(brotli.headers["content-type"]).toBe("text/html");
  expect(Number(brotli.headers["content-length"])).toBe(brotli.body.length);
  expect(brotli.body.length).toBeLessThan(original.length / 4);
  expect(brotliDecompressSync(brotli.body).equals(original)).toBe(true);

  // WebKit over plain http (remote mode) advertises no br.
  const gzip = await rawRequest(pageUrl, { headers: { "accept-encoding": "gzip, deflate" } });
  expect(gzip.headers["content-encoding"]).toBe("gzip");
  expect(gzip.headers.vary).toBe("Accept-Encoding");
  expect(Number(gzip.headers["content-length"])).toBe(gzip.body.length);
  expect(gunzipSync(gzip.body).equals(original)).toBe(true);

  // A refused br falls back to gzip.
  const refusedBr = await rawRequest(pageUrl, { headers: { "accept-encoding": "br;q=0, gzip" } });
  expect(refusedBr.headers["content-encoding"]).toBe("gzip");
  expect(gunzipSync(refusedBr.body).equals(original)).toBe(true);

  // Identity shapes: no header (curl), explicit identity (the VS Code cookie
  // proxy), and everything refused. The body is the original bytes, unencoded.
  for (const headers of [{}, { "accept-encoding": "identity" }, { "accept-encoding": "br;q=0, gzip;q=0" }]) {
    const identity = await rawRequest(pageUrl, { headers });
    expect(identity.status).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.headers["content-type"]).toBe("text/html");
    expect(identity.headers.vary).toBe("Accept-Encoding");
    expect(identity.body.equals(original)).toBe(true);
  }

  // HEAD: headers only, no body, whatever the encoding.
  const head = await rawRequest(pageUrl, { method: "HEAD", headers: { "accept-encoding": "br" } });
  expect(head.status).toBe(200);
  expect(head.headers["content-type"]).toBe("text/html");
  expect(head.body.length).toBe(0);
}

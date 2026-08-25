/**
 * Live app proxy contract — Node transport.
 *
 * The same transport-level contract packages/server/live-proxy.test.ts pins
 * for the Bun transport, run against the node:http implementation the Pi
 * extension ships: bridge injection (placement, exactly one, cross-chunk),
 * header hygiene (Host rewrite, Accept-Encoding on document intent only, CSP
 * replacement, frame-ancestors), passthrough fidelity (assets, encoded HTML,
 * SSE, WebSocket upgrade piping), and the security posture (loopback bind,
 * Host-before-parse incl. the Host-less HTTP/1.0 case, WS origin gate,
 * bridge Sec-Fetch-Site gate, reserved namespace). Pure-decision coverage
 * (injector state machine, predicates) lives once in the shared core and is
 * exercised by the Bun suite's unit-helper block; this file guards what the
 * TRANSPORT can regress.
 *
 * The proxy under test runs in a REAL `node` child process
 * (live-proxy-node.child.ts, built with Bun.build): that is the transport's
 * production runtime under Pi, and Bun's node:http shim drops writes made to
 * an 'upgrade' event's socket, which would fail the WS tests against code
 * that works in production.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_PROXY_BRIDGE_PATH,
} from "./live-proxy-core";
import { startLiveAppProxyNode } from "./live-proxy-node";

const INJECT_TAG = `<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`;
const BRIDGE_BODY = "window.__plannotatorLiveConfig = {\"token\":\"tok-node123\",\"editorOrigins\":[\"http://localhost:4100\",\"http://127.0.0.1:4100\"]}; /* bridge */";
const EDITOR_ORIGINS = ["http://localhost:4100", "http://127.0.0.1:4100"];

const HTML_PAGE = "<!doctype html><html><head><title>Fake App</title><link rel=\"stylesheet\" href=\"/style.css\"></head><body><div id=\"root\">hi</div><script src=\"/asset.js\"></script></body></html>";
const NO_HEAD_PAGE = "<html><body><p>bare</p></body></html>";
const BANNER_COMMENT_PAGE = "<!doctype html><!-- @generated: do not edit <head> manually --><html><head><title>Gen</title></head><body>ok</body></html>";
const BINARY_BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

let upstreamHits: string[] = [];
let recordedHeaders: Record<string, string | null> = {};
let upstream: ReturnType<typeof Bun.serve<{ hits: number }, object>>;
let proxy: { port: number; origin: string };
let proxyChild: ReturnType<typeof Bun.spawn> | null = null;
let childDir: string | null = null;

function proxyUrl(path: string): string {
  return proxy.origin + path;
}

/** Build the child entry for real node and spawn it; resolves the proxy port
 * from the child's one-line JSON banner. */
async function spawnNodeProxyChild(targetUrl: string): Promise<{ port: number; origin: string }> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "live-proxy-node.child.ts")],
    target: "node",
    format: "esm",
  });
  if (!build.success) {
    throw new Error(`child build failed: ${build.logs.map((l) => l.message).join("; ")}`);
  }
  childDir = mkdtempSync(join(tmpdir(), "live-proxy-node-test-"));
  const entry = join(childDir, "child.mjs");
  writeFileSync(entry, await build.outputs[0]!.text());
  proxyChild = Bun.spawn(["node", entry], {
    env: {
      ...process.env,
      LIVE_PROXY_TARGET: targetUrl,
      LIVE_PROXY_EDITOR_ORIGINS: EDITOR_ORIGINS.join(","),
      LIVE_PROXY_BRIDGE: BRIDGE_BODY,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = (proxyChild.stdout as ReadableStream<Uint8Array>).getReader();
  let banner = "";
  const timeout = setTimeout(() => reader.cancel().catch(() => {}), 10_000);
  try {
    while (!banner.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      banner += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const line = banner.split("\n")[0] ?? "";
  const parsed = JSON.parse(line) as { port: number };
  return { port: parsed.port, origin: `http://127.0.0.1:${parsed.port}` };
}

beforeAll(async () => {
  upstream = Bun.serve<{ hits: number }, object>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      upstreamHits.push(url.pathname);

      if (url.pathname === "/ws-echo") {
        recordedHeaders["ws-origin"] = req.headers.get("origin");
        if (srv.upgrade(req, { data: { hits: 0 } })) return;
        return new Response("not ws", { status: 400 });
      }

      switch (url.pathname) {
        case "/":
          return new Response(HTML_PAGE, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        case "/no-head":
          return new Response(NO_HEAD_PAGE, {
            headers: { "Content-Type": "text/html" },
          });
        case "/chunked-head-open": {
          // Splits the stream inside the <head ...> open tag.
          const parts = ["<html><hea", "d data-x=\"1\"><title>c</title></head><body>ok</body></html>"];
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const part of parts) {
                controller.enqueue(new TextEncoder().encode(part));
                await Bun.sleep(10);
              }
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/html" } });
        }
        case "/banner-comment":
          return new Response(BANNER_COMMENT_PAGE, {
            headers: { "Content-Type": "text/html" },
          });
        case "/uppercase-content-type":
          // Media types are case-insensitive: this is HTML.
          return new Response(HTML_PAGE, {
            headers: { "Content-Type": "TEXT/HTML; charset=UTF-8", "X-Frame-Options": "DENY" },
          });
        case "/asset.js":
          recordedHeaders["asset-accept-encoding"] = req.headers.get("accept-encoding");
          return new Response("console.log('asset');", {
            headers: { "Content-Type": "text/javascript", "X-Asset-Header": "kept" },
          });
        case "/xfo-asset":
          return new Response("{\"ok\":true}", {
            headers: { "Content-Type": "application/json", "X-Frame-Options": "DENY" },
          });
        case "/binary":
          return new Response(BINARY_BYTES, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        case "/csp":
          return new Response(HTML_PAGE, {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy": "default-src 'self'",
              "Content-Security-Policy-Report-Only": "default-src 'none'",
              "X-Frame-Options": "DENY",
            },
          });
        case "/gzip": {
          const gzipped = Bun.gzipSync(new TextEncoder().encode(HTML_PAGE));
          return new Response(gzipped, {
            headers: {
              "Content-Type": "text/html",
              "Content-Encoding": "gzip",
              "Content-Length": String(gzipped.byteLength),
            },
          });
        }
        case "/sse": {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              await Bun.sleep(150);
              controller.enqueue(new TextEncoder().encode("data: second\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }
        case "/headers":
          recordedHeaders["doc-host"] = req.headers.get("host");
          recordedHeaders["doc-accept-encoding"] = req.headers.get("accept-encoding");
          recordedHeaders["doc-x-forwarded-host"] = req.headers.get("x-forwarded-host");
          recordedHeaders["doc-x-forwarded-proto"] = req.headers.get("x-forwarded-proto");
          return new Response("<html><head></head><body>h</body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        case "/echo-body": {
          const body = await req.text();
          return new Response(body, { headers: { "Content-Type": "text/plain" } });
        }
        case "/redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.1:${srv.port}/after-redirect` },
          });
        case "/relative-redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: "/after-redirect" },
          });
        case "/redirect-alt-spelling":
          return new Response(null, {
            status: 302,
            headers: { Location: `http://localhost:${srv.port}/after-redirect?x=1` },
          });
        case "/redirect-lookalike":
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.1:${srv.port}0/auth` },
          });
        default:
          return new Response("upstream 404", { status: 404 });
      }
    },
    websocket: {
      message(ws, raw) {
        // Echo both text and binary frames.
        ws.send(typeof raw === "string" ? raw : raw);
      },
    },
  });

  proxy = await spawnNodeProxyChild(`http://127.0.0.1:${upstream.port}`);
});

afterAll(() => {
  proxyChild?.kill();
  if (childDir) rmSync(childDir, { recursive: true, force: true });
  upstream.stop(true);
});

describe("node live proxy: HTML injection", () => {
  test("injects exactly one bridge script tag immediately after the head open tag", async () => {
    const html = await (await fetch(proxyUrl("/"))).text();
    expect(html).toContain(INJECT_TAG);
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html.indexOf(`<head>${INJECT_TAG}`)).toBeGreaterThanOrEqual(0);
    // Original content is intact around the injection.
    expect(html.replace(INJECT_TAG, "")).toBe(HTML_PAGE);
  });

  test("no head open tag: appends the tag at end of stream", async () => {
    const html = await (await fetch(proxyUrl("/no-head"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html).toBe(NO_HEAD_PAGE + INJECT_TAG);
  });

  test("head open tag split across upstream chunks still injects once, after the tag", async () => {
    const html = await (await fetch(proxyUrl("/chunked-head-open"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html).toContain(`<head data-x="1">${INJECT_TAG}`);
  });

  test("a comment naming <head> before the real head does not capture the injection", async () => {
    const html = await (await fetch(proxyUrl("/banner-comment"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html).toContain(`<html><head>${INJECT_TAG}`);
    expect(html.replace(INJECT_TAG, "")).toBe(BANNER_COMMENT_PAGE);
  });

  test("an uppercase TEXT/HTML content type is still injected and reframed", async () => {
    const res = await fetch(proxyUrl("/uppercase-content-type"));
    const html = await res.text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
  });
});

describe("node live proxy: header hygiene", () => {
  test("upstream sees its own Host, forwarded headers, and no Accept-Encoding on documents", async () => {
    recordedHeaders = {};
    await (await fetch(proxyUrl("/headers"), {
      headers: { Accept: "text/html", "Accept-Encoding": "gzip, br" },
    })).text();
    expect(recordedHeaders["doc-host"]).toBe(`127.0.0.1:${upstream.port}`);
    expect(recordedHeaders["doc-accept-encoding"]).toBe("identity");
    expect(recordedHeaders["doc-x-forwarded-host"]).toBe(`127.0.0.1:${proxy.port}`);
    expect(recordedHeaders["doc-x-forwarded-proto"]).toBe("http");
  });

  test("asset requests keep their Accept-Encoding", async () => {
    recordedHeaders = {};
    await (await fetch(proxyUrl("/asset.js"), {
      headers: { Accept: "*/*", "Accept-Encoding": "gzip" },
    })).text();
    expect(recordedHeaders["asset-accept-encoding"]).toBe("gzip");
  });

  test("HTML responses lose app CSP and X-Frame-Options and gain our frame-ancestors", async () => {
    const res = await fetch(proxyUrl("/csp"), { headers: { Accept: "text/html" } });
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      `frame-ancestors ${EDITOR_ORIGINS.join(" ")}`,
    );
    expect(await res.text()).toContain(INJECT_TAG);
  });

  test("non-HTML responses keep their headers, CSP-free and with X-Frame-Options intact", async () => {
    const asset = await fetch(proxyUrl("/asset.js"));
    expect(asset.headers.get("x-asset-header")).toBe("kept");
    expect(asset.headers.get("content-security-policy")).toBeNull();
    const xfo = await fetch(proxyUrl("/xfo-asset"));
    expect(xfo.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("node live proxy: passthrough fidelity", () => {
  test("content-encoded HTML passes through unmodified (no injection, body intact)", async () => {
    const raw = await rawHttpRequest(proxy.port, [
      "GET /gzip HTTP/1.1",
      `Host: 127.0.0.1:${proxy.port}`,
      "Accept: text/html",
      "Connection: close",
    ]);
    expect(raw.head).toContain("content-encoding: gzip");
    const expected = Bun.gzipSync(new TextEncoder().encode(HTML_PAGE));
    expect(raw.body.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(raw.body).equals(Buffer.from(expected))).toBe(true);
    const decoded = new TextDecoder().decode(Bun.gunzipSync(raw.body));
    expect(decoded).toBe(HTML_PAGE);
    expect(decoded).not.toContain(INJECT_TAG);
  });

  test("binary assets are byte-identical", async () => {
    const res = await fetch(proxyUrl("/binary"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(BINARY_BYTES))).toBe(true);
  });

  test("request bodies stream upstream (POST echo)", async () => {
    const res = await fetch(proxyUrl("/echo-body"), {
      method: "POST",
      body: "posted-through-proxy",
    });
    expect(await res.text()).toBe("posted-through-proxy");
  });

  test("SSE: the first event is readable before the stream completes", async () => {
    const res = await fetch(proxyUrl("/sse"));
    const reader = res.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstLatency = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain("data: first");
    // The upstream holds the second event for 150ms; getting the first one
    // well under that proves streaming (no full-body buffering).
    expect(firstLatency).toBeLessThan(140);
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("data: second");
  });

  test("redirect Locations: target-origin rewritten (both spellings), others untouched", async () => {
    const own = await fetch(proxyUrl("/redirect"), { redirect: "manual" });
    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toBe(`${proxy.origin}/after-redirect`);

    const relative = await fetch(proxyUrl("/relative-redirect"), { redirect: "manual" });
    expect(relative.headers.get("location")).toBe("/after-redirect");

    const altSpelling = await fetch(proxyUrl("/redirect-alt-spelling"), { redirect: "manual" });
    expect(altSpelling.headers.get("location")).toBe(`${proxy.origin}/after-redirect?x=1`);

    const lookalike = await fetch(proxyUrl("/redirect-lookalike"), { redirect: "manual" });
    expect(lookalike.headers.get("location")).toBe(`http://127.0.0.1:${upstream.port}0/auth`);
  });
});

describe("node live proxy: WebSocket passthrough", () => {
  test("text and binary frames echo through the raw-socket upgrade pipe", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws-echo`);
    const received: (string | Uint8Array)[] = [];
    const gotBoth = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws echo timed out")), 5000);
      ws.addEventListener("message", async (event) => {
        if (typeof event.data === "string") {
          received.push(event.data);
        } else if (event.data instanceof Blob) {
          received.push(new Uint8Array(await event.data.arrayBuffer()));
        } else {
          received.push(new Uint8Array(event.data as ArrayBuffer));
        }
        if (received.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      });
    });
    ws.addEventListener("open", () => {
      ws.send("hello-through-node-proxy");
      ws.send(new Uint8Array([9, 8, 7]));
    });
    await gotBoth;
    expect(received[0]).toBe("hello-through-node-proxy");
    expect(Buffer.from(received[1] as Uint8Array).equals(Buffer.from([9, 8, 7]))).toBe(true);
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    ws.close();
    await closed;
  });

  test("a WS upgrade with a foreign Origin is refused before touching upstream", async () => {
    upstreamHits = [];
    const raw = await rawHttpRequest(proxy.port, [
      "GET /ws-echo HTTP/1.1",
      `Host: 127.0.0.1:${proxy.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Origin: https://evil.example",
    ]);
    expect(raw.head.startsWith("http/1.1 403")).toBe(true);
    expect(upstreamHits).toEqual([]);
  });

  test("a WS upgrade with the proxy's own Origin echoes through, arriving upstream origin-less", async () => {
    recordedHeaders = {};
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws-echo`, {
      headers: { origin: `http://127.0.0.1:${proxy.port}` },
    } as unknown as string[]);
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws echo timed out")), 5000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      });
      ws.addEventListener("open", () => ws.send("origin-ok"));
    });
    expect(echoed).toBe("origin-ok");
    // The upstream connect must be origin-less (the gated, non-browser shape
    // the Bun transport's fresh WebSocket also produces).
    expect(recordedHeaders["ws-origin"]).toBeNull();
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    ws.close();
    await closed;
  });
});

describe("node live proxy: security posture", () => {
  test("a non-localhost Host header gets 403 and never touches upstream", async () => {
    upstreamHits = [];
    const raw = await rawHttpRequest(proxy.port, [
      "GET /headers HTTP/1.1",
      "Host: evil.example",
      "Connection: close",
    ]);
    expect(raw.head.startsWith("http/1.1 403")).toBe(true);
    expect(upstreamHits).toEqual([]);
  });

  test("a Host-less HTTP/1.0 request gets the plain 403, never a runtime error page", async () => {
    upstreamHits = [];
    const raw = await rawHttpRequest(proxy.port, ["GET / HTTP/1.0"]);
    expect(raw.head.startsWith("http/1.0 403") || raw.head.startsWith("http/1.1 403")).toBe(true);
    const body = Buffer.from(raw.body).toString("utf-8");
    expect(body).toBe("Forbidden");
    expect(raw.head).toContain("text/plain");
    expect(upstreamHits).toEqual([]);
  });

  test("the proxy origin and bind are loopback, independent of PLANNOTATOR_REMOTE", () => {
    expect(proxy.origin).toBe(`http://127.0.0.1:${proxy.port}`);
    // The bind is a source-level contract: the literal loopback constant,
    // never getServerHostname() or any env-dependent interface.
    const source = readFileSync(join(import.meta.dir, "live-proxy-node.ts"), "utf-8");
    expect(source).toContain('const LOOPBACK_HOST = "127.0.0.1";');
    expect(source).toContain("server.listen(0, LOOPBACK_HOST");
    expect(source).not.toContain("getServerHostname");
  });

  test("the bridge body is served from the reserved path with no-store", async () => {
    const res = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH));
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe(BRIDGE_BODY);
    expect(body).toContain("tok-node123");
  });

  test("other reserved paths are 404 and never forwarded upstream", async () => {
    upstreamHits = [];
    const res = await fetch(proxyUrl("/__plannotator__/other"));
    expect(res.status).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  test("stop() releases the listener port", async () => {
    // In-process (listener lifecycle only — no upgrade socket involved, so
    // the Bun shim is faithful here): stop must close the listening socket.
    const local = await startLiveAppProxyNode({
      targetUrl: `http://127.0.0.1:${upstream.port}`,
      editorOrigins: EDITOR_ORIGINS,
      bridgeJs: BRIDGE_BODY,
    });
    const before = await fetch(`${local.origin}${LIVE_PROXY_BRIDGE_PATH}`);
    expect(before.status).toBe(200);
    local.stop();
    await expect(fetch(`${local.origin}${LIVE_PROXY_BRIDGE_PATH}`)).rejects.toBeDefined();
  });

  test("bridge.js refuses cross-site and same-site subresource fetches (token exposure)", async () => {
    const crossSite = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH), {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const sameSite = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH), {
      headers: { "sec-fetch-site": "same-site" },
    });
    expect(sameSite.status).toBe(403);
    const sameOrigin = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH), {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
    const navigation = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH), {
      headers: { "sec-fetch-site": "none" },
    });
    expect(navigation.status).toBe(200);
  });
});

/** Minimal raw HTTP/1.1 client: needed to send a forged Host header and to
 * observe exact relayed bytes without fetch's transparent decompression. */
function rawHttpRequest(
  port: number,
  requestLines: string[],
): Promise<{ head: string; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(requestLines.join("\r\n") + "\r\n\r\n");
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split === -1) return;
      const head = all.subarray(0, split).toString("utf-8").toLowerCase();
      const match = head.match(/content-length: (\d+)/);
      if (match && all.length >= split + 4 + Number(match[1])) socket.destroy();
      if (head.includes("transfer-encoding: chunked") && all.includes("\r\n0\r\n")) socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split === -1) {
        reject(new Error("malformed HTTP response"));
        return;
      }
      const head = all.subarray(0, split).toString("utf-8").toLowerCase();
      let body = new Uint8Array(all.subarray(split + 4));
      if (head.includes("transfer-encoding: chunked")) {
        body = decodeChunked(body);
      }
      resolve({ head, body });
    });
    setTimeout(() => {
      socket.destroy();
    }, 2000);
  });
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const buffer = Buffer.from(body);
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = parseInt(buffer.subarray(offset, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(new Uint8Array(buffer.subarray(start, start + size)));
    offset = start + size + 2;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

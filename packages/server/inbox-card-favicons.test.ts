/**
 * A person's web link's favicon, fetched by the Inbox (inbox-card-favicons.ts),
 * over a scripted fetch and DNS (never the network). What regresses: a
 * favicon over 64 KB, of another type (a page, an SVG), from another host by
 * redirect, from a private or loopback address, or past its deadline being
 * served; a miss asked again on every open; a slow host holding the window.
 */
import { describe, expect, test } from "bun:test";
import { createCardFavicons, isPublicAddress, type CardFaviconOptions } from "./inbox-card-favicons";

const ICO = (() => {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 1, 0, 1, 0]);
  return bytes;
})();
const PUBLIC = async () => ["93.184.216.34"];

function scripted(answer: (url: string, init: RequestInit) => Response | Promise<Response>, options: Partial<CardFaviconOptions> = {}) {
  const asked: string[] = [];
  const favicons = createCardFavicons({
    lookup: PUBLIC,
    ...options,
    fetch: async (url, init) => {
      asked.push(url);
      return answer(url, init);
    },
  });
  return { favicons, asked };
}

const icon = (headers: Record<string, string> = { "content-type": "image/x-icon" }) => new Response(ICO, { headers });

describe("card favicons", () => {
  test("serves the host's /favicon.ico as the image its bytes are, and caches it", async () => {
    const { favicons, asked } = scripted(() => icon());
    expect(await favicons.get("example.com")).toEqual({ ok: true, type: "image/x-icon", body: ICO });
    expect(await favicons.get("example.com")).toMatchObject({ ok: true });
    expect(asked).toEqual(["https://example.com/favicon.ico"]);
  });

  test("too big: refused by its content-length, or once it streams past 64 KB", async () => {
    const declared = scripted(() => new Response(ICO, { headers: { "content-type": "image/x-icon", "content-length": String(64 * 1024 + 1) } }));
    expect(await declared.favicons.get("big.example")).toEqual({ ok: false, miss: "too_big" });
    const big = new Uint8Array(64 * 1024 + 1);
    big.set([0, 0, 1, 0, 1, 0]);
    const streamed = scripted(() => new Response(new ReadableStream({ start(c) { c.enqueue(big.slice(0, 40_000)); c.enqueue(big.slice(40_000)); c.close(); } }), { headers: { "content-type": "image/x-icon" } }));
    expect(await streamed.favicons.get("big.example")).toEqual({ ok: false, miss: "too_big" });
    // Exactly at the cap is fine.
    const atCap = new Uint8Array(64 * 1024);
    atCap.set([0, 0, 1, 0, 1, 0]);
    expect(await scripted(() => new Response(atCap, { headers: { "content-type": "image/x-icon" } })).favicons.get("ok.example")).toMatchObject({ ok: true });
  });

  test("wrong type: a page, an SVG, or image bytes that are not an image", async () => {
    expect(await scripted(() => icon({ "content-type": "text/html" })).favicons.get("a.example")).toEqual({ ok: false, miss: "not_image" });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await scripted(() => new Response(svg, { headers: { "content-type": "image/svg+xml" } })).favicons.get("b.example")).toEqual({ ok: false, miss: "not_image" });
    // Declared an icon, but the bytes are SVG (it would run as a page on the Inbox's origin): refused too.
    expect(await scripted(() => new Response(svg, { headers: { "content-type": "image/x-icon" } })).favicons.get("c.example")).toEqual({ ok: false, miss: "not_image" });
    expect(await scripted(() => new Response("<html></html>", { headers: { "content-type": "image/png" } })).favicons.get("d.example")).toEqual({ ok: false, miss: "not_image" });
  });

  test("a redirect may stay on the host; one to another host, or to http, is a miss and is not followed", async () => {
    const same = scripted((url) => (url.endsWith("/favicon.ico") ? new Response(null, { status: 301, headers: { location: "/static/icon.ico" } }) : icon()));
    expect(await same.favicons.get("example.com")).toMatchObject({ ok: true });
    expect(same.asked).toEqual(["https://example.com/favicon.ico", "https://example.com/static/icon.ico"]);
    const off = scripted(() => new Response(null, { status: 302, headers: { location: "https://cdn.example.net/favicon.ico" } }));
    expect(await off.favicons.get("example.com")).toEqual({ ok: false, miss: "redirect_off_host" });
    expect(off.asked).toEqual(["https://example.com/favicon.ico"]);
    const www = scripted(() => new Response(null, { status: 302, headers: { location: "https://www.example.com/favicon.ico" } }));
    expect(await www.favicons.get("example.com")).toEqual({ ok: false, miss: "redirect_off_host" });
    const http = scripted(() => new Response(null, { status: 302, headers: { location: "http://example.com/favicon.ico" } }));
    expect(await http.favicons.get("example.com")).toEqual({ ok: false, miss: "redirect_off_host" });
  });

  test("timeout: one deadline for the whole fetch, and the window gets a miss", async () => {
    const slow = scripted(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      { timeoutMs: 30 },
    );
    const started = Date.now();
    expect(await slow.favicons.get("slow.example")).toEqual({ ok: false, miss: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    // A body that stalls after its headers is cut off by the same deadline.
    const stalled = scripted(() => new Response(new ReadableStream({ start(c) { c.enqueue(ICO.slice(0, 10)); } }), { headers: { "content-type": "image/x-icon" } }), { timeoutMs: 30 });
    expect(await stalled.favicons.get("stall.example")).toEqual({ ok: false, miss: "timeout" });
  });

  test("never a private, loopback or local host: refused before any fetch", async () => {
    for (const [host, addresses] of [
      ["intranet.example", ["10.0.0.5"]],
      ["rebind.example", ["93.184.216.34", "127.0.0.1"]],
      ["v6.example", ["fd12::1"]],
      ["mapped.example", ["::ffff:192.168.1.1"]],
      ["tailnet.example", ["100.101.102.103"]],
      ["metadata.example", ["169.254.169.254"]],
    ] as const) {
      const { favicons, asked } = scripted(() => icon(), { lookup: async () => [...addresses] });
      expect(await favicons.get(host)).toEqual({ ok: false, miss: "not_public" });
      expect(asked).toEqual([]);
    }
    for (const host of ["localhost", "127.0.0.1", "[::1]", "93.184.216.34", "intranet", "printer.local", "dev.localhost"]) {
      const { favicons, asked } = scripted(() => icon());
      expect(await favicons.get(host)).toMatchObject({ ok: false });
      expect(asked).toEqual([]);
    }
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("::1")).toBe(false);
  });

  test("a miss is cached too, for an hour, then asked again", async () => {
    let now = 0;
    const { favicons, asked } = scripted(() => new Response("no", { status: 404 }), { now: () => now });
    expect(await favicons.get("gone.example")).toEqual({ ok: false, miss: "status" });
    expect(await favicons.get("gone.example")).toEqual({ ok: false, miss: "status" });
    expect(asked).toHaveLength(1);
    now = 60 * 60 * 1000;
    await favicons.get("gone.example");
    expect(asked).toHaveLength(2);
  });
});

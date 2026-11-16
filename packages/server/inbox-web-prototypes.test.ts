import { afterEach, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { checkWebFraming, framingOfHeaders, headersOver, isPublicAddress } from "./inbox-web-prototypes";

const stubs: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop(true);
});

function stub(answer: () => Response) {
  const seen: { path: string; headers: Headers }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, headers: req.headers });
      return answer();
    },
  });
  stubs.push(server);
  return { port: server.port as number, seen };
}

const overHttp = (url: URL, address: string, signal: AbortSignal) => headersOver(url, address, signal, httpRequest as unknown as typeof import("node:https").request);

describe("the header check never contacts a non-public address", () => {
  const notPublic = [
    "127.0.0.1",
    "127.8.8.8",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.169.254",
    "100.64.0.1",
    "100.101.102.103",
    "100.127.255.254",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd7a:115c:a1e0::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:100.100.100.100",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
  ];

  test("addresses: loopback, RFC 1918, link-local, Tailscale CGNAT, unique-local IPv6 and IPv4-mapped forms are not public", () => {
    for (const ip of notPublic) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ["93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:93.184.216.34"]) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });

  test("a host that is, or resolves to, a non-public address is never contacted and reads as unknown", async () => {
    const contacted: string[] = [];
    const fetchHeaders = async (url: URL) => {
      contacted.push(url.href);
      return { status: 200, headers: { "x-frame-options": "DENY" } };
    };
    const literal = notPublic.map((ip) => (ip.includes(":") ? `https://[${ip}]/` : `https://${ip}/`));
    const named = ["https://localhost/", "https://box.local/", "https://intranet/", "https://machine.tail1234.ts.net/", "https://app.internal/"];
    for (const href of [...literal, ...named]) {
      expect([href, await checkWebFraming(new URL(href), { resolve: async () => ["93.184.216.34"], fetchHeaders })]).toEqual([href, "unknown"]);
    }
    for (const answer of [["10.0.0.5"], ["100.100.1.1"], ["93.184.216.34", "127.0.0.1"], ["::ffff:192.168.0.1"], []]) {
      expect(await checkWebFraming(new URL("https://preview.example.com/"), { resolve: async () => answer, fetchHeaders })).toBe("unknown");
    }
    expect(contacted).toEqual([]);
  });

  test("it connects to the address it vetted, sends no cookie or credentials, follows no redirect and reads headers only", async () => {
    const moved = stub(() => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:9/elsewhere" } }));
    const pinned: string[] = [];
    const resolve = async (host: string) => {
      pinned.push(host);
      return ["93.184.216.34"];
    };
    const viaStub = (port: number) => (url: URL, address: string, signal: AbortSignal) => {
      expect(address).toBe("93.184.216.34");
      return overHttp(new URL(`http://${url.hostname}:${port}${url.pathname}`), "127.0.0.1", signal);
    };
    expect(await checkWebFraming(new URL("https://preview.example.com/a"), { resolve, fetchHeaders: viaStub(moved.port) })).toBe("unknown");
    expect(moved.seen.map((req) => req.path)).toEqual(["/a"]);

    const refusing = stub(() => new Response("x".repeat(2_000_000), { headers: { "X-Frame-Options": "SAMEORIGIN" } }));
    expect(await checkWebFraming(new URL("https://preview.example.com/b"), { resolve, fetchHeaders: viaStub(refusing.port) })).toBe("not_framed");
    const req = refusing.seen[0]!;
    expect(req.headers.get("cookie")).toBeNull();
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("host")).toBe(`preview.example.com:${refusing.port}`);
    expect(pinned).toEqual(["preview.example.com", "preview.example.com"]);
  });

  test("a check that hangs or fails reads as unknown within the limit", async () => {
    const resolve = async () => ["93.184.216.34"];
    const started = Date.now();
    expect(await checkWebFraming(new URL("https://slow.example.com/"), { resolve, fetchHeaders: () => new Promise(() => {}), timeoutMs: 50 })).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await checkWebFraming(new URL("https://broken.example.com/"), { resolve, fetchHeaders: async () => Promise.reject(new Error("reset")) })).toBe("unknown");
    expect(await checkWebFraming(new URL("https://nxdomain.example.com/"), { resolve: async () => Promise.reject(new Error("ENOTFOUND")) })).toBe("unknown");
  });
});

test("framed, not framed or unknown from the headers", () => {
  const cases: [number, Record<string, string | string[]>, string][] = [
    [200, {}, "framed"],
    [200, { "x-frame-options": "DENY" }, "not_framed"],
    [200, { "x-frame-options": "sameorigin" }, "not_framed"],
    [200, { "x-frame-options": "ALLOW-FROM https://a.example" }, "framed"],
    [200, { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }, "not_framed"],
    [200, { "content-security-policy": "frame-ancestors 'self' https://app.example.com" }, "not_framed"],
    [200, { "content-security-policy": "frame-ancestors *" }, "framed"],
    [200, { "content-security-policy": "frame-ancestors https:" }, "framed"],
    [200, { "content-security-policy": ["frame-ancestors *", "frame-ancestors 'none'"] }, "not_framed"],
    [404, { "x-frame-options": "DENY" }, "not_framed"],
    [301, { location: "https://elsewhere.example/" }, "unknown"],
  ];
  for (const [status, headers, framing] of cases) expect([status, headers, framingOfHeaders(status, headers)]).toEqual([status, headers, framing]);
});

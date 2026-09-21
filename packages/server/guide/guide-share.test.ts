import { describe, expect, test } from "bun:test";
import { decompress } from "@plannotator/shared/compress";
import { decrypt } from "@plannotator/shared/crypto";
import { parseGuideSnapshot } from "@plannotator/shared/guide-format";
import { FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import { GuideShareError, shareGuide, unshareGuide } from "./guide-share";

const SERVICE = "https://guides.example.test";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake guide host: records the request, answers with `respond`. */
function fakeService(respond: (req: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const doFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetch: doFetch };
}

const created = (extra: Record<string, unknown> = {}) =>
  Response.json({ id: "AbCdEfGhIjKlMnOpQrStUv", url: `${SERVICE}/g/AbCdEfGhIjKlMnOpQrStUv`, deleteToken: "tok-1", ...extra }, { status: 201 });

describe("shareGuide", () => {
  test("encrypted (default): posts ciphertext + viewer pin, url carries #key=, and the key decrypts back to the snapshot", async () => {
    const svc = fakeService(() => created());
    const res = await shareGuide(FIXTURE_V1_PR, { serviceUrl: SERVICE, mode: "encrypted", viewer: GUIDE_VIEWER_MANIFEST, fetch: svc.fetch });
    expect(svc.calls.length).toBe(1);
    const [call] = svc.calls;
    expect(call.url).toBe(`${SERVICE}/api/g`);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    const body = call.body as { mode: string; data: string; viewer: Record<string, unknown>; ttlSeconds?: number };
    expect(body.mode).toBe("encrypted");
    expect(body.ttlSeconds).toBeUndefined();
    // The viewer pin is the manifest exactly, and never a base URL (the host uses its own /v1/).
    expect(body.viewer).toEqual(GUIDE_VIEWER_MANIFEST as unknown as Record<string, unknown>);
    expect("baseUrl" in body.viewer).toBe(false);
    // The host sees ciphertext only: nothing about the guide is in the clear.
    expect(body.data).not.toContain(FIXTURE_V1_PR.guide.title);
    expect(body.data).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(res.id).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(res.deleteToken).toBe("tok-1");
    expect(res.expiresAt).toBeUndefined();
    expect(res.bytes).toBe(body.data.length);
    const fragment = new URL(res.url).hash.slice(1);
    const key = new URLSearchParams(fragment).get("key");
    expect(res.url.startsWith(`${SERVICE}/g/AbCdEfGhIjKlMnOpQrStUv#key=`)).toBe(true);
    expect(key).toBeTruthy();
    // The viewer's decode path: decrypt → decompress → parse.
    const restored = parseGuideSnapshot(await decompress(await decrypt(body.data, key!)));
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value).toEqual(FIXTURE_V1_PR);
  });

  test("plain: sends the snapshot JSON, forwards ttlSeconds, url has no key, expiresAt is passed through", async () => {
    const svc = fakeService(() => created({ expiresAt: "2026-08-22T00:00:00.000Z" }));
    const res = await shareGuide(FIXTURE_V1_PR, { serviceUrl: SERVICE, mode: "plain", ttlSeconds: 604800, viewer: GUIDE_VIEWER_MANIFEST, fetch: svc.fetch });
    const body = svc.calls[0].body as { mode: string; data: string; ttlSeconds?: number };
    expect(body.mode).toBe("plain");
    expect(body.ttlSeconds).toBe(604800);
    expect(JSON.parse(body.data)).toEqual(FIXTURE_V1_PR);
    expect(res.url).toBe(`${SERVICE}/g/AbCdEfGhIjKlMnOpQrStUv`);
    expect(res.expiresAt).toBe("2026-08-22T00:00:00.000Z");
    expect(res.bytes).toBe(new TextEncoder().encode(body.data).byteLength);
  });

  test("errors are GuideShareError with the host's status and a usable message", async () => {
    const attempt = (respond: () => Response) =>
      shareGuide(FIXTURE_V1_PR, { serviceUrl: SERVICE, mode: "plain", viewer: GUIDE_VIEWER_MANIFEST, fetch: fakeService(respond).fetch });

    const tooLarge = await attempt(() => Response.json({ error: "too large", maxBytes: 25 * 1024 * 1024 }, { status: 413 })).catch((e) => e);
    expect(tooLarge).toBeInstanceOf(GuideShareError);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.message).toContain("25 MB");

    const bad = await attempt(() => Response.json({ error: "invalid guide", path: "$.guide.title", message: "must be a string" }, { status: 400 })).catch((e) => e);
    expect(bad.status).toBe(400);
    expect(bad.message).toContain("invalid guide");
    expect(bad.message).toContain("$.guide.title");

    const down = await attempt(() => new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" })).catch((e) => e);
    expect(down.status).toBe(502);
    expect(down.message).toContain("Bad Gateway");

    const partial = await attempt(() => Response.json({ id: "x" }, { status: 201 })).catch((e) => e);
    expect(partial).toBeInstanceOf(GuideShareError);
    expect(partial.message).toContain("incomplete");

    const unreachable = await shareGuide(FIXTURE_V1_PR, {
      serviceUrl: SERVICE,
      mode: "plain",
      viewer: GUIDE_VIEWER_MANIFEST,
      fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    }).catch((e) => e);
    expect(unreachable).toBeInstanceOf(GuideShareError);
    expect(unreachable.status).toBeUndefined();
    expect(unreachable.message).toContain(SERVICE);
    expect(unreachable.message).toContain("fetch failed");
  });
});

describe("unshareGuide", () => {
  test("DELETEs with the bearer token and resolves on 204", async () => {
    const svc = fakeService(() => new Response(null, { status: 204 }));
    await unshareGuide("AbCdEfGhIjKlMnOpQrStUv", "tok-1", { serviceUrl: SERVICE, fetch: svc.fetch });
    expect(svc.calls[0].method).toBe("DELETE");
    expect(svc.calls[0].url).toBe(`${SERVICE}/api/g/AbCdEfGhIjKlMnOpQrStUv`);
    expect(svc.calls[0].headers.authorization).toBe("Bearer tok-1");
  });
});

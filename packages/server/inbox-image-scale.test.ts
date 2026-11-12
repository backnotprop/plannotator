import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { inboxImageWidth, isAnimatedPng, scaleInboxImage } from "./inbox-image-scale";
import { inboxImageResponse } from "./inbox-message-images";

const hasImage = typeof (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image === "function";

async function png(width: number, height: number, gray = false): Promise<Uint8Array> {
  const channels = gray ? 1 : 3;
  const raw = new Uint8Array((width * channels + 1) * height);
  if (gray) raw.fill(128);
  for (let y = 0; y < height && !gray; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set([x % 256, y % 256, 90], row + 1 + x * 3);
  }
  if (gray) for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, gray ? 0 : 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function served(bytes: Uint8Array, width: number, height: number) {
  return { ok: true as const, bytes: Buffer.from(bytes), contentType: "image/png", width, height, real: "/work/a.png", named: "/work/a.png", mtime: "2026-11-08T00:00:00.000Z" };
}

const get = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1/api/inbox/messages/x/image?path=a.png", { headers });

describe("the width a request asks for", () => {
  test("only the widths the window uses count; anything else is the original", () => {
    const at = (query: string) => inboxImageWidth(new URL(`http://127.0.0.1/api/inbox/attachments/att_x/image${query}`));
    expect(at("?w=1600")).toBe(1600);
    expect(at("?version=sent&w=128")).toBe(128);
    expect(at("?w=800")).toBe(800);
    expect(at("")).toBeNull();
    expect(at("?w=4000")).toBeNull();
    expect(at("?w=abc")).toBeNull();
  });

  test("an animated PNG is told from a still one by its acTL chunk before the first IDAT", () => {
    const chunk = (type: string, data = new Uint8Array(0)) => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(data, 8);
      return out;
    };
    const file = (...types: string[]) => {
      const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", new Uint8Array(13)), ...types.map((t) => chunk(t))];
      return new Uint8Array(parts.flatMap((p) => [...p]));
    };
    expect(isAnimatedPng(file("acTL", "IDAT"))).toBe(true);
    expect(isAnimatedPng(file("IDAT", "IEND"))).toBe(false);
    expect(isAnimatedPng(file("IDAT", "acTL"))).toBe(false);
  });
});

describe.if(hasImage)("a message's picture asked for at a width", () => {
  test("a wider PNG comes back that wide as WebP, with an ETag of its own that answers 304", async () => {
    const original = await png(2400, 1200);
    const response = await inboxImageResponse(get(), served(original, 2400, 1200), 1600);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-image-width")).toBe("1600");
    expect(response.headers.get("x-image-height")).toBe("800");
    const etag = response.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}-w1600"$/);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBeLessThan(original.byteLength);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const again = await inboxImageResponse(get({ "if-none-match": etag }), served(original, 2400, 1200), 1600);
    expect(again.status).toBe(304);
    const plainTag = (await inboxImageResponse(get(), served(original, 2400, 1200))).headers.get("etag")!;
    expect((await inboxImageResponse(get({ "if-none-match": plainTag }), served(original, 2400, 1200), 1600)).status).toBe(200);
  });

  test("no width, a picture already that narrow, or an animated PNG: the original, byte for byte", async () => {
    const original = await png(1200, 600);
    for (const to of [null, 1600]) {
      const response = await inboxImageResponse(get(), served(original, 1200, 600), to);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    }
    const wide = await png(2000, 100);
    const actl = new Uint8Array([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const animated = new Uint8Array([...wide.subarray(0, 33), ...actl, ...wide.subarray(33)]);
    const response = await inboxImageResponse(get(), served(animated, 2000, 100), 1600);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(animated);
  });
});

describe.if(hasImage)("the scaling work is bounded", () => {
  test("the same copy asked for twice at once is scaled once", async () => {
    const original = await png(2400, 1200);
    const [a, b] = await Promise.all([scaleInboxImage(original, "image/png", 800, "same-key"), scaleInboxImage(original, "image/png", 800, "same-key")]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  test("a very tall picture is scaled to fit WebP's limit", async () => {
    const original = await png(1700, 25000, true);
    const scaled = await scaleInboxImage(original, "image/png", 1600, "tall-key");
    expect(scaled).not.toBeNull();
    expect(scaled!.height).toBeLessThanOrEqual(16383);
    expect(scaled!.width).toBeLessThan(1600);
  });

  test("a picture past the pixel cap is not decoded to be scaled", async () => {
    const original = await png(8000, 6400, true);
    const started = performance.now();
    expect(await scaleInboxImage(original, "image/png", 1600, "big-key")).toBeNull();
    expect(await scaleInboxImage(original, "image/png", 1600, "big-key")).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { FACE_FAVICON_PNG_BYTES, FAVICON_PNG_BYTES, P_FAVICON_PNG_BYTES } from "../packages/core/favicon";

// The two server-served entry points declare no type/sizes: their /favicon.png
// is answered by handleFavicon(), which picks PNG or the classic SVG from the
// persisted style, so the response Content-Type is the only truthful
// declaration. A re-added type="image/png" would be a lie for classic users.
const SERVED_FAVICON_LINK = '<link rel="icon" href="/favicon.png">';
// The portal is a static site with no Plannotator server, so its favicon really
// is always the 192px PNG the vite plugin emits and it keeps the typed hints.
const STATIC_FAVICON_LINK =
  '<link rel="icon" type="image/png" sizes="192x192" href="/favicon.png">';
// The marketing site serves the brand studio's web set as plain files, linked
// with the studio's own head snippet (the .ico first, so non-retina tabs get
// the hand-pixelled 16). It has no web manifest, so the manifest line is left out.
const MARKETING_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
];
// The studio's files, byte for byte. Never redrawn, resized or re-encoded here.
const MARKETING_ICON_SHA256: Record<string, string> = {
  "apps/marketing/public/favicon.ico":
    "7402e8509ac4ab49194fa387ab0722766cfab5ab94230c798facfd0e97771c59",
  "apps/marketing/public/favicon.svg":
    "47cb128c12a479dd1f5d13fe56be141393b04c845e5a7fd6941538a951bd9fd6",
  "apps/marketing/public/apple-touch-icon.png":
    "5f5d84c3c72bf0acbcc6e634e037108754794ff9f9c8e3b596d0e7b7c088f4fb",
  // Not linked from the head. Outside sites and caches still ask for
  // https://plannotator.ai/favicon.png, so that URL keeps answering, now with
  // the studio's web/icon-512.png.
  "apps/marketing/public/favicon.png":
    "801d533f995fa75efd4d3521fabeb90e98427a444b61f125d91a471c26745333",
};

interface PngStats {
  width: number;
  height: number;
  transparentPixels: number;
  partialAlphaPixels: number;
  opaquePixels: number;
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function inspectPng(bytes: Uint8Array): PngStats {
  const buffer = Buffer.from(bytes);
  expect(Array.from(buffer.subarray(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  expect(buffer[24]).toBe(8);
  // Colour type 2 is RGB, 6 is RGBA. The studio's file decides which.
  const colorType = buffer[25];
  expect([2, 6]).toContain(colorType);
  expect(buffer[28]).toBe(0);

  const idatChunks: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    if (chunkType === "IDAT") {
      idatChunks.push(buffer.subarray(offset + 8, offset + 8 + chunkLength));
    }
    offset += chunkLength + 12;
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    expect(filter).toBeLessThanOrEqual(4);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel
          ? pixels[(y - 1) * stride + x - bytesPerPixel]
          : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : filter === 4
                ? paethPredictor(left, above, upperLeft)
                : 0;
      pixels[y * stride + x] = (inflated[inputOffset] + predictor) & 0xff;
      inputOffset += 1;
    }
  }

  let transparentPixels = 0;
  let partialAlphaPixels = 0;
  let opaquePixels = 0;
  for (let offset = bytesPerPixel - 1; offset < pixels.length; offset += bytesPerPixel) {
    const alpha = colorType === 6 ? pixels[offset] : 0xff;
    if (alpha === 0) transparentPixels += 1;
    else if (alpha === 0xff) opaquePixels += 1;
    else partialAlphaPixels += 1;
  }

  return { width, height, transparentPixels, partialAlphaPixels, opaquePixels };
}

async function readRepoFile(path: string): Promise<Buffer> {
  return readFile(new URL(`../${path}`, import.meta.url));
}

describe("favicon surfaces", () => {
  test("every product HTML entry point references the expected favicon", async () => {
    for (const path of ["apps/hook/index.html", "apps/review/index.html", "apps/inbox/index.html"]) {
      const html = (await readRepoFile(path)).toString();
      expect(html).toContain(SERVED_FAVICON_LINK);
      expect(html).not.toContain('rel="icon" type=');
    }

    expect((await readRepoFile("apps/portal/index.html")).toString()).toContain(
      STATIC_FAVICON_LINK,
    );

    for (const path of [
      "apps/marketing/src/layouts/Base.astro",
      "apps/marketing/public/tui-annotate/index.html",
    ]) {
      const html = (await readRepoFile(path)).toString();
      for (const link of MARKETING_FAVICON_LINKS) expect(html).toContain(link);
      expect(html).not.toContain("/favicon.png");
    }
  });

  test("the share portal emits its favicon from the shared application asset", async () => {
    const portalConfig = (await readRepoFile("apps/portal/vite.config.ts")).toString();
    expect(portalConfig).toContain("fileName: 'favicon.png'");
    expect(portalConfig).toContain("source: FAVICON_PNG_BYTES");
  });

  test("the shared application favicon is the studio's 192px goggles icon", () => {
    expect(createHash("sha256").update(FAVICON_PNG_BYTES).digest("hex")).toBe(
      "f4616566aad3e00fc8c04ebb1dcae8e4ebcd671af99db7fc50e50eefa09a05a5",
    );
    const stats = inspectPng(FAVICON_PNG_BYTES);
    expect(stats).toMatchObject({ width: 192, height: 192 });
    // A full tile: most pixels are opaque whatever the finish.
    expect(stats.opaquePixels).toBeGreaterThan((192 * 192) / 2);
  });

  test("the Face and P styles are their pinned PNGs", () => {
    // The other two things /favicon.png can answer with, so they belong in this
    // enumeration alongside the default. Face is the icon PR 2975 replaced
    // (eede4aecf^1); P is the studio's P icon-192.png.
    expect(createHash("sha256").update(FACE_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "8467d50dba314f3b72ab73ba37d406baabd8d74ed72529e853613442a8c65073",
    );
    expect(inspectPng(FACE_FAVICON_PNG_BYTES)).toMatchObject({ width: 64, height: 64 });
    expect(createHash("sha256").update(P_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "f6bed7f06a78ae9d4de3d2019e7704ca447f9629c85d868ca77f5a25af82b4f8",
    );
    expect(inspectPng(P_FAVICON_PNG_BYTES)).toMatchObject({ width: 192, height: 192 });
  });

  test("the marketing site ships the studio's web icon set unchanged", async () => {
    for (const [path, sha256] of Object.entries(MARKETING_ICON_SHA256)) {
      const bytes = await readRepoFile(path);
      expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(sha256);
    }
    const touch = inspectPng(await readRepoFile("apps/marketing/public/apple-touch-icon.png"));
    expect(touch).toMatchObject({ width: 180, height: 180 });
    const legacy = inspectPng(await readRepoFile("apps/marketing/public/favicon.png"));
    expect(legacy).toMatchObject({ width: 512, height: 512 });
  });
});

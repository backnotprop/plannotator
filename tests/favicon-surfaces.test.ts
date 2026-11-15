import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { FACE_FAVICON_PNG_BYTES, FAVICON_ICO_BYTES, FAVICON_PNG_BYTES, YELLOW_FAVICON_ICO_BYTES, YELLOW_FAVICON_PNG_BYTES } from "../packages/core/favicon";

// The server-served entry points link /favicon.ico with its sizes and no type:
// handleFavicon() answers Glass's multi-size .ico (the tab takes its
// hand-pixelled 16 or 32 frame, as on plannotator.ai) or the Face or P PNG,
// from the persisted style, so the response Content-Type is the truthful
// declaration. A type="image/x-icon" would be a lie for Face users.
const SERVED_FAVICON_LINK = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">';
// The portal is a static site with no Plannotator server, so its favicon really
// is always the Glass .ico the vite plugin emits and it keeps the typed hint.
const STATIC_FAVICON_LINK =
  '<link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="/favicon.ico">';
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
      expect(html).not.toContain('href="/favicon.png"');
    }

    expect((await readRepoFile("apps/portal/index.html")).toString()).toContain(
      STATIC_FAVICON_LINK,
    );

    // Only the Inbox is installed as an app: its server answers the manifest
    // and the touch icon (packages/server/inbox-app-icons.ts).
    const inbox = (await readRepoFile("apps/inbox/index.html")).toString();
    expect(inbox).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(inbox).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');

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
    expect(portalConfig).toContain("fileName: 'favicon.ico'");
    expect(portalConfig).toContain("source: FAVICON_ICO_BYTES");
    expect(portalConfig).toContain("fileName: 'favicon.png'");
    expect(portalConfig).toContain("source: FAVICON_PNG_BYTES");
  });

  test("the apps' tab icon is the same .ico plannotator.ai serves, byte for byte", async () => {
    // The bug this pins: the apps used the 192px PWA icon, a full square the
    // browser shrank, while plannotator.ai showed the hand-pixelled 16 and 32.
    const marketing = await readRepoFile("apps/marketing/public/favicon.ico");
    expect(Buffer.from(FAVICON_ICO_BYTES).equals(marketing)).toBe(true);
    expect(createHash("sha256").update(FAVICON_ICO_BYTES).digest("hex")).toBe(
      "7402e8509ac4ab49194fa387ab0722766cfab5ab94230c798facfd0e97771c59",
    );
  });

  test("/favicon.png is the studio's hand-pixelled 32 build", () => {
    expect(createHash("sha256").update(FAVICON_PNG_BYTES).digest("hex")).toBe(
      "02dd9afe0ab91344168142cc4aa7cdac952e2f88e1cd55c089798b7f79520d2b",
    );
    const stats = inspectPng(FAVICON_PNG_BYTES);
    expect(stats).toMatchObject({ width: 32, height: 32 });
    // The studio's slightly rounded tile: its corners are transparent.
    expect(stats.transparentPixels).toBeGreaterThan(0);
    expect(stats.opaquePixels).toBeGreaterThan((32 * 32) / 2);
  });

  test("the Yellow and Face styles are their pinned icons", () => {
    // The other two things /favicon.png can answer with, so they belong in this
    // enumeration alongside the default. Yellow is the yellow glass set's
    // pixel/fav-32.png (and its web/favicon.ico for /favicon.ico); Face is the
    // icon PR 2975 replaced (eede4aecf^1).
    expect(createHash("sha256").update(YELLOW_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "22f9b788ee9ce33caf76521b7c1e8962b82964805c54cbc139b072e7b2ba73db",
    );
    expect(inspectPng(YELLOW_FAVICON_PNG_BYTES)).toMatchObject({ width: 32, height: 32 });
    expect(createHash("sha256").update(YELLOW_FAVICON_ICO_BYTES).digest("hex")).toBe(
      "2c5bbca9b41885f9d07b8b17b50b65e88e236760888ede779192ccb59ff1f8e4",
    );
    expect(createHash("sha256").update(FACE_FAVICON_PNG_BYTES).digest("hex")).toBe(
      "8467d50dba314f3b72ab73ba37d406baabd8d74ed72529e853613442a8c65073",
    );
    expect(inspectPng(FACE_FAVICON_PNG_BYTES)).toMatchObject({ width: 64, height: 64 });
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

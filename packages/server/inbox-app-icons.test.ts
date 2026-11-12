import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { INBOX_APP_ICON_PATHS, inboxAppIconResponse, inboxManifest } from "./inbox-app-icons";

const ICON_SHA256: Record<string, string> = {
  "glass-180.png": "5f5d84c3c72bf0acbcc6e634e037108754794ff9f9c8e3b596d0e7b7c088f4fb",
  "glass-192.png": "f4616566aad3e00fc8c04ebb1dcae8e4ebcd671af99db7fc50e50eefa09a05a5",
  "glass-512.png": "801d533f995fa75efd4d3521fabeb90e98427a444b61f125d91a471c26745333",
  "yellow-192.png": "0e835dfe38d80c017ba035bce675ec5d346262e7ee8e8a2c3c2baedfbad4c99c",
  "face-256.png": "4e99a26b076e421f654df83472c6186b62830d5db8fcd8e97d01947dffac28fd",
};

type Icon = { src: string; sizes: string; type: string };
const icons = (style: unknown) => inboxManifest(style).icons as Icon[];

function pngSize(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

async function served(path: string, style: unknown): Promise<{ status: number; type: string | null; bytes: Uint8Array }> {
  const response = inboxAppIconResponse(path, style)!;
  return { status: response.status, type: response.headers.get("content-type"), bytes: new Uint8Array(await response.arrayBuffer()) };
}

describe("the Inbox's web app manifest", () => {
  test("every icon it names is served as a PNG of the size it declares, in each favicon style", async () => {
    for (const style of ["glass", "yellow", "totman"]) {
      expect(icons(style).length).toBeGreaterThan(0);
      for (const icon of icons(style)) {
        const answer = await served(icon.src, style);
        expect(answer.status).toBe(200);
        expect(answer.type).toBe("image/png");
        expect(pngSize(answer.bytes)).toBe(icon.sizes);
      }
    }
  });

  test("the icons follow the favicon style, Glass for anything that is not a style", () => {
    const names = (style: unknown) => icons(style).map((icon) => icon.src);
    expect(names("glass")).toEqual(["/app-icon/glass-192.png", "/app-icon/glass-512.png"]);
    expect(names("yellow")).toEqual(["/app-icon/yellow-192.png"]);
    expect(names("totman")).toEqual(["/app-icon/face-256.png"]);
    expect(names("classic")).toEqual(names("glass"));
    expect(names(undefined)).toEqual(names("glass"));
  });

  test("the manifest is served as a manifest, and the touch icon is the style's", async () => {
    const manifest = inboxAppIconResponse("/manifest.webmanifest", "yellow")!;
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
    expect(await manifest.json()).toEqual(inboxManifest("yellow"));
    expect(pngSize((await served("/apple-touch-icon.png", "glass")).bytes)).toBe("180x180");
    expect(pngSize((await served("/apple-touch-icon.png", "totman")).bytes)).toBe("256x256");
  });

  test("the icons are the studio's files, byte for byte", async () => {
    expect(Object.keys(INBOX_APP_ICON_PATHS).sort()).toEqual(Object.keys(ICON_SHA256).sort());
    for (const [name, sha256] of Object.entries(ICON_SHA256)) {
      const bytes = (await served(`/app-icon/${name}`, "glass")).bytes;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    }
  });

  test("only the listed names are served, and other paths are left to the server", async () => {
    expect((await served("/app-icon/../inbox.ts", "glass")).status).toBe(404);
    expect((await served("/app-icon/toString", "glass")).status).toBe(404);
    expect(inboxAppIconResponse("/favicon.png", "glass")).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize, SnapshotsStore, type PendingSend } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-snapshots-store-"));
  roots.push(root);
  const store = new SnapshotsStore(join(root, "data"));
  const file = (name: string, bytes: Uint8Array | string) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };
  return { root, store, file, collection: store.createCollection(null) };
}

const send = (sendId: string): PendingSend => ({ v: 1, sendId, collectionId: "hc-1", host: "claude-code", sessionId: "s", text: "t", files: [], createdAt: "now" });

describe("imageSize", () => {
  test("needs the whole PNG signature and IHDR, or a JPEG start", () => {
    expect(imageSize(png(3, 2))).toEqual({ width: 3, height: 2 });
    const truncatedSignature = png(3, 2);
    truncatedSignature[5] = 0;
    expect(imageSize(truncatedSignature)).toBeNull();
    const noIhdr = png(3, 2);
    noIhdr[12] = 0x58;
    expect(imageSize(noIhdr)).toBeNull();
    expect(imageSize(png(0, 2))).toBeNull();
    expect(imageSize(new TextEncoder().encode("\x89PNG but really a text file with enough bytes to pass"))).toBeNull();
  });
});

describe("addSnapshot", () => {
  test("takes the size from the header and refuses a caller's size that disagrees", () => {
    const h = setup();
    const snapshot = h.store.addSnapshot(h.collection, { captureId: "c1", file: h.file("a.png", png(64, 48)), kind: "region" });
    expect(snapshot.original).toEqual({ file: "original.png", width: 64, height: 48 });
    expect(() => h.store.addSnapshot(h.collection, { captureId: "c2", file: h.file("b.png", png(64, 48)), kind: "region", width: 640, height: 480 })).toThrow();
    expect(() => h.store.addSnapshot(h.collection, { captureId: "c3", file: h.file("c.txt", "hello"), kind: "region", width: 5, height: 1 })).toThrow("Not a PNG or JPEG image.");
    expect(h.collection.snapshots).toHaveLength(1);
  });

  test("names the stored file by its bytes, not its extension", () => {
    const h = setup();
    const snapshot = h.store.addSnapshot(h.collection, { captureId: "c1", file: h.file("looks.jpg", png(8, 8)), kind: "region" });
    expect(snapshot.original.file).toBe("original.png");
  });

  test("window text comes only from incoming/, and never through a symlink", () => {
    const h = setup();
    const outside = h.file("private.txt", "secret");
    expect(() => h.store.addSnapshot(h.collection, { captureId: "c1", file: h.file("a.png", png(8, 8)), kind: "app", textFile: outside })).toThrow();
    const link = join(h.store.incomingDir, "link.txt");
    symlinkSync(outside, link);
    expect(() => h.store.addSnapshot(h.collection, { captureId: "c2", file: h.file("b.png", png(8, 8)), kind: "app", textFile: link })).toThrow();
    const inside = join(h.store.incomingDir, "text.txt");
    writeFileSync(inside, "AXWindow  Title");
    const snapshot = h.store.addSnapshot(h.collection, { captureId: "c3", file: h.file("c.png", png(8, 8)), kind: "app", textFile: inside });
    expect(h.store.readRawText(snapshot)).toBe("AXWindow  Title");
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("pending sends", () => {
  test("a send id that is not a plain name never becomes a path", () => {
    const h = setup();
    expect(() => h.store.savePendingSend(send("../escaped"))).toThrow();
    expect(() => h.store.savePendingSend(send("a/b"))).toThrow();
    h.store.removePendingSend("../hub");
    h.store.savePendingSend(send("hs-ok"));
    expect(readdirSync(h.store.sendsDir)).toEqual(["hs-ok.json"]);
    expect(existsSync(join(h.store.root, "escaped.json"))).toBe(false);
  });

  test("a file under sends/ whose content names another id is ignored on load", () => {
    const h = setup();
    mkdirSync(h.store.sendsDir, { recursive: true });
    writeFileSync(join(h.store.sendsDir, "hs-a.json"), JSON.stringify(send("../../evil")));
    writeFileSync(join(h.store.sendsDir, "hs-b.json"), JSON.stringify(send("hs-c")));
    h.store.savePendingSend(send("hs-d"));
    expect(h.store.pendingSends().map((entry) => entry.sendId)).toEqual(["hs-d"]);
  });
});

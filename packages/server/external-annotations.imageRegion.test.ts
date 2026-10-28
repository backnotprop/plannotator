/**
 * `imageRegion` at the external-annotation boundary (#2100), Bun runtime; the
 * Node mirror is apps/pi-extension/server/external-annotations.imageRegion.test.ts.
 * POST and PATCH run the same fail-closed parser the export and the archive
 * run: a region whose box leaves the image, or that is not whole pixels, is
 * refused (400), never stored where the viewer would draw it and the export
 * would hand it to the agent; a PATCH may change a region, never clear it.
 */
import { describe, expect, test } from "bun:test";
import { createExternalAnnotationHandler } from "./external-annotations";

const REGION = { v: 1, src: "figures/status-colors.png", sourceLine: 6, box: { x: 1820, y: 380, w: 420, h: 160 }, naturalWidth: 3664, naturalHeight: 1453 };
const BASE = "http://localhost/api/external-annotations";

async function call(handler: ReturnType<typeof createExternalAnnotationHandler>, method: string, url: string, body?: unknown) {
  const res = await handler.handle(
    new Request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL(url),
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, any> };
}

const stored = async (handler: ReturnType<typeof createExternalAnnotationHandler>, id: string) =>
  ((await call(handler, "GET", BASE)).body.annotations as Array<{ id: string; imageRegion?: unknown }>).find((a) => a.id === id);

describe("external annotations: imageRegion (Bun)", () => {
  test("POST stores a valid region, normalized, and refuses a malformed one", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const ok = await call(handler, "POST", BASE, { source: "bot", type: "COMMENT", text: "grey", originalText: REGION.src, imageRegion: { ...REGION, extra: 1 } });
    expect(ok.status).toBe(201);
    expect((await stored(handler, ok.body.ids[0]))?.imageRegion).toEqual(REGION);
    for (const bad of [{ ...REGION, box: { ...REGION.box, x: 3500 } }, { ...REGION, v: 2 }, { ...REGION, src: "a\nb" }, "region"]) {
      const res = await call(handler, "POST", BASE, { source: "bot", type: "COMMENT", text: "grey", originalText: REGION.src, imageRegion: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("imageRegion");
    }
  });

  test("PATCH validates, normalizes, and refuses to clear a region", async () => {
    const handler = createExternalAnnotationHandler("plan");
    const added = handler.addAnnotations({ source: "bot", type: "COMMENT", text: "grey", originalText: REGION.src, imageRegion: REGION });
    if ("error" in added) throw new Error(added.error);
    const id = added.ids[0]!;
    const url = `${BASE}?id=${id}`;
    expect((await call(handler, "PATCH", url, { imageRegion: null })).status).toBe(400);
    expect((await call(handler, "PATCH", url, { imageRegion: { ...REGION, box: { x: 0, y: 0, w: 0, h: 1 } } })).status).toBe(400);
    expect((await stored(handler, id))?.imageRegion).toEqual(REGION);
    const moved = { ...REGION, box: { x: 10, y: 20, w: 30, h: 40 } };
    const ok = await call(handler, "PATCH", url, { imageRegion: { ...moved, stowaway: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.annotation.imageRegion).toEqual(moved);
  });
});

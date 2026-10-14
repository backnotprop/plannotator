import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_IMAGE_CSP } from "@plannotator/shared/local-image";
import { handleImage, handleUpload } from "./shared-handlers";

// /api/image serves any local file with an image extension, SVG included. An
// SVG opened directly is a document; every answer must keep it sandboxed.
function expectProtected(res: Response): void {
  expect(res.headers.get("content-security-policy")).toBe(LOCAL_IMAGE_CSP);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

function get(path: string, base?: string): Promise<Response> {
  const url = new URL("http://localhost/api/image");
  url.searchParams.set("path", path);
  if (base) url.searchParams.set("base", base);
  return handleImage(new Request(url));
}

describe("/api/image response headers (Bun)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plannotator-local-image-"));
    writeFileSync(join(dir, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    writeFileSync(join(dir, "pic.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an SVG is served sandboxed with its image type", async () => {
    const res = await get(join(dir, "pic.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expectProtected(res);
    expect(await res.text()).toContain("<svg");
  });

  test("a PNG is served with the same headers and its bytes unchanged", async () => {
    const res = await get(join(dir, "pic.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expectProtected(res);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("a path resolved against base carries the headers", async () => {
    const res = await get("pic.svg", dir);
    expect(res.status).toBe(200);
    expectProtected(res);
  });

  test("refusals carry the headers too", async () => {
    const missingParam = await handleImage(new Request("http://localhost/api/image"));
    expect(missingParam.status).toBe(400);
    expectProtected(missingParam);
    const notImage = await get(join(dir, "notes.html"));
    expect(notImage.status).toBe(403);
    expectProtected(notImage);
    const missing = await get(join(dir, "missing.svg"));
    expect(missing.status).toBe(404);
    expectProtected(missing);
  });

  test("an uploaded SVG is served back sandboxed", async () => {
    const form = new FormData();
    form.set("file", new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "drawing.svg", { type: "image/svg+xml" }));
    const upload = await handleUpload(new Request("http://localhost/api/upload", { method: "POST", body: form }));
    expect(upload.status).toBe(200);
    const { path } = (await upload.json()) as { path: string };
    try {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expectProtected(res);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

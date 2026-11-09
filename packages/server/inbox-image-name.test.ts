/**
 * A picture a message shows (and a Markdown attachment's picture) is served
 * `inline` under the name the body gave it (inboxImageResponse): a browser's
 * Save Image As saves "empty-cart.png", not "image.png" (the route's last
 * segment). The handler is called directly; no Inbox starts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInboxMessageImageAsync } from "@plannotator/shared/inbox/message-images";
import { inboxImageResponse } from "./inbox-message-images";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A PNG's signature and IHDR (2 x 3 px): enough for the sniffer and the dimension read. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-imgname-")));
  roots.push(root);
  mkdirSync(join(root, "shots"));
  return root;
}

async function serve(root: string, body: string, path: string, method = "GET"): Promise<Response> {
  const result = await readInboxMessageImageAsync({ body, root, base: null, path, anywhere: true });
  return inboxImageResponse(new Request(`http://127.0.0.1/api/inbox/messages/msg_x/image?path=${encodeURIComponent(path)}`, { method }), result);
}

test("a picture in a message's text is served inline under its own file name", async () => {
  const root = project();
  writeFileSync(join(root, "shots", "empty-cart.png"), png());
  const res = await serve(root, "![Empty cart](shots/empty-cart.png)", "shots/empty-cart.png");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="empty-cart.png"; filename*=UTF-8''empty-cart.png`);
  // HEAD and a revalidation (304) carry the same name.
  expect((await serve(root, "![Empty cart](shots/empty-cart.png)", "shots/empty-cart.png", "HEAD")).headers.get("Content-Disposition")).toContain('filename="empty-cart.png"');
  const etag = res.headers.get("ETag")!;
  const result = await readInboxMessageImageAsync({ body: "![x](shots/empty-cart.png)", root, base: null, path: "shots/empty-cart.png", anywhere: true });
  const again = await inboxImageResponse(new Request("http://127.0.0.1/x", { headers: { "If-None-Match": etag } }), result);
  expect(again.status).toBe(304);
  expect(again.headers.get("Content-Disposition")).toContain('filename="empty-cart.png"');
});

test("the name is the one the body wrote, not a symlink's target; a non-ASCII name keeps an ASCII fallback", async () => {
  const root = project();
  writeFileSync(join(root, "shots", "3f9a0c.png"), png());
  symlinkSync(join(root, "shots", "3f9a0c.png"), join(root, "shots", "Bestellübersicht.png"));
  const res = await serve(root, "![Order](shots/Bestellübersicht.png)", "shots/Bestellübersicht.png");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="Bestell_bersicht.png"; filename*=UTF-8''Bestell%C3%BCbersicht.png`);
});

test("a refused picture carries no file name", async () => {
  const root = project();
  const res = await serve(root, "![gone](shots/gone.png)", "shots/gone.png");
  expect(res.status).toBe(404);
  expect(res.headers.get("Content-Disposition")).toBeNull();
});

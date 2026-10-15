/**
 * The relay never holds a whole large answer: a body over the bound is
 * refused from its Content-Length before a byte is read, and a body without a
 * length is read only until the count passes the bound, then cancelled.
 */
import { expect, test } from "bun:test";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { RELAY_BODY_LIMIT, RELAY_WEBSOCKET_MESSAGE_LIMIT, readRelayBody, sealRelayResult } from "./inbox-relay";

/** A stream of `chunks` chunks of `size` bytes that counts what was pulled and whether it was cancelled. */
function counted(chunks: number, size: number) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= chunks) return controller.close();
      seen.pulled += 1;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

test("the bound is 3/4 of Cloudflare's 32 MiB message (base64 grows a body by 4/3)", () => {
  expect(RELAY_BODY_LIMIT).toBe(24 * 1024 * 1024);
});

test("a Content-Length over the bound is refused before anything is read", async () => {
  const { stream, seen } = counted(100, 1024);
  const answer = new Response(stream, { headers: { "Content-Length": String(RELAY_BODY_LIMIT + 1) } });
  expect(await readRelayBody(answer, RELAY_BODY_LIMIT)).toBeNull();
  // At most the one chunk a ReadableStream pulls ahead to fill its queue; nothing consumed.
  expect(seen.pulled).toBeLessThanOrEqual(1);
});

test("a body without a length is read only until it passes the bound, then cancelled", async () => {
  const cap = 10 * 1024;
  const { stream, seen } = counted(1000, 1024);
  const answer = new Response(stream);
  expect(answer.headers.get("content-length")).toBeNull();
  expect(await readRelayBody(answer, cap)).toBeNull();
  expect(seen.cancelled).toBe(true);
  expect(seen.pulled).toBeLessThanOrEqual(12);
});

test("a body within the bound is returned whole", async () => {
  const { stream } = counted(4, 1000);
  const bytes = await readRelayBody(new Response(stream), 10_000);
  expect(bytes?.length).toBe(4000);
  expect((await readRelayBody(new Response(null), 10))?.length).toBe(0);
});

test("a message image at the 10 MB cap fits one result frame: both base64 layers and the seal stay under Cloudflare's 32 MiB message", async () => {
  expect(MAX_REVIEW_IMAGE_PREVIEW_BYTES).toBeLessThanOrEqual(RELAY_BODY_LIMIT);
  const key = Buffer.alloc(32, 7).toString("base64url");
  const frame = await sealRelayResult("dev_x", "cmd_x", 200, "image/png", Buffer.alloc(MAX_REVIEW_IMAGE_PREVIEW_BYTES, 0xab), key);
  expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(RELAY_WEBSOCKET_MESSAGE_LIMIT);
  // About 16/9 of the body (17.8 MiB): the frame limit has room.
  expect(Buffer.byteLength(frame)).toBeLessThan(18 * 1024 * 1024);
});

/**
 * A held answer's file on the real wire (inbox-outbox-file-lane.ts `uploadOutboxFile` through PeerLink's upload and
 * the tailnet transport's real `fetch`): real sockets on 127.0.0.1, port 0, opened in this test (no Inbox). What
 * regresses: a body that `fetch` reads whole before the socket takes it (Bun's `fetch` does that to a stream whose
 * pull answers at once, and waits on one whose pull is async, as the lane's is: then the idle limit would measure
 * disk reads, a stalled line would look like progress and the whole file would sit in memory), a slow reader cut
 * off, a stopped reader never noticed, the file's handle left open, the door's answer misread.
 *
 * Two listeners: Bun.serve, as the door is (it reads a request's body into memory whatever its handler does, so it
 * cannot stop the socket), and a plain `node:net` one that reads at the socket's own pace or stops reading, which is
 * what a slow or stalled line looks like to the sender.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxOutbox } from "./inbox-outbox";
import { uploadOutboxFile, type OutboxFileUpload } from "./inbox-outbox-file-lane";
import { PeerLink } from "./inbox-peer-link";
import { tailnetTransport } from "./inbox-transport-tailnet";

const MB = 1024 * 1024;
let door: ReturnType<typeof Bun.serve> | null = null;
let line: Server | null = null;
const sockets: Socket[] = [];

afterEach(() => {
  door?.stop(true);
  door = null;
  for (const socket of sockets.splice(0)) socket.destroy();
  line?.close();
  line = null;
});

/** A file of `size` bytes (sparse: its size, none of its bytes on disk). */
function file(size: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "plannotator-file-wire-")), "big.bin");
  writeFileSync(path, "");
  truncateSync(path, size);
  return path;
}

/** The link's own way of sending a held file (PeerLink's upload: its query, headers and `fetch`) to this listener. */
function uploadTo(port: number): OutboxFileUpload {
  const link = new PeerLink({
    link: { id: "ibx_01JZ00000000000000000000S1", name: "Studio", token: "tok_laptop", transport: { kind: "tailnet", url: `http://127.0.0.1:${port}` }, device_id: null, linked_at: "2026-11-24T09:00:00.000Z" } as never,
    transport: tailnetTransport({ kind: "tailnet", url: `http://127.0.0.1:${port}` }),
    outbox: InboxOutbox.open(mkdtempSync(join(tmpdir(), "plannotator-file-wire-data-"))),
    onRecord: () => {},
    onChange: () => {},
    onRevoked: () => {},
  });
  return (link as unknown as { uploadFile: OutboxFileUpload }).uploadFile;
}

/** A plain listener that takes the request at `pace` (pause ms after each read; null: stop after the first), then answers. */
async function plainLine(pace: number | null, onRead: (received: number) => void = () => {}): Promise<number> {
  line = createServer((socket) => {
    sockets.push(socket);
    let received = 0;
    let headDone = false;
    let length = Infinity;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (!headDone) {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        headDone = true;
        length = Number(/content-length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? 0);
        chunk = buffer.subarray(end + 4);
      }
      received += chunk.length;
      onRead(received);
      if (received >= length) {
        const body = JSON.stringify({ upload: { upload_id: "upl_01JZ0000000000000000000000" }, got: received });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        return;
      }
      socket.pause();
      if (pace !== null) setTimeout(() => socket.resume(), pace);
    });
  });
  await new Promise<void>((resolve) => line!.listen(0, "127.0.0.1", () => resolve()));
  return (line.address() as { port: number }).port;
}

describe("a held answer's file over a real socket", () => {
  test("the door (Bun.serve) reading slowly takes all of it, and its answer is read", async () => {
    const size = 4 * MB;
    door = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const reader = req.body!.getReader();
        let got = 0;
        for (;;) {
          const piece = await reader.read();
          if (piece.done) break;
          got += piece.value.length;
          await Bun.sleep(2);
        }
        return Response.json({ upload: { upload_id: "upl_01JZ0000000000000000000000" }, got, key: new URL(req.url).searchParams.get("idempotency_key") });
      },
    });
    const tried = await uploadOutboxFile(file(size), { name: "big.bin", key: "k-door" }, uploadTo(door.port), 2000);
    expect(tried.kind).toBe("answer");
    if (tried.kind !== "answer") return;
    expect(tried.response.status).toBe(200);
    expect(tried.answer).toMatchObject({ upload: { upload_id: "upl_01JZ0000000000000000000000" }, got: size, key: "k-door" });
  });

  test("a slow line takes all of it, and the file is pulled only as the socket takes it, never all at once", async () => {
    const size = 32 * MB;
    let pulled = 0;
    // At each read on the far side: how far the sender's pulls were ahead of what had arrived.
    const ahead: number[] = [];
    const port = await plainLine(1, (received) => ahead.push(pulled - received));
    const tried = await uploadOutboxFile(file(size), { name: "big.bin", key: "k-slow" }, uploadTo(port), 2000, { pulled: (bytes) => (pulled += bytes) });
    expect(tried.kind).toBe("answer");
    if (tried.kind !== "answer") return;
    expect((tried.answer as { got?: number }).got).toBe(size);
    expect(pulled).toBe(size);
    // Pulled over many reads, each time at most the sockets' buffers ahead (a few MB): never the whole file in memory.
    expect(ahead.length).toBeGreaterThan(16);
    expect(Math.max(...ahead)).toBeLessThan(size / 2);
  });

  test("a line that stops: the pulls stop well short of the file, the idle limit ends it, and the file is closed", async () => {
    const size = 64 * MB;
    let pulled = 0;
    let lastPull = 0;
    let closed = false;
    const port = await plainLine(null);
    const idleMs = 300;
    const watch = {
      pulled: (bytes: number) => {
        pulled += bytes;
        lastPull = Date.now();
      },
      closed: () => (closed = true),
    };
    const started = Date.now();
    const pending = uploadOutboxFile(file(size), { name: "big.bin", key: "k-stop" }, uploadTo(port), idleMs, watch);
    await Bun.sleep(idleMs / 2);
    const early = pulled;
    const tried = await pending;
    const ended = Date.now();
    expect(tried.kind).toBe("stalled");
    // The socket's buffers fill, then nothing more is pulled.
    expect(pulled).toBeLessThan(size / 4);
    expect(pulled).toBe(early);
    // Ended about the idle limit after the last piece the line took.
    expect(ended - lastPull).toBeGreaterThanOrEqual(idleMs - 50);
    expect(ended - lastPull).toBeLessThan(idleMs + 1500);
    expect(ended - started).toBeLessThan(idleMs + 2000);
    expect(closed).toBe(true);
  });
});

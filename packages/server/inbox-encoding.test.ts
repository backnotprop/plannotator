/**
 * Compression and caching of the Inbox's answers on every listener the
 * browser reaches (packages/server/inbox-encoding.ts and the page and script
 * routes in inbox.ts), against a real Inbox on loopback. The tailnet
 * listener's own checks and its page are in inbox-tailscale.test.ts; this file
 * proves the window's port, a plain proxy in front of it, and what must stay
 * untouched (the event stream, byte ranges, attachments, the refusals).
 * Temp PLANNOTATOR_DATA_DIR only. Bun's fetch decodes by itself, so every
 * read here takes `decompress: false` and checks the bytes as sent.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { packApp } from "@plannotator/shared/packed-app";
import { mp4 } from "../../tests/helpers/video-fixtures";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_JSON_COMPRESS_MIN_BYTES } from "./inbox-encoding";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENTRY = `export const sentinel = "entry";\n${"// the window's entry script\n".repeat(20000)}`;
const LAZY = `export const lazy = "diagram engine";\n${"// a lazy part, compressed only once someone asks\n".repeat(20000)}`;
const PAGE = `<!doctype html><title>Inbox</title><script type="module" crossorigin src="/assets/entry-a.js"></script>${"<p>the window</p>\n".repeat(20000)}`;
const AUTHOR = { kind: "agent", host: "claude-code", session: "s1", name: "Claude Code" } as const;

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-encoding-")));
  roots.push(root);
  const film = mp4({ duration: 12, width: 640, height: 360, mdatBytes: 600 * 1024 });
  writeFileSync(join(root, "cut.mp4"), film);
  const data = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, name: `row ${i}` })) });
  writeFileSync(join(root, "data.json"), data);
  const server = await startInboxServer({
    dataDir: join(root, "data"),
    binaryPath: null,
    phones: false,
    htmlContent: packApp(PAGE, {
      "/assets/entry-a.js": { type: "text/javascript; charset=utf-8", text: ENTRY },
      "/assets/lazy-b.js": { type: "text/javascript; charset=utf-8", text: LAZY },
    }),
  });
  servers.push(server);
  const project = server.store.ensureProject({ name: "shop", root });
  const threads: string[] = [];
  for (let i = 0; i < 12; i++) {
    const sent = server.store.sendMessage({ project_id: project.id, author: AUTHOR, subject: `Billing screen ${i}`, body: `Three choices before I build the billing screens, part ${i}. `.repeat(20) });
    threads.push(sent.message.thread_id);
  }
  const withFiles = server.store.sendMessage({
    project_id: project.id,
    author: AUTHOR,
    subject: "Files",
    body: "The cut and the data.",
    attachments: await recordInboxAttachments(server.store.dir, ["cut.mp4", "data.json"], { base: root, at: new Date().toISOString() }),
  }).message;
  return { server, root, film, data, threads, attachments: withFiles.attachments! };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const raw = (url: string, headers: Record<string, string> = {}, method = "GET") => fetch(url, { method, headers, decompress: false } as RequestInit);
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

/** The answer once its compressed body is made (made at start; a browser on this computer gets it plain until then). */
async function settled(url: string, headers: Record<string, string>): Promise<Response> {
  for (let i = 0; i < 100; i++) {
    const res = await raw(url, headers);
    if (res.headers.get("content-encoding")) return res;
    await res.arrayBuffer();
    await Bun.sleep(20);
  }
  throw new Error(`never compressed: ${url}`);
}

test("the window's port sends the page compressed with a weak ETag and a 304 on reload, its security headers intact", async () => {
  // Regression caught: loopback (and so any proxy or tunnel to it) back to a 2 MB uncompressed, no-store page.
  const { server } = await world();
  const br = await settled(`${base(server)}/`, { "Accept-Encoding": "gzip, deflate, br" });
  expect(br.status).toBe(200);
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");
  expect(br.headers.get("cache-control")).toBe("private, no-cache");
  expect(br.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(br.headers.get("x-frame-options")).toBe("DENY");
  expect(br.headers.get("x-content-type-options")).toBe("nosniff");
  expect(br.headers.get("referrer-policy")).toBe("no-referrer");
  expect(brotliDecompressSync(await bytes(br)).toString("utf8")).toBe(PAGE);
  const etag = br.headers.get("etag")!;
  expect(etag).toMatch(/^W\/"/);

  // Safari and plain-http addresses take gzip only; a client that names nothing gets the page as it is.
  const gz = await settled(`${base(server)}/`, { "Accept-Encoding": "gzip, deflate" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(await bytes(gz)).toString("utf8")).toBe(PAGE);
  const plain = await raw(`${base(server)}/`);
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect((await bytes(plain)).toString("utf8")).toBe(PAGE);

  const again = await raw(`${base(server)}/`, { "Accept-Encoding": "br", "If-None-Match": etag });
  expect(again.status).toBe(304);
  expect((await bytes(again)).length).toBe(0);
  expect(again.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

  // The scripts: compressed, cached for good (their names carry the content hash).
  const script = await settled(`${base(server)}/assets/entry-a.js`, { "Accept-Encoding": "gzip, deflate, br" });
  expect(script.headers.get("content-encoding")).toBe("br");
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.headers.get("vary")).toBe("Accept-Encoding");
  expect(brotliDecompressSync(await bytes(script)).toString("utf8")).toBe(ENTRY);
});

test("the list and thread reads go out compressed on the window's port and through a plain proxy; small answers and other clients as they were", async () => {
  // Regression caught: the list read (the reload's wait on a slow link) sent uncompressed again.
  const { server, threads } = await world();
  const list = await raw(`${base(server)}/api/inbox/threads`, { "Accept-Encoding": "gzip, deflate, br" });
  expect(list.status).toBe(200);
  expect(list.headers.get("content-encoding")).toBe("br");
  expect(list.headers.get("vary")).toBe("Accept-Encoding");
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(list.headers.get("x-content-type-options")).toBe("nosniff");
  expect(list.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const listBytes = await bytes(list);
  const identityList = await bytes(await raw(`${base(server)}/api/inbox/threads`));
  expect(brotliDecompressSync(listBytes).equals(identityList)).toBe(true);
  for (const id of threads) expect(identityList.toString("utf8")).toContain(id);
  expect(listBytes.length).toBeLessThan(identityList.length / 3);

  // A thread for a gzip-only client.
  const thread = await raw(`${base(server)}/api/inbox/threads/${threads[0]}`, { "Accept-Encoding": "gzip" });
  expect(thread.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(gunzipSync(await bytes(thread)).toString("utf8")).thread.messages.length).toBe(1);

  // No Accept-Encoding (curl, an agent's script): plain JSON.
  const bare = await raw(`${base(server)}/api/inbox/threads/${threads[0]}`);
  expect(bare.headers.get("content-encoding")).toBeNull();
  expect(JSON.parse((await bytes(bare)).toString("utf8")).thread.messages.length).toBe(1);

  // Under the threshold: sent as it is, Vary only.
  const health = await raw(`${base(server)}/api/inbox/health`, { "Accept-Encoding": "br" });
  const healthBytes = await bytes(health);
  expect(healthBytes.length).toBeLessThan(INBOX_JSON_COMPRESS_MIN_BYTES);
  expect(health.headers.get("content-encoding")).toBeNull();
  expect(JSON.parse(healthBytes.toString("utf8"))).toBeTruthy();

  // A plain reverse proxy or ssh tunnel on this computer (loopback X-Forwarded-For, Host rewritten): the same answers.
  const proxied = { "Accept-Encoding": "gzip, deflate, br", "X-Forwarded-For": "127.0.0.1", Host: `localhost:${server.port}` };
  const viaProxy = await raw(`${base(server)}/api/inbox/threads`, proxied);
  expect(viaProxy.status).toBe(200);
  expect(viaProxy.headers.get("content-encoding")).toBe("br");
  const pageViaProxy = await raw(`${base(server)}/`, proxied);
  expect(pageViaProxy.headers.get("content-encoding")).toBe("br");
  expect(pageViaProxy.headers.get("etag")).toMatch(/^W\/"/);

  // A HEAD carries no body to encode.
  const head = await raw(`${base(server)}/api/inbox/threads`, { "Accept-Encoding": "br" }, "HEAD");
  expect(head.headers.get("content-encoding")).toBeNull();
});

test("a hand-made `tailscale serve` or an outside proxy straight to the window's port is still refused", async () => {
  // Regression caught: the encoding path skipping the window port's refusal (it would hand the tailnet /mcp).
  const { server } = await world();
  const served = await raw(`${base(server)}/api/inbox/threads`, { "Accept-Encoding": "br", "Tailscale-User-Login": "ramos@example.com" });
  expect(served.status).toBe(403);
  expect(JSON.parse((await bytes(served)).toString("utf8")).code).toBe("local_only");
  const outside = await raw(`${base(server)}/`, { "Accept-Encoding": "br", "X-Forwarded-For": "203.0.113.9" });
  expect(outside.status).toBe(403);
});

test("the event stream is never encoded or held: a frame arrives while the answer is still open", async () => {
  // Regression caught: a wrapper that reads or compresses the stream would hold every live update.
  const { server } = await world();
  const stream = await fetch(`${base(server)}/api/inbox/events?window=w1`, {
    headers: { "Accept-Encoding": "gzip, deflate, br", "Sec-Fetch-Site": "same-origin" },
    decompress: false,
  } as RequestInit);
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toStartWith("text/event-stream");
  expect(stream.headers.get("content-encoding")).toBeNull();
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const project = server.store.ensureProject({ name: "later", root: roots[0]! });
  const arrived = (async () => {
    while (!text.includes("event: record")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended");
      text += decoder.decode(value, { stream: true });
    }
  })();
  server.store.sendMessage({ project_id: project.id, author: AUTHOR, subject: "Live", body: "A new message while the window listens." });
  await Promise.race([arrived, new Promise((_, fail) => setTimeout(() => fail(new Error(`no frame: ${text.slice(0, 200)}`)), 5000))]);
  await reader.cancel();
});

test("byte ranges and attached files keep their own bytes: a video's 206, and a .json attachment never re-encoded", async () => {
  // Regression caught: compressing a 206 or an attached file breaks seeking and the file's ETag.
  const { server, film, data, attachments } = await world();
  const [cut, json] = attachments;
  const video = `${base(server)}/api/inbox/attachments/${cut!.id}/video`;
  const part = await raw(video, { "Accept-Encoding": "gzip, deflate, br", Range: "bytes=100-1099" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-encoding")).toBeNull();
  expect(part.headers.get("content-range")).toBe(`bytes 100-1099/${film.length}`);
  expect((await bytes(part)).equals(film.subarray(100, 1100))).toBe(true);
  const whole = await raw(video, { "Accept-Encoding": "gzip, deflate, br" });
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-encoding")).toBeNull();
  expect((await bytes(whole)).equals(film)).toBe(true);

  const download = await raw(`${base(server)}/api/inbox/attachments/${json!.id}/download`, { "Accept-Encoding": "gzip, deflate, br" });
  expect(download.status).toBe(200);
  expect(download.headers.get("content-encoding")).toBeNull();
  expect((await bytes(download)).toString("utf8")).toBe(data);
});

test("a browser on this computer never waits on a one-time compression; a proxy, a tunnel or the tailnet always gets it compressed", async () => {
  // Regression caught: the window opening at Inbox start (or a first diagram) waiting on a brotli pass over a free link,
  // or a proxied first load sent uncompressed.
  const { server } = await world();
  const lazy = `${base(server)}/assets/lazy-b.js`;
  const asks = { "Accept-Encoding": "gzip, deflate, br" };
  // Nobody asked for it yet: on this computer it goes out plain at once, and is compressed in the background.
  const first = await raw(lazy, asks);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-encoding")).toBeNull();
  expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect((await bytes(first)).toString("utf8")).toBe(LAZY);
  // Once made, the same browser gets it compressed.
  expect(brotliDecompressSync(await bytes(await settled(lazy, asks))).toString("utf8")).toBe(LAZY);

  // Through a proxy (loopback X-Forwarded-For), the first ask of a body not yet made waits for it.
  const gzipOnly = await raw(lazy, { "Accept-Encoding": "gzip", "X-Forwarded-For": "127.0.0.1" });
  expect(gzipOnly.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(await bytes(gzipOnly)).toString("utf8")).toBe(LAZY);
});

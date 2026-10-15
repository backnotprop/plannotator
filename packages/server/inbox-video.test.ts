/**
 * Video attachments through a real Inbox (design record "inbox-video"): an
 * agent attaches over the MCP SDK's HTTP client, the window reads with real
 * `fetch`, and a paired phone reads through its door. The films are built in
 * the test (tests/helpers/video-fixtures.ts). Every test has its own temp
 * data dir; nothing touches the real home.
 *
 * Proves: the kind `video` from the bytes with the header's length and frame
 * size; the `video` route's Range (206, 416, several ranges, If-Range, the
 * sent version) and headers; `415` for any other kind; a cross-site request
 * refused; `/download` taking the same Range; comments on a video allowed
 * (and shaped), where a file still refuses them; the phone's door forwarding
 * Range and If-Range and returning the window's 206 unchanged; and a relay
 * command (no headers) answered with the whole file.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ebml, mp4 } from "../../tests/helpers/video-fixtures";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxDevices } from "./inbox-devices";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedRelay = process.env.PLANNOTATOR_RELAY_URL;

afterEach(async () => {
  if (savedRelay === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
  else process.env.PLANNOTATOR_RELAY_URL = savedRelay;
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Json = Record<string, any>;

const FILM = mp4({ duration: 461.3, width: 1920, height: 1080, mdatBytes: 3 * 1024 * 1024 + 17 });
const FILM_SHA = createHash("sha256").update(FILM).digest("hex");

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-video-")));
  roots.push(root);
  const project = join(root, "launch-site");
  mkdirSync(join(project, "film"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "film", "launch-cut-v3.mp4"), FILM);
  writeFileSync(join(project, "film", "teaser.webm"), ebml("webm"));
  writeFileSync(join(project, "film", "voice.mp4"), mp4({ tracks: ["soun"] }));
  writeFileSync(join(project, "notes.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string, phones = false): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, ...(phones ? { phones: true } : {}) });
  servers.push(server);
  return server;
}

async function send(server: InboxServer, args: Record<string, unknown>): Promise<Json> {
  const client = new Client({ name: "inbox-video-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Json };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const ATTACHED = ["film/launch-cut-v3.mp4", "film/teaser.webm", "film/voice.mp4", "notes.zip"];

test("a film is kind video from its bytes, with the length and frame size its header gives (MP4); WebM without; audio stays a file", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(server, { project_path: project, body: "Two cuts.", attachments: ATTACHED });
  expect(sent.attachments.map((a: Json) => [a.name, a.kind])).toEqual([
    ["launch-cut-v3.mp4", "video"],
    ["teaser.webm", "video"],
    ["voice.mp4", "file"],
    ["notes.zip", "file"],
  ]);
  const listed = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as Json;
  const [cut, teaser] = listed.attachments as Json[];
  expect(cut).toMatchObject({ media_type: "video/mp4", duration_ms: 461300, width: 1920, height: 1080, size: FILM.length, unavailable: null });
  expect(teaser).toMatchObject({ media_type: "video/webm" });
  expect(teaser.duration_ms).toBeUndefined();
  expect(teaser.width).toBeUndefined();
});

test("the video route: 200 with Accept-Ranges, one range a 206, 416 past the end, several ranges and a stale If-Range the full file", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(server, { project_path: project, body: "Cut.", attachments: ATTACHED });
  const [cut, teaser, voice, zip] = sent.attachments as Json[];
  const url = `http://127.0.0.1:${server.port}/api/inbox/attachments/${cut.id}/video`;

  const whole = await fetch(url);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  // Longer than one read (BYTE_RANGE_WHOLE_MAX): streamed, so Bun sends it chunked without a Content-Length.
  expect(whole.headers.get("content-length")).toBeNull();
  expect(whole.headers.get("content-disposition")).toStartWith("inline;");
  expect(whole.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
  expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
  expect(whole.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(whole.headers.get("cache-control")).toBe("private, no-cache");
  const etag = whole.headers.get("etag")!;
  expect(etag).toStartWith('W/"');
  expect(Buffer.from(await whole.arrayBuffer()).equals(FILM)).toBe(true);

  // AVPlayer's first probe.
  const probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
  expect(probe.status).toBe(206);
  expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${FILM.length}`);
  expect(probe.headers.get("content-length")).toBe("2");
  expect(probe.headers.get("etag")).toBe(etag);
  expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([...FILM.subarray(0, 2)]);

  // A seek deep into the film, across a 1 MiB chunk boundary.
  const from = 1024 * 1024 - 10;
  const seek = await fetch(url, { headers: { Range: `bytes=${from}-`, "If-Range": etag } });
  expect(seek.status).toBe(206);
  expect(seek.headers.get("content-range")).toBe(`bytes ${from}-${FILM.length - 1}/${FILM.length}`);
  expect(Buffer.from(await seek.arrayBuffer()).equals(FILM.subarray(from))).toBe(true);

  const tail = await fetch(url, { headers: { Range: "bytes=-100" } });
  expect(tail.status).toBe(206);
  expect(Buffer.from(await tail.arrayBuffer()).equals(FILM.subarray(FILM.length - 100))).toBe(true);

  const past = await fetch(url, { headers: { Range: `bytes=${FILM.length}-` } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${FILM.length}`);
  expect((await past.arrayBuffer()).byteLength).toBe(0);

  const several = await fetch(url, { headers: { Range: "bytes=0-1, 10-20" } });
  expect(several.status).toBe(200);
  expect(several.headers.get("content-range")).toBeNull();
  expect((await several.arrayBuffer()).byteLength).toBe(FILM.length);

  // A seek that fits one read keeps its Content-Length.
  const mid = await fetch(url, { headers: { Range: "bytes=2000000-2099999" } });
  expect(mid.status).toBe(206);
  expect(mid.headers.get("content-length")).toBe("100000");
  expect(Buffer.from(await mid.arrayBuffer()).equals(FILM.subarray(2_000_000, 2_100_000))).toBe(true);

  const stale = await fetch(url, { headers: { Range: "bytes=0-1", "If-Range": 'W/"0-0-0-0"' } });
  expect(stale.status).toBe(200);
  await stale.body?.cancel();

  // Any other kind: 415, and the door's method rule: GET only.
  for (const other of [voice, zip]) {
    const refused = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${other.id}/video`);
    expect(refused.status).toBe(415);
    expect(((await refused.json()) as Json).code).toBe("attachment_not_video");
  }
  expect((await fetch(url, { method: "HEAD" })).status).toBe(405);
  expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${teaser.id}/video`)).headers.get("content-type")).toBe("video/webm");

  // Another site is refused before anything is read.
  const cross = await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(cross.status).toBe(403);
});

test("the sent version: its sha256 as a strong ETag, and the agent's re-render changes the current one (If-Range then asks for the whole new file)", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(server, { project_path: project, body: "Cut.", attachments: ["film/launch-cut-v3.mp4"] });
  const cut = sent.attachments[0] as Json;
  const base = `http://127.0.0.1:${server.port}/api/inbox/attachments/${cut.id}/video`;
  const before = (await fetch(base, { headers: { Range: "bytes=0-0" } })).headers.get("etag")!;

  // The agent re-renders the film in place.
  const recut = mp4({ duration: 300, width: 1280, height: 720, mdatBytes: 1000 });
  writeFileSync(join(project, "film", "launch-cut-v3.mp4"), recut);
  const now = await fetch(base, { headers: { Range: "bytes=0-9", "If-Range": before } });
  expect(now.status).toBe(200);
  expect(now.headers.get("etag")).not.toBe(before);
  expect(Buffer.from(await now.arrayBuffer()).equals(recut)).toBe(true);

  const old = await fetch(`${base}?version=sent`, { headers: { Range: "bytes=10-19" } });
  expect(old.status).toBe(206);
  expect(old.headers.get("etag")).toBe(`"${FILM_SHA}"`);
  expect(Buffer.from(await old.arrayBuffer()).equals(FILM.subarray(10, 20))).toBe(true);
  const oldMatch = await fetch(`${base}?version=sent`, { headers: { Range: "bytes=10-19", "If-Range": `"${FILM_SHA}"` } });
  expect(oldMatch.status).toBe(206);
  await oldMatch.body?.cancel();
});

test("/download honors Range the same way, and keeps its download headers", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(server, { project_path: project, body: "Cut.", attachments: ["film/launch-cut-v3.mp4", "notes.zip"] });
  const [cut, zip] = sent.attachments as Json[];
  const url = `http://127.0.0.1:${server.port}/api/inbox/attachments/${cut.id}/download`;
  const part = await fetch(url, { headers: { Range: "bytes=100-199" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 100-199/${FILM.length}`);
  expect(part.headers.get("content-type")).toBe("application/octet-stream");
  expect(part.headers.get("content-disposition")).toStartWith("attachment;");
  expect(part.headers.get("accept-ranges")).toBe("bytes");
  expect(Buffer.from(await part.arrayBuffer()).equals(FILM.subarray(100, 200))).toBe(true);
  const whole = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${zip.id}/download`);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("content-length")).toBe("8");
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(FILM.length));
  expect((await fetch(url, { headers: { Range: `bytes=${FILM.length + 5}-` } })).status).toBe(416);
});

test("comments on a video are kept at a moment; a malformed one is refused, and a plain file still takes none", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(server, { project_path: project, body: "Cut.", attachments: ["film/launch-cut-v3.mp4", "notes.zip"] });
  const [cut, zip] = sent.attachments as Json[];
  const post = (body: Json) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const annotation = {
    id: "ann-vid-1",
    blockId: "video",
    startOffset: 0,
    endOffset: 0,
    type: "COMMENT",
    text: "Logo is clipped on the right edge at this size.",
    originalText: "launch-cut-v3.mp4 at 1:42",
    createdA: 1,
    inboxVideo: { time: 102.4 },
  };
  const ok = await post({ attachment_id: cut.id, version: "current", annotation });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as Json).annotation.annotation.inboxVideo).toEqual({ time: 102.4 });
  const noTime = await post({ attachment_id: cut.id, version: "current", annotation: { ...annotation, id: "ann-vid-2", inboxVideo: { time: -1 } } });
  expect(noTime.status).toBe(422);
  const wrongBlock = await post({ attachment_id: cut.id, version: "current", annotation: { ...annotation, id: "ann-vid-3", blockId: "image" } });
  expect(wrongBlock.status).toBe(422);
  const onFile = await post({ attachment_id: zip.id, version: "current", annotation: { ...annotation, id: "ann-vid-4" } });
  expect(onFile.status).toBe(422);
  expect(((await onFile.json()) as Json).code).toBe("annotation_not_allowed");
});

test("the phone's door forwards Range and If-Range and returns the window's 206 unchanged; a relay command (no headers) gets the whole file", async () => {
  const { project, dataDir } = world();
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  const server = await start(dataDir, true);
  const origin = `http://127.0.0.1:${server.port}`;
  const made = (await (await fetch(`${origin}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
  const paired = (await (
    await fetch(`${origin}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })
  ).json()) as Json;
  const door = (path: string, headers: Record<string, string> = {}) => fetch(`${origin}/api/inbox/device/${path}`, { headers: { Authorization: `Bearer ${paired.token}`, ...headers } });

  const sent = await send(server, { project_path: project, body: "For the phone.", attachments: ["film/launch-cut-v3.mp4"] });
  const cut = sent.attachments[0] as Json;
  const HEADERS = ["content-type", "content-range", "accept-ranges", "content-length", "etag", "content-security-policy", "x-content-type-options", "cross-origin-resource-policy", "cache-control"];
  for (const route of ["video", "download"]) {
    const fromWindow = await fetch(`${origin}/api/inbox/attachments/${cut.id}/${route}`, { headers: { Range: "bytes=0-1" } });
    const fromPhone = await door(`attachments/${cut.id}/${route}`, { Range: "bytes=0-1" });
    expect([route, fromPhone.status]).toEqual([route, 206]);
    for (const name of HEADERS) expect([route, name, fromPhone.headers.get(name)]).toEqual([route, name, fromWindow.headers.get(name)]);
    expect([...new Uint8Array(await fromPhone.arrayBuffer())]).toEqual([...FILM.subarray(0, 2)]);
    await fromWindow.body?.cancel();
    // A stale If-Range: the full 200 through the door too.
    const stale = await door(`attachments/${cut.id}/${route}`, { Range: "bytes=0-1", "If-Range": '"stale"' });
    expect([route, stale.status]).toEqual([route, 200]);
    await stale.body?.cancel();
    const past = await door(`attachments/${cut.id}/${route}`, { Range: `bytes=${FILM.length}-` });
    expect([route, past.status, past.headers.get("content-range")]).toEqual([route, 416, `bytes */${FILM.length}`]);
  }
  // A sent version through the door.
  const sentPart = await door(`attachments/${cut.id}/video?version=sent`, { Range: "bytes=4-11" });
  expect(sentPart.status).toBe(206);
  expect(Buffer.from(await sentPart.arrayBuffer()).toString("latin1")).toBe("ftypisom");

  // The relay applies a command in-process with no headers (inbox-devices.ts asDevice): the whole film, 200.
  const devices = createInboxDevices({
    dataDir,
    serverSession: server.serverSession,
    port: () => server.port,
    registry: () => server.registry,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: fetch,
  });
  const relayed = await devices.asDevice(paired.device.id, { method: "GET", path: `/api/inbox/device/attachments/${cut.id}/video` });
  expect(relayed.status).toBe(200);
  expect(relayed.headers.get("content-range")).toBeNull();
  expect(Buffer.from(await relayed.arrayBuffer()).equals(FILM)).toBe(true);
});

/**
 * Images in a message (#1813), proved against a real Inbox on
 * loopback under a temp data dir, a temp git project, the MCP SDK client for
 * the agent and real `fetch` for the window.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxMessageImageRefs, readInboxMessageImage } from "@plannotator/shared/inbox/message-images";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
});

/** A PNG's signature and IHDR (2 x 3 px): enough for the sniffer and the dimension read. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

function gif(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
}

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-img-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(join(project, ".walkthrough", "shots"), { recursive: true });
  mkdirSync(join(project, "packages", "web", "shots"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, ".walkthrough", "shots", "after.png"), png());
  // A GIF named .png: the type comes from the bytes.
  writeFileSync(join(project, ".walkthrough", "shots", "really-a-gif.png"), gif());
  writeFileSync(join(project, ".walkthrough", "shots", "fake.png"), "not an image at all");
  writeFileSync(join(project, ".walkthrough", "notes.txt"), "plain text");
  writeFileSync(join(project, "packages", "web", "shots", "home.png"), png());
  // Outside the project.
  writeFileSync(join(root, "secret.png"), png());
  symlinkSync(join(root, "secret.png"), join(project, ".walkthrough", "shots", "escape.png"));
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return { root, project, dataDir };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-message-images-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function send(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function image(server: InboxServer, messageId: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(path)}`, { headers });
}

function expectGuardHeaders(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

const BODY = [
  "The page after the fix:",
  "",
  "![after](.walkthrough/shots/after.png)",
  "",
  "![gif](.walkthrough/shots/really-a-gif.png) ![fake](.walkthrough/shots/fake.png) ![notes](.walkthrough/notes.txt)",
  "",
  "![up](../secret.png) ![link](.walkthrough/shots/escape.png) ![gone](.walkthrough/shots/missing.png)",
  "",
  '<img src="./.walkthrough/shots/after.png?v=2" alt="html">',
].join("\n");

test("an image the message shows serves from its project, typed by its bytes, with the guard headers", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: BODY });

  const ok = await image(server, sent.message_id, ".walkthrough/shots/after.png", { "Sec-Fetch-Site": "same-origin" });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/png");
  expectGuardHeaders(ok);
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png());

  // The content type is sniffed, never taken from the name.
  const sniffed = await image(server, sent.message_id, ".walkthrough/shots/really-a-gif.png");
  expect(sniffed.status).toBe(200);
  expect(sniffed.headers.get("content-type")).toBe("image/gif");

  // An <img> in raw HTML, with a query string, as the browser reads its src.
  const html = await image(server, sent.message_id, "./.walkthrough/shots/after.png?v=2");
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toBe("image/png");
});

test("escapes, non-images, unreferenced paths, unknown messages and other sites are refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: BODY });
  const id = sent.message_id as string;

  const up = await image(server, id, "../secret.png");
  expect(up.status).toBe(403);
  expect(((await up.json()) as { code: string }).code).toBe("outside_project");
  expectGuardHeaders(up);

  const link = await image(server, id, ".walkthrough/shots/escape.png");
  expect(link.status).toBe(403);
  expect(((await link.json()) as { code: string }).code).toBe("outside_project");

  // A non-image: by its name before anything is read, and by its bytes.
  expect((await image(server, id, ".walkthrough/notes.txt")).status).toBe(415);
  expect((await image(server, id, ".walkthrough/shots/fake.png")).status).toBe(415);

  // A file in the project the body does not show cannot be probed.
  const unreferenced = await image(server, id, "packages/web/shots/home.png");
  expect(unreferenced.status).toBe(403);
  expect(((await unreferenced.json()) as { code: string }).code).toBe("image_not_referenced");
  expect((await image(server, id, join(project, ".walkthrough/shots/after.png"))).status).toBe(403);

  expect((await image(server, id, ".walkthrough/shots/missing.png")).status).toBe(404);
  const unknown = await image(server, "msg_00000000000000000000000000", ".walkthrough/shots/after.png");
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as { code: string }).code).toBe("message_not_found");

  // Another site, or another port on this machine, gets nothing.
  expect((await image(server, id, ".walkthrough/shots/after.png", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await image(server, id, ".walkthrough/shots/after.png", { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  // A foreign Host never reaches the route (the Inbox's allowlist).
  const rebound = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${id}/image?path=${encodeURIComponent(".walkthrough/shots/after.png")}`, {
    headers: { Host: "evil.example" },
  });
  expect(rebound.status).toBe(403);
});

test("relative paths start at the folder the agent sent from, still bounded by the project", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: join(project, "packages", "web"), body: "![home](shots/home.png)\n\n![root](../../.walkthrough/shots/after.png)\n\n![out](../../../secret.png)" });
  expect(sent.project.root).toBe(project);
  expect((await image(server, sent.message_id, "shots/home.png")).status).toBe(200);
  expect((await image(server, sent.message_id, "../../.walkthrough/shots/after.png")).status).toBe(200);
  expect((await image(server, sent.message_id, "../../../secret.png")).status).toBe(403);
  // An absolute path inside the project works when the body names it.
  const absolute = join(project, ".walkthrough", "shots", "after.png");
  const second = await send(client, { project_path: project, body: `![abs](${absolute})` });
  expect((await image(server, second.message_id, absolute)).status).toBe(200);
});

test("the body's image references are read as the window renders them", () => {
  const refs = inboxMessageImageRefs(
    [
      "![a](one.png) ![b](https://example.com/x.png) ![c](data:image/png;base64,AAAA)",
      "<IMG alt=x SRC='two&amp;three.png'> <img src=four.png>",
      "Not an image: [link](five.png).",
    ].join("\n"),
  );
  expect([...refs].sort()).toEqual(["four.png", "one.png", "two&three.png"]);
});

/** A PNG header claiming `width` x `height` pixels. */
function pngSized(width: number, height: number): Uint8Array {
  const bytes = png();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("a FIFO in the project is refused at once, never read (the Inbox does not hang)", async () => {
  const { project, dataDir } = world();
  const fifo = join(project, ".walkthrough", "shots", "pipe.png");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![pipe](.walkthrough/shots/pipe.png)" });
  const started = Date.now();
  const answer = await image(server, sent.message_id, ".walkthrough/shots/pipe.png", { "Sec-Fetch-Site": "same-origin" });
  expect(answer.status).toBe(404);
  expect(((await answer.json()) as { code: string }).code).toBe("image_missing");
  expect(Date.now() - started).toBeLessThan(5000);
  // The server still answers afterwards.
  expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).status).toBe(200);
});

test("an absolute path through a symlinked prefix is judged by where it leads", async () => {
  const { root, project, dataDir } = world();
  // As macOS /tmp is really /private/tmp: the project reached under another spelling.
  const alias = join(root, "alias");
  symlinkSync(project, alias);
  const spelled = join(alias, ".walkthrough", "shots", "after.png");
  const escape = join(alias, ".walkthrough", "shots", "escape.png");
  const outside = join(root, "secret.png");
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: `![a](${spelled}) ![b](${escape}) ![c](${outside})` });
  expect((await image(server, sent.message_id, spelled)).status).toBe(200);
  expect((await image(server, sent.message_id, escape)).status).toBe(403);
  expect((await image(server, sent.message_id, outside)).status).toBe(403);
});

test("the byte cap and the pixel cap are 413", async () => {
  const { project, dataDir } = world();
  const big = join(project, ".walkthrough", "shots", "big.png");
  writeFileSync(big, png());
  truncateSync(big, MAX_REVIEW_IMAGE_PREVIEW_BYTES + 1);
  writeFileSync(join(project, ".walkthrough", "shots", "wide.png"), pngSized(10_000, 10_000));
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![big](.walkthrough/shots/big.png) ![wide](.walkthrough/shots/wide.png)" });
  const tooBig = await image(server, sent.message_id, ".walkthrough/shots/big.png");
  expect(tooBig.status).toBe(413);
  expectGuardHeaders(tooBig);
  expect((await image(server, sent.message_id, ".walkthrough/shots/wide.png")).status).toBe(413);
});

test("a percent-encoded src falls back to the decoded name; an SVG is image/svg+xml under the sandbox CSP; HEAD and 405", async () => {
  const { project, dataDir } = world();
  writeFileSync(join(project, ".walkthrough", "shots", "my shot.png"), png());
  writeFileSync(join(project, ".walkthrough", "shots", "flow.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>');
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![s](.walkthrough/shots/my%20shot.png) ![f](.walkthrough/shots/flow.svg) ![a](.walkthrough/shots/after.png)" });
  const id = sent.message_id as string;

  const decoded = await image(server, id, ".walkthrough/shots/my%20shot.png");
  expect(decoded.status).toBe(200);
  expect(decoded.headers.get("content-type")).toBe("image/png");
  expect(decoded.headers.get("x-image-width")).toBe("2");
  expect(decoded.headers.get("x-image-height")).toBe("3");

  const svg = await image(server, id, ".walkthrough/shots/flow.svg");
  expect(svg.status).toBe(200);
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expectGuardHeaders(svg);

  const url = `http://127.0.0.1:${server.port}/api/inbox/messages/${id}/image?path=${encodeURIComponent(".walkthrough/shots/after.png")}`;
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("image/png");
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  const posted = await fetch(url, { method: "POST" });
  expect(posted.status).toBe(405);
  expectGuardHeaders(posted);
});

test("a base_path gone by serve time, or outside the project, falls back to the project root", async () => {
  const { project, dataDir } = world();
  const sub = join(project, "packages", "gone");
  mkdirSync(sub, { recursive: true });
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: sub, body: "![a](.walkthrough/shots/after.png)" });
  expect(server.store.message(sent.message_id)?.base_path).toBe(sub);
  rmSync(sub, { recursive: true, force: true });
  expect((await image(server, sent.message_id, ".walkthrough/shots/after.png")).status).toBe(200);
  // A base_path outside the project (a record no send writes) is never used.
  const result = readInboxMessageImage({ body: "![a](.walkthrough/shots/after.png)", root: project, base: join(project, ".."), path: ".walkthrough/shots/after.png" });
  expect(result.ok).toBe(true);
});

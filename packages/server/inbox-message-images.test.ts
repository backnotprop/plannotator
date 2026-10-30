/**
 * Images in a message (#1813), proved against a real Inbox on
 * loopback under a temp data dir, a temp git project, the MCP SDK client for
 * the agent and real `fetch` for the window.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxHomeDotFolder, inboxMessageImageRefs, readInboxMessageImage } from "@plannotator/shared/inbox/message-images";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let previousDataDir: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  previousHome = process.env.HOME;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
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
  // Outside the project: shown, as an attachment from anywhere would be.
  writeFileSync(join(root, "secret.png"), png());
  symlinkSync(join(root, "secret.png"), join(project, ".walkthrough", "shots", "escape.png"));
  // The temp root is the home folder (a scratch HOME, never the real one).
  process.env.HOME = root;
  // In a hidden folder of the home folder (as ~/.ssh): never shown, by path or through a symlink.
  mkdirSync(join(root, ".secrets"), { recursive: true });
  writeFileSync(join(root, ".secrets", "key.png"), png());
  symlinkSync(join(root, ".secrets", "key.png"), join(project, ".walkthrough", "shots", "to-hidden.png"));
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
  "![hidden](../.secrets/key.png) ![to-hidden](.walkthrough/shots/to-hidden.png)",
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

test("images outside the project serve; the home folder's hidden folders, non-images, unreferenced paths, unknown messages and other sites are refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: BODY });
  const id = sent.message_id as string;

  // Outside the project, by `../` and through a symlink: shown (no project boundary).
  const up = await image(server, id, "../secret.png");
  expect(up.status).toBe(200);
  expectGuardHeaders(up);
  expect((await image(server, id, ".walkthrough/shots/escape.png")).status).toBe(200);

  // A hidden folder of the home folder: refused as named, and through a symlink by its realpath.
  const hidden = await image(server, id, "../.secrets/key.png");
  expect(hidden.status).toBe(403);
  expect(((await hidden.json()) as { code: string }).code).toBe("image_hidden");
  expectGuardHeaders(hidden);
  const toHidden = await image(server, id, ".walkthrough/shots/to-hidden.png");
  expect(toHidden.status).toBe(403);
  expect(((await toHidden.json()) as { code: string }).code).toBe("image_hidden");

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

test("relative paths start at the folder the agent sent from", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: join(project, "packages", "web"), body: "![home](shots/home.png)\n\n![root](../../.walkthrough/shots/after.png)\n\n![out](../../../secret.png)" });
  expect(sent.project.root).toBe(project);
  expect((await image(server, sent.message_id, "shots/home.png")).status).toBe(200);
  expect((await image(server, sent.message_id, "../../.walkthrough/shots/after.png")).status).toBe(200);
  expect((await image(server, sent.message_id, "../../../secret.png")).status).toBe(200);
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
  const toHidden = join(alias, ".walkthrough", "shots", "to-hidden.png");
  const outside = join(root, "secret.png");
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: `![a](${spelled}) ![b](${escape}) ![c](${outside}) ![d](${toHidden})` });
  expect((await image(server, sent.message_id, spelled)).status).toBe(200);
  expect((await image(server, sent.message_id, escape)).status).toBe(200);
  expect((await image(server, sent.message_id, outside)).status).toBe(200);
  // The hidden folder it really leads to is refused, whatever spelling named it.
  expect((await image(server, sent.message_id, toHidden)).status).toBe(403);
});

test("an image under /tmp, spelled /tmp (really /private/tmp on macOS), is served and captured at send", async () => {
  const { project, dataDir } = world();
  const scratch = mkdtempSync("/tmp/plannotator-inbox-img-tmp-");
  roots.push(scratch);
  const shot = join(scratch, "before-list-light.png");
  writeFileSync(shot, png());
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: `The list before:\n\n![before](${shot})` });
  expect(sent.images_not_shown).toBeUndefined();
  const served = await image(server, sent.message_id, shot);
  expect(served.status).toBe(200);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(png());
  const captured = server.store.message(sent.message_id)?.inline_images ?? [];
  expect(captured.map((i) => [i.ref, i.path])).toEqual([[shot, realpathSync(shot)]]);
});

test("a dotenv-family name is refused even inside the project", async () => {
  const { project, dataDir } = world();
  writeFileSync(join(project, ".walkthrough", "shots", ".env.png"), png());
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![e](.walkthrough/shots/.env.png)" });
  const answer = await image(server, sent.message_id, ".walkthrough/shots/.env.png");
  expect(answer.status).toBe(403);
  expect(((await answer.json()) as { code: string }).code).toBe("image_hidden");
});

test("an image in a hidden folder beside the project shows inline, as the same folder's attachment does; a .env file there and the home folder's hidden folders do not", async () => {
  const { root, dataDir } = world();
  // As reported: the project is ~/work/plannotator, the pictures sit in ~/work/.ops (not the home folder's own hidden folder).
  const project = join(root, "work", "plannotator");
  const ops = join(root, "work", ".ops", "multi-machine");
  mkdirSync(project, { recursive: true });
  mkdirSync(ops, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const light = join(ops, "explainer-light.png");
  const dark = join(ops, "explainer-dark.png");
  const dotenv = join(ops, ".env.png");
  const homeHidden = join(root, ".secrets", "key.png");
  for (const file of [light, dark, dotenv]) writeFileSync(file, png());
  const server = await start(dataDir);
  const { text, structured } = await sendResult(await agent(server), {
    project_path: project,
    body: `![One Inbox, every machine](${light})\n\n![e](${dotenv}) ![k](${homeHidden})`,
    attachments: [dark],
  });
  // Only the .env file and the home folder's hidden folder are named as not shown.
  expect(structured.images_not_shown).toEqual([
    { ref: dotenv, reason: "a .env file, or in a hidden folder of the home folder such as ~/.ssh" },
    { ref: homeHidden, reason: "a .env file, or in a hidden folder of the home folder such as ~/.ssh" },
  ]);
  expect(text).not.toContain(light);
  // The inline picture shows, and was captured at send, as the attachment beside it was taken.
  const shown = await image(server, structured.message_id, light);
  expect(shown.status).toBe(200);
  expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png());
  const message = server.store.message(structured.message_id)!;
  expect((message.inline_images ?? []).map((i) => i.ref)).toEqual([light]);
  expect((message.attachments ?? []).map((a) => a.path)).toEqual([dark]);
  for (const refused of [dotenv, homeHidden]) {
    const answer = await image(server, structured.message_id, refused);
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { code: string }).code).toBe("image_hidden");
  }
});

test("with HOME pointed elsewhere, a real home folder's hidden folders are still refused; a hidden folder deeper in it still shows", async () => {
  const { root } = world();
  // A scratch HOME (world sets it): the real home, other users' and root's are judged by their shape.
  expect(process.env.HOME).toBe(root);
  for (const path of ["/Users/someone/.ssh/k.png", "/home/someone/.config/app/x.png", "/root/.cache/t.png", "/var/root/.ssh/k.png", "/private/var/root/.x/k.png", "C:\\Users\\someone\\.ssh\\k.png", "/.hidden/x.png", join(root, ".secrets", "key.png")]) {
    expect(inboxHomeDotFolder(path)).not.toBeNull();
  }
  for (const path of ["/Users/someone/work/.ops/e.png", "/home/someone/src/app/.walkthrough/a.png", "C:\\Users\\someone\\work\\.ops\\e.png", join(root, "work", ".ops", "e.png")]) {
    expect(inboxHomeDotFolder(path)).toBeNull();
  }
  // A relative HOME names no home at all: the shape still guards.
  process.env.HOME = "relative/home";
  expect(inboxHomeDotFolder("/Users/someone/.aws/x.png")).toBe("/Users/someone/.aws");
});

/** send_message's whole result: its text line and structured content. */
async function sendResult(client: Client, args: Record<string, unknown>): Promise<{ text: string; structured: Record<string, any> }> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

test("send_message says which images will not show, and still sends the message", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const body = [
    "![ok](.walkthrough/shots/after.png) ![far](../secret.png)",
    "![gone](.walkthrough/shots/missing.png) ![hidden](../.secrets/key.png)",
    "![fake](.walkthrough/shots/fake.png) ![remote](https://example.com/shot.png) ![relative-remote](//cdn.example.com/x.png)",
    "",
    "```md",
    "![in-a-fence](.walkthrough/shots/missing-too.png)",
    "```",
    "And inline: `![code](nope.png)`.",
  ].join("\n");
  const { text, structured } = await sendResult(client, { project_path: project, body });
  expect(server.store.message(structured.message_id)?.body).toBe(body);
  expect(structured.images_not_shown).toEqual([
    { ref: ".walkthrough/shots/missing.png", reason: "does not exist yet; it will show if it is written there later", not_yet: true },
    { ref: "../.secrets/key.png", reason: "a .env file, or in a hidden folder of the home folder such as ~/.ssh" },
    { ref: ".walkthrough/shots/fake.png", reason: "not an image (png, jpg, gif, webp, svg, avif, bmp, ico)" },
    { ref: "https://example.com/shot.png", reason: "remote images never load in the Inbox" },
    { ref: "//cdn.example.com/x.png", reason: "remote images never load in the Inbox" },
  ]);
  expect(structured.images_not_shown_more).toBeUndefined();
  // What never shows and what is not written yet are told apart.
  expect(text).toContain("4 images will not show");
  expect(text).toContain("This image does not exist yet: .walkthrough/shots/missing.png");
  expect(text).toContain("//cdn.example.com/x.png (remote images never load in the Inbox)");
  expect(text).toContain("attach it with attachments");
  expect(text).not.toContain("missing-too.png");
  expect(text).not.toContain("nope.png");

  // The route never reads a protocol-relative source as a local path.
  const relativeRemote = await image(server, structured.message_id, "//cdn.example.com/x.png");
  expect(relativeRemote.status).toBe(403);
  expect(((await relativeRemote.json()) as { code: string }).code).toBe("image_not_referenced");

  // Every image shows (and a fenced block that mentions one): no warning at all.
  const clean = await sendResult(client, { project_path: project, body: "![ok](.walkthrough/shots/after.png)\n\n```\n![x](missing.png)\n```" });
  expect(clean.structured.images_not_shown).toBeUndefined();
  expect(clean.text).not.toContain("will not show");
  expect(clean.text).not.toContain("does not exist yet");
});

test("the warning names at most ten images and counts the rest", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const body = Array.from({ length: 13 }, (_, i) => `![r${i}](https://example.com/${i}.png)`).join(" ");
  const { text, structured } = await sendResult(await agent(server), { project_path: project, body });
  expect(structured.images_not_shown).toHaveLength(10);
  expect(structured.images_not_shown_more).toBe(3);
  expect(text).toContain("13 images will not show");
  expect(text).toContain("…and 3 more");
  expect(text).not.toContain("https://example.com/12.png");
});

test("a file Plannotator may not read is reported unreadable, not missing", async () => {
  // Root reads any file, so the refusal cannot be made there.
  if (process.getuid?.() === 0) return;
  const { project, dataDir } = world();
  const locked = join(project, ".walkthrough", "shots", "locked.png");
  writeFileSync(locked, png());
  chmodSync(locked, 0o000);
  try {
    const server = await start(dataDir);
    const { text, structured } = await sendResult(await agent(server), { project_path: project, body: "![l](.walkthrough/shots/locked.png)" });
    expect(structured.images_not_shown).toEqual([
      { ref: ".walkthrough/shots/locked.png", reason: "Plannotator can't read this file; on macOS the app running it may need to be allowed" },
    ]);
    expect(text).toContain("this image will not show");
    const answer = await image(server, structured.message_id, ".walkthrough/shots/locked.png");
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { code: string }).code).toBe("image_unreadable");
  } finally {
    chmodSync(locked, 0o644);
  }
});

test("submit_guide's result carries the same warning", async () => {
  const { project, dataDir } = world();
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  const server = await start(dataDir);
  const client = await agent(server);
  const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-export const a = 0;", "+export const a = 1;", ""].join("\n");
  const guide = { title: "One change", intent: "Shows a.", sections: [{ title: "The change", overview: "a moves to 1.", diffs: [{ file: "a.ts", summary: "Bumps a." }] }] };
  const result = (await client.callTool({
    name: "submit_guide",
    arguments: { project_path: project, guide, patch, body: "Before: ![shot](../.secrets/key.png)" },
  })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent.images_not_shown).toEqual([{ ref: "../.secrets/key.png", reason: "a .env file, or in a hidden folder of the home folder such as ~/.ssh" }]);
  expect(result.content[0]!.text).toContain("this image will not show: ../.secrets/key.png");
});

test("a person's own reply keeps the project boundary; an agent's message does not", async () => {
  const { root, project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: `![far](${join(root, "secret.png")})` });
  // The agent's image outside the project shows.
  expect((await image(server, sent.message_id, join(root, "secret.png"))).status).toBe(200);
  // The person's reply naming the same file (any client can post one: the window, a phone, a tailnet login) does not.
  const replied = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${sent.message_id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "k-person-1", words: `See ![p](${join(root, "secret.png")}), ![e](.walkthrough/shots/escape.png) and ![a](.walkthrough/shots/after.png)` }),
  });
  expect(replied.status).toBe(200);
  const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
  const outside = await image(server, replyId, join(root, "secret.png"));
  expect(outside.status).toBe(403);
  expect(((await outside.json()) as { code: string }).code).toBe("outside_project");
  // Through a symlink in the project that leads out: judged by where it leads.
  const escaped = await image(server, replyId, ".walkthrough/shots/escape.png");
  expect(escaped.status).toBe(403);
  expect(((await escaped.json()) as { code: string }).code).toBe("outside_project");
  // An image of the project still shows.
  expect((await image(server, replyId, ".walkthrough/shots/after.png")).status).toBe(200);
  // Nor does the background capture copy it into the Inbox.
  await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`);
  await server.imageCapture.idle();
  const captured = server.store.message(replyId)?.inline_images ?? [];
  expect(captured.map((i) => i.ref)).toEqual([".walkthrough/shots/after.png"]);
});

test("a project at the home folder, or above it, does not open its hidden folders", async () => {
  const { root, dataDir } = world();
  // A scratch home: never the real one.
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "shots"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id.png"), png());
  writeFileSync(join(home, "shots", "ok.png"), png());
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const server = await start(dataDir);
    const client = await agent(server);
    const atHome = await send(client, { project_path: home, body: "![k](.ssh/id.png) ![o](shots/ok.png)" });
    expect(atHome.project.root).toBe(home);
    const key = await image(server, atHome.message_id, ".ssh/id.png");
    expect(key.status).toBe(403);
    expect(((await key.json()) as { code: string }).code).toBe("image_hidden");
    expect((await image(server, atHome.message_id, "shots/ok.png")).status).toBe(200);
    // A project above the home folder exempts nothing below it either.
    const above = await send(client, { project_path: root, body: "![k](home/.ssh/id.png)" });
    expect(above.project.root).toBe(root);
    expect((await image(server, above.message_id, "home/.ssh/id.png")).status).toBe(403);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("a link kept in a hidden folder is refused by where it is kept, even when it leads somewhere plain", async () => {
  const { root, project, dataDir } = world();
  mkdirSync(join(root, ".cfg"), { recursive: true });
  writeFileSync(join(root, "pub.png"), png());
  symlinkSync(join(root, "pub.png"), join(root, ".cfg", "link.png"));
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![l](../.cfg/link.png) ![p](../pub.png)" });
  const link = await image(server, sent.message_id, "../.cfg/link.png");
  expect(link.status).toBe(403);
  expect(((await link.json()) as { code: string }).code).toBe("image_hidden");
  // The file it leads to, named plainly, shows.
  expect((await image(server, sent.message_id, "../pub.png")).status).toBe(200);
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

test("a base_path gone by serve time falls back to the project root", async () => {
  const { project, dataDir } = world();
  const sub = join(project, "packages", "gone");
  mkdirSync(sub, { recursive: true });
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: sub, body: "![a](.walkthrough/shots/after.png)" });
  expect(server.store.message(sent.message_id)?.base_path).toBe(sub);
  rmSync(sub, { recursive: true, force: true });
  expect((await image(server, sent.message_id, ".walkthrough/shots/after.png")).status).toBe(200);
  // The same rule read directly: a base that is gone starts at the root.
  const result = readInboxMessageImage({ body: "![a](.walkthrough/shots/after.png)", root: project, base: sub, path: ".walkthrough/shots/after.png" });
  expect(result.ok).toBe(true);
});

test("a cache validator: the ETag is the SHA-256 of the bytes served, If-None-Match answers 304 with the guard headers, a changed file gets a new ETag", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![a](.walkthrough/shots/after.png)" });
  const id = sent.message_id as string;
  const path = ".walkthrough/shots/after.png";

  const first = await image(server, id, path);
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(etag).toBe(`"${createHash("sha256").update(png()).digest("hex")}"`);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");

  for (const header of [etag!, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const again = await image(server, id, path, { "If-None-Match": header });
    expect([header, again.status]).toEqual([header, 304]);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("content-type")).toBe("image/png");
    expectGuardHeaders(again);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  }
  const stale = await image(server, id, path, { "If-None-Match": '"not-it"' });
  expect(stale.status).toBe(200);
  expect(new Uint8Array(await stale.arrayBuffer())).toEqual(png());

  // The agent rewrites the screenshot (same name, new bytes: a GIF now).
  writeFileSync(join(project, ".walkthrough", "shots", "after.png"), gif());
  const changed = await image(server, id, path, { "If-None-Match": etag! });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("content-type")).toBe("image/gif");
  expect(changed.headers.get("etag")).toBe(`"${createHash("sha256").update(gif()).digest("hex")}"`);
  expect(changed.headers.get("etag")).not.toBe(etag);
  expect(new Uint8Array(await changed.arrayBuffer())).toEqual(gif());
});

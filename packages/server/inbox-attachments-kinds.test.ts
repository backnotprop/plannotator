/**
 * Attachments of any kind (images, PDFs, other files) through a real Inbox:
 * an agent attaches over the MCP SDK's HTTP client, the window reads with
 * real `fetch`, and a paired phone reads the same bytes through its door.
 * Every test has its own temp data dir; nothing touches the real home.
 *
 * Proves: each kind from the bytes; a file outside the project attached by
 * its absolute path; the headers of the image, download and text routes per
 * kind; the text routes refusing a binary kind; a cross-site request refused
 * before anything is read; comments on images (with a marked-up copy) and on
 * code lines kept, a PDF refusing them; the markup removed with its thread;
 * and the phone's door answering with the window's own headers and the same
 * dotenv refusal.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { INBOX_VIEW_MAX_BYTES } from "@plannotator/core/inbox-types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { contentDisposition } from "./inbox-attachments";

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

/** A real 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20"/></svg>';
const PDF = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-kinds-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(join(project, "shots"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "shots", "checkout.png"), PNG);
  writeFileSync(join(project, "states.svg"), SVG);
  writeFileSync(join(project, "payments-api.pdf"), PDF);
  writeFileSync(join(project, "fixtures.zip"), ZIP);
  writeFileSync(join(project, "retry.mjs"), "export const MAX_ATTEMPTS = 5;\nexport function retry() {\n  return MAX_ATTEMPTS;\n}\n");
  // Outside the project, as a screenshot tool leaves it.
  const elsewhere = join(root, "tmp-shots");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "Screen Shot 2026-10-10 at 4.12.png"), PNG);
  return { root, project, elsewhere, dataDir: join(root, "data") };
}

async function start(dataDir: string, phones = false): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, ...(phones ? { phones: true } : {}) });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-kinds-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type Json = Record<string, any>;

async function send(client: Client, args: Record<string, unknown>): Promise<Json> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Json };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const ALL = ["shots/checkout.png", "states.svg", "payments-api.pdf", "fixtures.zip", "retry.mjs"];

test("each kind is read from the bytes, and a file outside the project is attached by its absolute path", async () => {
  const { project, elsewhere, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const outside = join(elsewhere, "Screen Shot 2026-10-10 at 4.12.png");
  const sent = await send(client, { project_path: project, body: "Everything.", attachments: [...ALL, outside] });
  expect(sent.attachments.map((a: Json) => [a.name, a.kind])).toEqual([
    ["checkout.png", "image"],
    ["states.svg", "image"],
    ["payments-api.pdf", "pdf"],
    ["fixtures.zip", "file"],
    ["retry.mjs", "code"],
    ["Screen Shot 2026-10-10 at 4.12.png", "image"],
  ]);
  expect(sent.attachments[5].path).toBe(outside);
  const listed = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as Json;
  const png = listed.attachments.find((a: Json) => a.name === "checkout.png");
  expect(png).toMatchObject({ media_type: "image/png", width: 1, height: 1, unavailable: null, changed_since_sent: false });
});

test("served headers per kind: an image as its sniffed type for <img>, a PDF and a file as downloads, text kinds refusing binary", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "Kinds.", attachments: ALL });
  const [png, svg, pdf, zip, code] = sent.attachments as Json[];
  const base = `http://127.0.0.1:${server.port}/api/inbox/attachments`;

  const image = await fetch(`${base}/${png!.id}/image`);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  expect(image.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
  expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(image.headers.get("content-disposition")).toStartWith("inline;");
  expect(image.headers.get("x-image-width")).toBe("1");
  expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  // Revalidation by the sent hash.
  const etag = image.headers.get("etag")!;
  expect((await fetch(`${base}/${png!.id}/image`, { headers: { "If-None-Match": etag } })).status).toBe(304);

  // An SVG goes out as an image (for <img>, where its script never runs), still sandboxed when opened directly.
  const vector = await fetch(`${base}/${svg!.id}/image?version=sent`);
  expect(vector.headers.get("content-type")).toBe("image/svg+xml");
  expect(vector.headers.get("content-security-policy")).toStartWith("sandbox");

  const download = await fetch(`${base}/${pdf!.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("application/pdf");
  expect(download.headers.get("content-disposition")).toBe(`attachment; filename="payments-api.pdf"; filename*=UTF-8''payments-api.pdf`);
  expect(download.headers.get("content-security-policy")).toBe("sandbox");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(download.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(await download.text()).toBe(PDF);

  const file = await fetch(`${base}/${zip!.id}/download`);
  expect(file.headers.get("content-type")).toBe("application/octet-stream");
  expect(file.headers.get("content-disposition")).toStartWith("attachment;");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(ZIP);
  // Every kind downloads, code included.
  expect((await fetch(`${base}/${code!.id}/download`)).headers.get("content-disposition")).toStartWith("attachment;");

  // The text routes never stream a binary kind as text; the image route takes images only.
  for (const id of [png!.id, pdf!.id, zip!.id]) {
    expect((await fetch(`${base}/${id}`)).status).toBe(415);
    expect((await fetch(`${base}/${id}/view`)).status).toBe(415);
  }
  expect((await fetch(`${base}/${pdf!.id}/image`)).status).toBe(415);
  // Another site's request is refused before anything is read.
  expect((await fetch(`${base}/${png!.id}/image`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  expect((await fetch(`${base}/${zip!.id}/download`, { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
});

test("a download's file name survives any characters: an ASCII fallback and the UTF-8 name", () => {
  expect(contentDisposition("attachment", 'Ü "quoted".pdf')).toBe(`attachment; filename="_ _quoted_.pdf"; filename*=UTF-8''%C3%9C%20%22quoted%22.pdf`);
});

test("an image that stops being one: the current version answers 409 and the sent version still opens", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "Shot.", attachments: ["shots/checkout.png"] });
  const id = sent.attachments[0].id;
  writeFileSync(join(project, "shots", "checkout.png"), "<html>not an image</html>");
  const base = `http://127.0.0.1:${server.port}/api/inbox/attachments/${id}`;
  expect((await fetch(`${base}/image`)).status).toBe(409);
  const sentVersion = await fetch(`${base}/image?version=sent`);
  expect(sentVersion.headers.get("content-type")).toBe("image/png");
});

test("comments on an image (with a marked-up copy) and on code lines are kept; a PDF takes none; the markup goes with its thread", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "Look.", attachments: ["shots/checkout.png", "retry.mjs", "payments-api.pdf"] });
  const [png, code, pdf] = sent.attachments as Json[];
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });

  // The marked-up image: kept once by its hash, shown back by name only.
  const markup = await fetch(`${origin}/api/inbox/markups?serverSession=${server.serverSession}`, { method: "POST", headers: { "Content-Type": "image/png", Origin: origin }, body: PNG });
  expect(markup.status).toBe(200);
  const kept = (await markup.json()) as Json;
  expect(kept.path).toStartWith(join(dataDir, "inbox", "markups"));
  const shown = await fetch(`${origin}${kept.url}`);
  expect(shown.headers.get("content-type")).toBe("image/png");
  expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
  // A page on another site cannot post one; a body that is not an image is refused.
  expect((await fetch(`${origin}/api/inbox/markups`, { method: "POST", headers: { Origin: "https://evil.example" }, body: PNG })).status).toBe(403);
  expect((await fetch(`${origin}/api/inbox/markups`, { method: "POST", headers: { Origin: origin }, body: "<svg/>" })).status).toBe(422);

  const onImage = await post("/api/inbox/annotations", {
    attachment_id: png.id,
    version: "current",
    annotation: { id: "ann-img", type: "COMMENT", text: "The button is cut off.", originalText: "checkout.png", blockId: "image", startOffset: 0, endOffset: 0, createdA: 1, images: [{ path: kept.path, name: "checkout-markup" }] },
  });
  expect(onImage.status).toBe(200);
  const onCode = await post("/api/inbox/annotations", {
    attachment_id: code.id,
    version: "current",
    annotation: { id: "ann-code", type: "COMMENT", text: "Five is too many.", originalText: "export const MAX_ATTEMPTS = 5;", blockId: "code-L1-1", startOffset: 0, endOffset: 0, createdA: 2, inboxCode: { lineStart: 1, lineEnd: 1 } },
  });
  expect(onCode.status).toBe(200);
  const onPdf = await post("/api/inbox/annotations", { attachment_id: pdf.id, version: "current", annotation: { id: "ann-pdf", type: "COMMENT", text: "x" } });
  expect(onPdf.status).toBe(422);
  expect(((await onPdf.json()) as Json).code).toBe("annotation_not_allowed");

  const markups = join(dataDir, "inbox", "markups");
  expect(readdirSync(markups)).toEqual([kept.name]);
  expect((await post(`/api/inbox/threads/${sent.thread_id}/delete`, {})).status).toBe(200);
  expect(existsSync(join(markups, kept.name))).toBe(false);
});

test("the phone's door: an image, a PDF and a file with the window's own headers; the dotenv refusal is the same check", async () => {
  const { project, dataDir } = world();
  // The relay is never reached from a test: a port nothing answers on (restored after each test).
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  const server = await start(dataDir, true);
  const origin = `http://127.0.0.1:${server.port}`;
  const made = (await (await fetch(`${origin}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
  const paired = (await (
    await fetch(`${origin}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })
  ).json()) as Json;
  const door = (path: string) => fetch(`${origin}/api/inbox/device/${path}`, { headers: { Authorization: `Bearer ${paired.token}` } });

  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "For the phone.", attachments: ["shots/checkout.png", "payments-api.pdf", "fixtures.zip"] });
  const [png, pdf, zip] = sent.attachments as Json[];
  const HEADERS = ["content-type", "content-security-policy", "content-disposition", "x-content-type-options", "cross-origin-resource-policy", "cache-control", "content-length"];
  for (const [id, route] of [
    [png.id, "image"],
    [png.id, "download"],
    [pdf.id, "download"],
    [zip.id, "download"],
  ] as const) {
    const fromWindow = await fetch(`${origin}/api/inbox/attachments/${id}/${route}`);
    const fromPhone = await door(`attachments/${id}/${route}`);
    expect([route, fromPhone.status]).toEqual([route, 200]);
    for (const name of HEADERS) expect([route, name, fromPhone.headers.get(name)]).toEqual([route, name, fromWindow.headers.get(name)]);
    expect(Buffer.from(await fromPhone.arrayBuffer()).equals(Buffer.from(await fromWindow.arrayBuffer()))).toBe(true);
  }
  expect((await door(`attachments/${pdf.id}/image`)).status).toBe(415);

  // A record naming a dotenv file (one an older Inbox, or a hand-edited store,
  // could hold) is refused at serve time by the same check on both doors.
  writeFileSync(join(project, ".env"), "STRIPE_KEY=sk_live_secret\n");
  const projectRecord = server.store.listProjects().find((p) => p.root === project)!;
  const forged = server.store.sendMessage({
    project_id: projectRecord.id,
    author: { kind: "agent", host: null, session: null, name: "Forger" } as never,
    body: "A forged record.",
    attachments: [
      { id: "att_01J00000000000000000000ENV", path: join(project, ".env"), named_path: null, name: ".env", kind: "file", sent_sha256: "0".repeat(64), size: 26, sent_at: new Date().toISOString(), sent_mtime: new Date().toISOString() },
    ],
  });
  const envId = forged.message.attachments![0]!.id;
  const windowAnswer = await fetch(`${origin}/api/inbox/attachments/${envId}/download`);
  const phoneAnswer = await door(`attachments/${envId}/download`);
  expect(windowAnswer.status).toBe(409);
  expect(phoneAnswer.status).toBe(409);
  expect(((await phoneAnswer.json()) as Json).code).toBe("attachment_changed_type");
  expect(await windowAnswer.text()).not.toContain("sk_live_secret");
});

test("a text file that grew past the view limit answers 413 attachment_too_large on the window's text routes and the phone's view; it still downloads", async () => {
  const { project, dataDir } = world();
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  const server = await start(dataDir, true);
  const origin = `http://127.0.0.1:${server.port}`;
  const made = (await (await fetch(`${origin}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
  const paired = (await (
    await fetch(`${origin}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })
  ).json()) as Json;
  writeFileSync(join(project, "worker.log"), "started\n");
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "The log.", attachments: ["worker.log"] });
  const id = sent.attachments[0].id as string;
  expect(sent.attachments[0].kind).toBe("text");
  appendFileSync(join(project, "worker.log"), Buffer.alloc(INBOX_VIEW_MAX_BYTES, 0x61));
  for (const path of [`/api/inbox/attachments/${id}/view`, `/api/inbox/attachments/${id}`]) {
    const answer = await fetch(`${origin}${path}`);
    expect([path, answer.status, ((await answer.json()) as Json).code]).toEqual([path, 413, "attachment_too_large"]);
  }
  const door = await fetch(`${origin}/api/inbox/device/attachments/${id}/view`, { headers: { Authorization: `Bearer ${paired.token}` } });
  expect(door.status).toBe(413);
  expect(((await door.json()) as Json).code).toBe("attachment_too_large");
  // The sent version still reads, and the grown file still downloads.
  expect(((await (await fetch(`${origin}/api/inbox/attachments/${id}/view?version=sent`)).json()) as Json).text).toBe("started\n");
  const download = await fetch(`${origin}/api/inbox/attachments/${id}/download`);
  expect(download.status).toBe(200);
  expect((await download.arrayBuffer()).byteLength).toBe(INBOX_VIEW_MAX_BYTES + 8);
  // The cross-site check guards the view and the listing too.
  expect((await fetch(`${origin}/api/inbox/attachments/${id}/view`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  expect((await fetch(`${origin}/api/inbox/threads/${sent.thread_id}/attachments`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
});

test("an HTML page attached from a home folder exposes no hidden file and no .env through its asset route; nested documents get no network", async () => {
  const { root, project, dataDir } = world();
  // A fake home: the page sits at its top, beside dot folders holding secrets.
  const home = join(root, "fake-home");
  mkdirSync(join(home, ".docker"), { recursive: true });
  mkdirSync(join(home, ".plannotator"), { recursive: true });
  mkdirSync(join(home, "img"), { recursive: true });
  writeFileSync(join(home, ".docker", "config.json"), '{"auths":{"registry":{"auth":"c2VjcmV0"}}}');
  writeFileSync(join(home, ".plannotator", "config.json"), '{"bitbucketToken":"secret"}');
  writeFileSync(join(home, "prod.env"), "STRIPE_KEY=secret\n");
  writeFileSync(join(home, "img", "logo.png"), PNG);
  writeFileSync(join(home, "frame.html"), "<p>frame</p>");
  // An innocent name linked to a hidden file is judged by where it leads.
  symlinkSync(join(home, ".docker", "config.json"), join(home, "settings.json"));
  writeFileSync(join(home, "report.html"), '<!doctype html><img src="img/logo.png"><iframe src="frame.html"></iframe>');
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "The report.", attachments: [join(home, "report.html")] });
  const view = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${sent.attachments[0].id}/view`)).json()) as Json;
  const base = /<base href="(\/api\/html-assets\/[^"]+\/)">/.exec(view.html)?.[1];
  expect(base).toBeTruthy();
  const asset = (path: string) => fetch(`http://127.0.0.1:${server.port}${base}${path}`);
  expect((await asset("img/logo.png")).status).toBe(200);
  for (const path of [".docker/config.json", ".plannotator/config.json", "%2Edocker/config.json", "prod.env", "settings.json"]) {
    const answer = await asset(path);
    // Hidden paths are 404 by the Inbox's rule; a dotenv name is never a served asset type at all.
    expect([path, answer.status]).toEqual([path, path === "prod.env" ? 415 : 404]);
    expect(await answer.text()).not.toContain("secret");
  }
  const nested = await asset("frame.html");
  expect(nested.status).toBe(200);
  expect(nested.headers.get("content-security-policy")).toBe("sandbox allow-scripts; connect-src 'none'");
});

test("deleting a thread removes the markups its annotations named and leaves a markup no annotation names yet", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const sent = await send(client, { project_path: project, body: "Shot.", attachments: ["shots/checkout.png"] });
  const upload = async (bytes: Uint8Array) =>
    (await (await fetch(`${origin}/api/inbox/markups`, { method: "POST", headers: { Origin: origin, "Content-Type": "image/png" }, body: bytes })).json()) as Json;
  const named = await upload(PNG);
  // A second, different PNG: uploaded, its comment not saved yet.
  const pending = await upload(Buffer.concat([PNG, Buffer.from([0])]));
  expect(pending.name).not.toBe(named.name);
  const saved = await fetch(`${origin}/api/inbox/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ attachment_id: sent.attachments[0].id, version: "current", annotation: { id: "ann-m", type: "COMMENT", text: "x", originalText: "checkout.png", blockId: "image", startOffset: 0, endOffset: 0, createdA: 1, images: [{ path: named.path, name: "m" }] } }),
  });
  expect(saved.status).toBe(200);
  await fetch(`${origin}/api/inbox/threads/${sent.thread_id}/delete`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" });
  expect(existsSync(named.path)).toBe(false);
  expect(existsSync(pending.path)).toBe(true);
});

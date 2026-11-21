/**
 * Nothing a paired cloud agent writes makes the Inbox read a picture from the person's disk, wherever it names one
 * (inbox-cloud-pictures.ts), while an agent on this computer still shows a picture by its path. On a store, with no
 * Inbox running. The failures these guard: the background capture copying a picture a cloud agent's message names
 * (a routine change line, any message), so its bytes become a file of the thread; the window's image route reading it
 * live; a cloud agent's attached Markdown file or HTML page showing a picture from the person's disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInboxCloudAuthor } from "@plannotator/core/inbox-cloud";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload } from "@plannotator/shared/inbox/uploads";
import { createInboxAttachmentRoutes, createInboxHtmlAssets } from "./inbox-attachments";
import { createInboxImageCapture, inboxMessageImageRoute } from "./inbox-message-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CLOUD = { kind: "agent" as const, host: "cloud-grok", session: "cloud.0123456789ab", name: "Nightly fixer" };
const LOCAL = { kind: "agent" as const, host: "codex", session: "ses-codex", name: "Codex" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A store, a project, and the person's own picture somewhere on their disk (`scan`). */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cloud-pictures-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const projectRoot = join(root, "ledger");
  const desk = join(root, "desk");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(desk, { recursive: true });
  const scan = join(desk, "scan.png");
  writeFileSync(scan, PNG);
  writeFileSync(join(desk, "clip.mp4"), Buffer.alloc(64));
  const project = store.ensureProject({ name: "ledger", root: projectRoot });
  const send = (author: typeof CLOUD | typeof LOCAL, body: string, extra: Record<string, unknown> = {}) =>
    store.sendMessage({ project_id: project.id, author, body, subject: `From ${author.name}`, ...extra }).message;
  const image = async (messageId: string, src: string) => {
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(src)}`);
    return (await inboxMessageImageRoute(new Request(url), url, store))!;
  };
  return { root, store, project, desk, scan, send, image };
}

describe("who counts as a cloud agent", () => {
  test("by its host or its session, either alone; a person or an agent here does not", () => {
    for (const author of [CLOUD, { ...CLOUD, session: null }, { ...CLOUD, host: null }, { kind: "agent", host: "cloud", session: null }, { kind: "agent", host: "cloud-new-preset", session: "x" }]) {
      expect([author, isInboxCloudAuthor(author)]).toEqual([author, true]);
    }
    for (const author of [LOCAL, { kind: "person" }, { kind: "agent", host: "cloudflare", session: "ses-1" }, null]) expect([author, isInboxCloudAuthor(author)]).toEqual([author, false]);
  });
});

describe("the background capture", () => {
  test("never reads a picture a cloud agent's message names; an agent here still has its picture copied by its path", async () => {
    const w = world();
    const body = (scan: string) => `Look: ![s](${scan}) and <img src="${scan}">`;
    const cloud = w.send(CLOUD, body(w.scan));
    const local = w.send(LOCAL, body(w.scan));
    const capture = createInboxImageCapture(w.store, { pauseMs: 0 });
    capture.schedule(cloud.thread_id);
    capture.schedule(local.thread_id);
    await capture.idle();
    capture.stop();
    expect(w.store.message(cloud.id)!.inline_images ?? []).toEqual([]);
    expect(w.store.message(local.id)!.inline_images!.map((image) => [image.ref, image.path, image.size])).toEqual([[w.scan, w.scan, PNG.length]]);
  });
});

describe("the window's image route", () => {
  test("a cloud agent's picture not captured at send is not found, its sound or video too; nothing is read from disk. An agent here's shows", async () => {
    const w = world();
    const clip = join(w.desk, "clip.mp4");
    const cloud = w.send(CLOUD, `![s](${w.scan}) ![v](${clip})`);
    for (const src of [w.scan, clip]) expect([src, (await w.image(cloud.id, src)).status]).toEqual([src, 404]);
    expect(await (await w.image(cloud.id, w.scan)).json()).toMatchObject({ code: "image_not_attached" });
    const local = w.send(LOCAL, `![s](${w.scan})`);
    const shown = await w.image(local.id, w.scan);
    expect([shown.status, Buffer.from(await shown.arrayBuffer())]).toEqual([200, PNG]);
  });
});

describe("a cloud agent's attached files", () => {
  const routes = (store: InboxStore) => createInboxAttachmentRoutes({ store, serverSession: "srv", readBody: async (req) => (await req.json()) as Record<string, unknown> });

  test("its Markdown file shows no picture from the person's disk; an agent here's does", async () => {
    const w = world();
    const notes = join(w.project.root, "notes.md");
    writeFileSync(notes, `# Notes\n\n![s](${w.scan})\n`);
    const handle = routes(w.store);
    for (const [author, status] of [[CLOUD, 404], [LOCAL, 200]] as const) {
      const attachments = await recordInboxAttachments(w.store.dir, [notes], { base: w.project.root, at: new Date().toISOString() });
      const message = w.send(author, "The notes.", { attachments });
      const url = new URL(`http://127.0.0.1/api/inbox/attachments/${message.attachments![0]!.id}/markdown-image?path=${encodeURIComponent(w.scan)}`);
      expect([author.name, (await handle(new Request(url), url))!.status]).toEqual([author.name, status]);
    }
  });

  test("its HTML page (uploaded bytes) gets no address for a picture outside its folder; a page an agent here attached does", async () => {
    const w = world();
    const html = `<!doctype html><img id="p" src="${w.scan}">`;
    const at = new Date().toISOString();
    const pageOf = async (author: typeof CLOUD | typeof LOCAL) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(html));
          controller.close();
        },
      });
      const { upload_id } = await receiveInboxUpload(w.store.dir, "page.html", stream, { at });
      const attachments = await inboxUploadAttachments(w.store.dir, [upload_id], at);
      return w.send(author, "The page.", { attachments }).attachments![0]!.path;
    };
    const assets = createInboxHtmlAssets(w.store);
    const cloudPage = assets.rewriteHtml(html, await pageOf(CLOUD));
    const localPage = assets.rewriteHtml(html, await pageOf(LOCAL));
    expect(cloudPage).toContain(`src="${w.scan}"`);
    expect(cloudPage).not.toMatch(/src="\/api\/html-assets\//);
    expect(localPage).toMatch(/src="\/api\/html-assets\/[0-9a-f]+\/scan\.png"/);
  });
});

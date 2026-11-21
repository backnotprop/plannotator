/**
 * A cloud agent's message shows pictures as a local agent's does (inbox-cloud-pictures.ts): read from the person's disk
 * by the path it writes, and a picture it sent as bytes from the Inbox's own copy. On a store, with no Inbox running.
 * The failures these guard: the background capture or the window's image route treating a cloud agent's message by a
 * rule of its own; a picture captured from bytes sent with the message read from a file of that name on disk instead;
 * a file that is not a picture taken as one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxSendUploadPictures } from "./inbox-cloud-pictures";
import { createInboxImageCapture, inboxMessageImageRoute, inboxPictureFromUpload } from "./inbox-message-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
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
  const project = store.ensureProject({ name: "ledger", root: projectRoot });
  const send = (author: typeof CLOUD | typeof LOCAL, body: string, extra: Record<string, unknown> = {}) =>
    store.sendMessage({ project_id: project.id, author, body, subject: `From ${author.name}`, ...extra }).message;
  const image = async (messageId: string, src: string) => {
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(src)}`);
    return (await inboxMessageImageRoute(new Request(url), url, store))!;
  };
  return { root, store, project, desk, scan, send, image };
}

describe("a picture by its path, whoever wrote the message", () => {
  test("the background capture copies it and the window's image route shows it, for a cloud agent as for an agent here", async () => {
    const w = world();
    const body = `Look: ![s](${w.scan})`;
    const cloud = w.send(CLOUD, body);
    const local = w.send(LOCAL, body);
    for (const id of [cloud.id, local.id]) {
      const shown = await w.image(id, w.scan);
      expect([id, shown.status, Buffer.from(await shown.arrayBuffer())]).toEqual([id, 200, PNG]);
    }
    const capture = createInboxImageCapture(w.store, { pauseMs: 0 });
    capture.schedule(cloud.thread_id);
    capture.schedule(local.thread_id);
    await capture.idle();
    capture.stop();
    for (const id of [cloud.id, local.id]) expect(w.store.message(id)!.inline_images!.map((image) => [image.ref, image.path])).toEqual([[w.scan, w.scan]]);
  });
});

describe("a picture sent as bytes", () => {
  test("only a picture file is matched to a src; the rest stay below the message", () => {
    const uploads = [
      { id: "upl_1", name: "chart.png", kind: "image", path: "/blobs/1" },
      { id: "upl_2", name: "notes.md", kind: "markdown", path: "/blobs/2" },
    ];
    const { pictures, attachments } = inboxSendUploadPictures("![c](chart.png) ![n](notes.md) ![d](/Users/p/desk.png)", uploads, ["upl_1", "upl_2", "/Users/p/report.pdf"]);
    expect([...pictures].map(([src, file]) => [src, file.id])).toEqual([["chart.png", "upl_1"]]);
    expect(attachments).toEqual(["upl_2", "/Users/p/report.pdf"]);
  });

  test("the window shows one captured from bytes from the Inbox's copy, before a file of the same name in the project", async () => {
    const w = world();
    writeFileSync(join(w.project.root, "chart.png"), PNG);
    const blob = inboxBlobPath(w.store.dir, "a".repeat(64));
    mkdirSync(join(w.store.dir, "blobs"), { recursive: true });
    writeFileSync(blob, GIF);
    const record = { id: "att_UP", path: realpathSync(blob), named_path: null, name: "chart.png", kind: "image", sent_sha256: "a".repeat(64), size: GIF.length, sent_at: "2026-11-21T00:00:00.000Z", sent_mtime: "2026-11-21T00:00:00.000Z", ref: "chart.png" };
    expect(inboxPictureFromUpload(w.store.dir, record as never)).toBe(true);
    expect(inboxPictureFromUpload(w.store.dir, { ...record, path: join(w.project.root, "chart.png") } as never)).toBe(false);
    const message = w.send(CLOUD, "![c](chart.png)", { inline_images: [record] });
    const shown = await w.image(message.id, "chart.png");
    expect([shown.status, Buffer.from(await shown.arrayBuffer())]).toEqual([200, GIF]);
  });
});

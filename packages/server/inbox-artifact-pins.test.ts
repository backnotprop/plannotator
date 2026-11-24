/**
 * The Artifacts wall's read and the artifact pin routes (inbox-artifact-pins.ts),
 * on a real store without a server. What can regress: the order (newest message
 * first, a message's own order inside it), the filters (pinned, type, archived
 * out by default), the counts the filter bar shows, paging that skips or repeats
 * a row, and the route guards (another site, a stale page's serverSession).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import type { InboxArtifactsPage } from "@plannotator/core/inbox-artifact-pins";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { readInboxAttachmentText, recordInboxAttachments, sentDiagramIdentity } from "@plannotator/shared/inbox/attachments";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxArtifactPins, inboxArtifactsPage } from "./inbox-artifact-pins";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });

function file(name: string, kind: InboxAttachment["kind"]): InboxAttachment {
  const at = new Date().toISOString();
  return { id: inboxId("att"), path: `/nowhere/${name}`, named_path: null, name, kind, sent_sha256: "0".repeat(64), size: 10, sent_at: at, sent_mtime: at };
}

/** Three threads: "web" (a page, then two pictures), "docs" (a doc and a plain file), "old" (archived, a picture). */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-wall-"));
  roots.push(dir);
  let t = Date.parse("2026-11-08T09:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((t += 60_000)) });
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  const f = {
    oldShot: file("old.png", "image"),
    page: file("checkout.html", "html"),
    doc: file("plan.md", "markdown"),
    zip: file("build.zip", "file"),
    shotA: file("a.png", "image"),
    shotB: file("b.png", "image"),
  };
  const old = store.sendMessage({ project_id: project.id, author: agent("ses_o"), thread: "old", subject: "Old work", body: "Old", attachments: [f.oldShot] }).message;
  store.resolveThread(old.thread_id, true, "person");
  const web = store.sendMessage({ project_id: project.id, author: agent("ses_w"), thread: "web", subject: "Checkout", body: "Page", attachments: [f.page] }).message;
  const docs = store.sendMessage({ project_id: project.id, author: agent("ses_d"), thread: "docs", subject: "Docs", body: "Docs", attachments: [f.doc, f.zip] }).message;
  store.sendMessage({ project_id: project.id, author: agent("ses_w"), thread: "web", body: "Pictures", attachments: [f.shotA, f.shotB] });
  return { store, f, old, web, docs };
}

function hasSameFileIdentity(first: Stats, next: Stats) {
  return first.ino !== 0 && first.birthtimeMs > 0 && first.dev === next.dev
    && first.ino === next.ino && first.birthtimeMs === next.birthtimeMs;
}

test("a verified rename and session restart retain the pin; without matching file identity each sent edition opens separately", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-diagram-pin-"));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "repo", root });
  const spec = (title: string) => JSON.stringify({ id: "payment-flow", title, columns: [{ id: "api", title: "API" }] });
  async function send(name: string, session: string) {
    const [attachment] = await recordInboxAttachments(store.dir, [name], { base: root, at: new Date().toISOString() });
    const message = store.sendMessage({ project_id: project.id, author: agent(session), thread: "payments", body: name, attachments: [attachment!] }).message;
    return { attachment: attachment!, message };
  }
  const firstName = "checkout.diagram.json", nextName = "payment-capture.diagram.json";
  writeFileSync(join(root, firstName), spec("Original"));
  const before = statSync(join(root, firstName));
  const first = await send(firstName, "original-session");
  expect(first.attachment.diagram_id).toBe("payment-flow");
  store.setArtifactPinned(first.message.thread_id, first.attachment.id, true);
  renameSync(join(root, firstName), join(root, nextName));
  writeFileSync(join(root, nextName), spec("Revised"));
  const after = statSync(join(root, nextName));
  const next = await send(nextName, "restarted-session");
  expect(next.message.thread_id).toBe(first.message.thread_id);
  writeFileSync(join(root, nextName), spec("Unsent edits"));

  const reopened = InboxStore.open(join(root, "data"));
  const pinned = await page(reopened, "?pinned=1");
  expect(pinned.artifacts).toHaveLength(1);
  const renameVerified = hasSameFileIdentity(before, after);
  const pinnedEdition = renameVerified ? next : first;
  expect(pinned.artifacts[0]).toMatchObject({ key: first.attachment.id, message_id: pinnedEdition.message.id, attachment: { id: pinnedEdition.attachment.id } });
  expect((await page(reopened)).total).toBe(renameVerified ? 1 : 2);
  for (const [entry, title] of [[first, "Original"], [next, "Revised"]] as const) {
    const result = await readInboxAttachmentText(store.dir, entry.attachment, "sent");
    expect(result.ok && result.bytes.toString()).toBe(spec(title));
  }
  expect(reopened.setArtifactPinned(first.message.thread_id, pinnedEdition.attachment.id, false)).toEqual([]);
});

test("copied diagram IDs keep independent wall entries and pins, including when a vacated name is reused", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-diagram-copy-"));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "repo", root });
  const send = async (session: string, ...names: string[]) => {
    const files = await recordInboxAttachments(store.dir, names, { base: root, at: new Date().toISOString() });
    const message = store.sendMessage({ project_id: project.id, author: agent(session), thread: "copies", body: "Drawings", attachments: files }).message;
    return { files, message };
  };
  const first = "one.diagram.json", other = "two.diagram.json", renamed = "new-name.diagram.json";
  const spec = (title: string, id = "  reused  ") => JSON.stringify({ id, title, columns: [{title: "Subject"}] });
  for (const name of [first, other]) writeFileSync(join(root, name), spec(name));
  const before = statSync(join(root, first));
  const { files, message } = await send("original", first, other);
  expect(files.map(f => f.diagram_id)).toEqual(["reused", "reused"]);
  expect(keys(await page(store))).toEqual(files.map(f => f.id));
  store.setArtifactPinned(message.thread_id, files[0]!.id, true);
  renameSync(join(root, first), join(root, renamed));
  const edition = (await send("original", renamed)).files[0]!;
  writeFileSync(join(root, first), spec("A separate file at the old name"));
  const replacement = (await send("restarted", first)).files[0]!;
  const reopened = InboxStore.open(join(root, "data"));
  const renameVerified = hasSameFileIdentity(before, statSync(join(root, renamed)));
  expect((await page(reopened)).total).toBe(renameVerified ? 3 : 4);
  expect((await page(reopened, "?pinned=1")).artifacts[0]).toMatchObject({key: files[0]!.id, attachment: {id: renameVerified ? edition.id : files[0]!.id}});
  expect(keys(await page(reopened))).toContain(replacement.id);
});

test("missing filesystem creation time retains the drawing ID but cannot verify a rename or session restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-diagram-stat-"));
  roots.push(root);
  const file = join(root, "flow.diagram.json");
  const bytes = Buffer.from(JSON.stringify({ id: "flow", title: "Drawing" }));
  writeFileSync(file, bytes);
  // Use the real file's stat with the unavailable birthtime reported by some Linux filesystems.
  const stat = Object.assign(statSync(file), { birthtimeMs: 0 });
  expect(await sentDiagramIdentity("plannotator-diagram", bytes.length, file, bytes, stat)).toEqual({ diagram_id: "flow" });
});

test("invalid diagram metadata omits the identity while retaining the attachment and its sent bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbox-diagram-id-"));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "repo", root });
  for (const [index, raw] of [" ", "a".repeat(257), 7, " z ", "x".repeat(256)].entries()) {
    const name = `case-${index}.diagram.json`, source = JSON.stringify({id: raw, title: "Subject"});
    writeFileSync(join(root, name), source);
    const [sent] = await recordInboxAttachments(store.dir, [name], {base: root, at: new Date().toISOString()});
    const expected = index === 3 ? "z" : index === 4 ? raw : undefined;
    expect(sent!.diagram_id).toBe(expected);
    // Replay the record format used before IDs were screened at ingestion.
    const message = store.sendMessage({project_id: project.id, author: agent("a"), thread: "ids", body: name,
      attachments: [{...sent!, diagram_id: raw as string}]}).message;
    const stored = InboxStore.open(join(root, "data")).message(message.id)!.attachments![0]!;
    expect(stored.diagram_id).toBe(expected);
    const read = await readInboxAttachmentText(store.dir, stored, "sent");
    expect(read.ok && read.bytes.toString()).toBe(source);
  }
});

const page = (store: InboxStore, query = "") => inboxArtifactsPage(store, new URL(`http://localhost/api/inbox/artifacts${query}`));
const keys = (p: InboxArtifactsPage) => p.artifacts.map((a) => a.key);

async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("the Artifacts wall read", () => {
  test("newest message first, a message's own order inside it; archived threads out by default", async () => {
    const { store, f, web } = world();
    const all = await page(store);
    expect(keys(all)).toEqual([f.shotA.id, f.shotB.id, f.doc.id, f.zip.id, f.page.id]);
    expect(all.total).toBe(5);
    expect(all.next_cursor).toBeNull();
    const first = all.artifacts[0]!;
    expect(first.thread_id).toBe(web.thread_id);
    expect(first.thread_title).toBe("Checkout");
    expect(first.type).toBe("images");
    expect(first.attachment?.id).toBe(f.shotA.id);
    expect(first.pinned_at).toBeNull();
    const withArchived = await page(store, "?archived=include");
    expect(keys(withArchived)).toContain(f.oldShot.id);
    expect(withArchived.artifacts.find((a) => a.key === f.oldShot.id)!.archived).toBe(true);
  });

  test("type and pinned filters, with the counts the filter bar shows", async () => {
    const { store, f, web, docs } = world();
    store.setArtifactPinned(web.thread_id, f.shotB.id, true);
    store.setArtifactPinned(docs.thread_id, f.doc.id, true);
    expect(keys(await page(store, "?type=images"))).toEqual([f.shotA.id, f.shotB.id]);
    expect(keys(await page(store, "?type=pages"))).toEqual([f.page.id]);
    expect(keys(await page(store, "?type=documents"))).toEqual([f.doc.id]);
    expect(keys(await page(store, "?type=other"))).toEqual([f.zip.id]);
    const pinned = await page(store, "?pinned=1");
    expect(keys(pinned)).toEqual([f.shotB.id, f.doc.id]);
    expect(pinned.artifacts[0]!.pinned_at).toEqual(expect.any(String));
    // All / Pinned under the type; each type under the pinned filter.
    expect(pinned.counts).toEqual({ all: 5, pinned: 2, types: { images: 1, videos: 0, pages: 0, documents: 1, other: 0 } });
    expect((await page(store, "?type=images")).counts).toEqual({ all: 2, pinned: 1, types: { images: 2, videos: 0, pages: 1, documents: 1, other: 1 } });
    expect(keys(await page(store, "?pinned=1&type=images"))).toEqual([f.shotB.id]);
    // A pin on an archived thread shows only with archived included.
    const { old } = { old: store.threadIds().find((id) => store.thread(id)!.subject === "Old work")! };
    store.setArtifactPinned(old, f.oldShot.id, true);
    expect(keys(await page(store, "?pinned=1"))).toEqual([f.shotB.id, f.doc.id]);
    expect(keys(await page(store, "?pinned=1&archived=include"))).toEqual([f.shotB.id, f.doc.id, f.oldShot.id]);
  });

  test("a video is under Videos, not Images; a recording stays under Other files", async () => {
    const { store, f, web } = world();
    const clip = file("walkthrough.mp4", "video");
    const webm = file("checkout.webm", "video");
    const voice = file("note.wav", "audio");
    store.sendMessage({ project_id: web.project_id, author: agent("ses_w"), thread: "web", body: "Clips", attachments: [clip, webm, voice] });
    const videos = await page(store, "?type=videos");
    expect(keys(videos)).toEqual([clip.id, webm.id]);
    expect(videos.artifacts.map((a) => a.type)).toEqual(["videos", "videos"]);
    expect(keys(await page(store, "?type=images"))).toEqual([f.shotA.id, f.shotB.id]);
    expect(keys(await page(store, "?type=other"))).toEqual([voice.id, f.zip.id]);
    expect(videos.counts.types).toEqual({ images: 2, videos: 2, pages: 1, documents: 1, other: 2 });
  });

  test("paging walks every row once, in order", async () => {
    const { store } = world();
    const whole = keys(await page(store, "?archived=include"));
    const walked: string[] = [];
    let cursor: string | null = "0";
    let reads = 0;
    while (cursor !== null) {
      const next: InboxArtifactsPage = await page(store, `?archived=include&limit=2&cursor=${cursor}`);
      expect(next.total).toBe(whole.length);
      walked.push(...keys(next));
      cursor = next.next_cursor;
      reads += 1;
    }
    expect(walked).toEqual(whole);
    expect(reads).toBe(3);
    expect(keys(await page(store, "?cursor=99"))).toEqual([]);
  });

  test("bad filters are refused", async () => {
    const { store } = world();
    for (const query of ["?type=movies", "?archived=only", "?pinned=yes", "?limit=0", "?limit=201", "?cursor=-1", "?cursor=1.5"]) {
      expect(await refused(() => page(store, query))).toBe("validation_error");
    }
  });
});

describe("the artifact pin routes", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  function routes(store: InboxStore) {
    return createInboxArtifactPins({ store, serverSession: "run-1", readBody: async (req) => (await req.json()) as Record<string, unknown>, json });
  }
  const post = (body: unknown) => new Request("http://localhost/api/inbox/artifact-pins", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

  test("pin, unpin and read back; another site's read and a stale page's write are refused", async () => {
    const { store, f, web } = world();
    const r = routes(store);
    const pinned = await r.route(post({ serverSession: "run-1", thread_id: web.thread_id, key: f.shotA.id, pinned: true }), new URL("http://localhost/api/inbox/artifact-pins"));
    expect(pinned!.status).toBe(200);
    expect(((await pinned!.json()) as { pins: { key: string }[] }).pins.map((p) => p.key)).toEqual([f.shotA.id]);
    const read = await r.route(new Request("http://localhost/api/inbox/artifact-pins"), new URL("http://localhost/api/inbox/artifact-pins"));
    expect(((await read!.json()) as { pins: { key: string; thread_id: string }[] }).pins).toEqual([expect.objectContaining({ key: f.shotA.id, thread_id: web.thread_id })]);
    const stale = await r.route(post({ serverSession: "run-0", thread_id: web.thread_id, key: f.shotA.id, pinned: false }), new URL("http://localhost/api/inbox/artifact-pins"));
    expect(stale!.status).toBe(409);
    expect(store.artifactPins()).toHaveLength(1);
    const cross = new Request("http://localhost/api/inbox/artifacts", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect((await r.route(cross, new URL(cross.url)))!.status).toBe(403);
    const unpinned = await r.route(post({ thread_id: web.thread_id, key: f.shotA.id, pinned: false }), new URL("http://localhost/api/inbox/artifact-pins"));
    expect(((await unpinned!.json()) as { pins: unknown[] }).pins).toEqual([]);
    // Another path is not this module's.
    expect(await r.route(new Request("http://localhost/api/inbox/pins"), new URL("http://localhost/api/inbox/pins"))).toBeNull();
  });
});

/**
 * The capture of pictures sent as bytes (inline-images.ts `files`, a cloud agent's send): a src that names one is read
 * from the Inbox's own copy, before a file of that name in the project; every other src is read from the person's
 * disk, as for any agent. The failures this guard: a sent picture shown from the project's file of the same name, and
 * a src the send did not attach dropped instead of read as a local agent's is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxBlobPath } from "./attachments";
import { captureInboxInlineImages } from "./inline-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pictures sent as bytes", () => {
  test("come from the attached copy under their file's name, and a src not attached is read from the project's folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-attached-")));
    roots.push(root);
    const inbox = join(root, "data", "inbox");
    const project = join(root, "ledger");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(inbox, "blobs"), { recursive: true });
    writeFileSync(join(project, "secret.png"), PNG);
    // The project has a file at the src too: the bytes sent win.
    mkdirSync(join(project, "out"), { recursive: true });
    writeFileSync(join(project, "out", "shot.png"), PNG);
    const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const copy = join(root, "kept-copy");
    writeFileSync(copy, GIF);
    const captured = await captureInboxInlineImages(inbox, {
      body: "Look ![a](out/shot.png) and ![b](secret.png)",
      root: project,
      anywhere: true,
      sentAt: "2026-11-21T00:00:00.000Z",
      files: new Map([["out/shot.png", { path: copy, name: "shot.png" }]]),
    });
    expect(captured.images.map((image) => [image.ref, image.name, image.path])).toEqual([["out/shot.png", "shot.png", copy], ["secret.png", "secret.png", join(project, "secret.png")]]);
    expect(readFileSync(inboxBlobPath(inbox, captured.images[0]!.sent_sha256))).toEqual(GIF);
    expect(captured.failures).toEqual([]);
  });

  test("an attached file that is not a picture is a failure, not a picture", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-attached-")));
    roots.push(root);
    const inbox = join(root, "data", "inbox");
    const notes = join(root, "notes.md");
    writeFileSync(notes, "# not a picture\n");
    const captured = await captureInboxInlineImages(inbox, { body: "![n](notes.md)", root, anywhere: true, sentAt: "2026-11-21T00:00:00.000Z", files: new Map([["notes.md", { path: notes, name: "notes.md" }]]) });
    expect([captured.images.length, captured.failures.map((failure) => failure.ref)]).toEqual([0, ["notes.md"]]);
  });
});

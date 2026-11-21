/**
 * The capture of a cloud agent's pictures (inline-images.ts `files`): each picture is read from the Inbox's own copy
 * of a file attached in the same send. The failure this guards: a src the send did not attach read from the project's
 * folder on the person's computer instead (a cloud agent naming `secret.png` would show the person's own file).
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

describe("a cloud agent's pictures", () => {
  test("come from the attached copy under their file's name, and a src not attached is never read from the project's folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-attached-")));
    roots.push(root);
    const inbox = join(root, "data", "inbox");
    const project = join(root, "ledger");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(inbox, "blobs"), { recursive: true });
    writeFileSync(join(project, "secret.png"), PNG);
    writeFileSync(join(project, "shot.png"), PNG);
    const copy = join(root, "kept-copy");
    writeFileSync(copy, PNG);
    const captured = await captureInboxInlineImages(inbox, {
      body: "Look ![a](out/shot.png) and ![b](secret.png)",
      root: project,
      anywhere: true,
      sentAt: "2026-11-21T00:00:00.000Z",
      files: new Map([["out/shot.png", { path: copy, name: "shot.png" }]]),
    });
    expect(captured.images.map((image) => [image.ref, image.name, image.path])).toEqual([["out/shot.png", "shot.png", copy]]);
    expect(readFileSync(inboxBlobPath(inbox, captured.images[0]!.sent_sha256))).toEqual(PNG);
    expect(captured.failures).toEqual([{ ref: "secret.png", code: "image_not_attached" }]);
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

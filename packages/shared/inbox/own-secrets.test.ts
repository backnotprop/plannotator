/**
 * The Inbox's own keys (own-secrets.ts), for every agent, here or paired: a device's secret, the relay's, the cloud
 * agents' file and the rest are never attached by path, shown as a picture or read into a walkthrough, as named or
 * through a link. The failure this guards: a path attachment plus fetch_file handing a paired agent another device's
 * secret, so it could act as that device. On a temp data folder; nothing real is read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordInboxAttachments } from "./attachments";
import { locateInboxMessageImage } from "./message-images";
import { INBOX_OWN_SECRET_PATHS, inboxOwnSecretRefusal } from "./own-secrets";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

/** A data folder holding each of the Inbox's key files (a folder's as one file in it), and a project beside it. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-own-secrets-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  restore.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const keys = INBOX_OWN_SECRET_PATHS.map((entry) => (entry.includes(".") || entry.endsWith("-key") ? join(dataDir, entry) : join(dataDir, entry, "one")));
  for (const key of keys) {
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, "secret");
  }
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dataDir, "inbox", "notes.md"), "not a key");
  return { root, dataDir, keys, project, inbox: join(dataDir, "inbox") };
}

describe("the Inbox's own keys", () => {
  test("are never attached by path, as named or through a link, by any agent; the data folder's other files are", async () => {
    const w = world();
    for (const key of w.keys) {
      await expect(recordInboxAttachments(w.inbox, [key], { base: w.project, at: "2026-11-21T00:00:00.000Z" })).rejects.toThrow("the Inbox's own keys are never attached or read");
    }
    symlinkSync(w.keys[0]!, join(w.project, "notes.txt"));
    await expect(recordInboxAttachments(w.inbox, ["notes.txt"], { base: w.project, at: "2026-11-21T00:00:00.000Z" })).rejects.toThrow("the Inbox's own keys are never attached or read");
    const [kept] = await recordInboxAttachments(w.inbox, [join(w.inbox, "notes.md")], { base: w.project, at: "2026-11-21T00:00:00.000Z" });
    expect(kept!.name).toBe("notes.md");
  });

  test("are never shown as a picture, even through a link named as one", () => {
    const w = world();
    symlinkSync(join(w.dataDir, "inbox", "relay.json"), join(w.project, "shot.png"));
    const refused = locateInboxMessageImage({ body: "![s](shot.png)", root: w.project, path: "shot.png", anywhere: true });
    expect(refused).toMatchObject({ ok: false, code: "image_hidden" });
  });

  test("the rule: inside a key folder or a key file, another case or an NTFS stream name included where the disk reads them so; never a neighbour", () => {
    const data = "/d/plannotator";
    expect(inboxOwnSecretRefusal("/d/plannotator/inbox/device-secrets/dev_1", [data], "linux")).not.toBeNull();
    expect(inboxOwnSecretRefusal("/d/plannotator/inbox/relay.json", [data], "linux")).not.toBeNull();
    expect(inboxOwnSecretRefusal("/d/plannotator/Inbox/Relay.JSON", [data], "darwin")).not.toBeNull();
    expect(inboxOwnSecretRefusal("/d/plannotator/inbox/relay.json::$DATA", [data], "win32")).not.toBeNull();
    for (const path of ["/d/plannotator/inbox/cloud-agents/cloud.1/notes.md", "/d/plannotator/inbox/blobs/abc", "/d/plannotator/plans/a.md", "/d/other/inbox/relay.json", "relay.json", "/d/plannotator/inbox/antigravity/notes.md"]) {
      expect([path, inboxOwnSecretRefusal(path, [data], "linux")]).toEqual([path, null]);
    }
    // A child whose name starts with two dots is inside its folder, not a step out of it.
    expect(inboxOwnSecretRefusal("/d/plannotator/inbox/device-secrets/..dev_1", [data], "linux")).not.toBeNull();
    // A running Antigravity conversation's hand-over: its language server's address and token.
    expect(inboxOwnSecretRefusal("/d/plannotator/inbox/antigravity/links/conv.json", [data], "linux")).not.toBeNull();
  });

  test("a key reached where it really is, when a folder of the data folder is a link elsewhere, is refused too", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-own-secrets-linked-")));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const elsewhere = join(root, "elsewhere", "inbox");
    mkdirSync(join(elsewhere, "device-secrets"), { recursive: true });
    mkdirSync(dataDir);
    writeFileSync(join(elsewhere, "relay.json"), "secret");
    writeFileSync(join(elsewhere, "device-secrets", "dev_1"), "secret");
    writeFileSync(join(elsewhere, "notes.md"), "not a key");
    symlinkSync(elsewhere, join(dataDir, "inbox"));
    for (const key of [join(elsewhere, "relay.json"), join(elsewhere, "device-secrets", "dev_1")]) {
      expect([key, inboxOwnSecretRefusal(key, [dataDir])]).toEqual([key, "the Inbox's own keys are never attached or read (they would let anyone act as this Inbox or one of its devices)."]);
    }
    expect(inboxOwnSecretRefusal(join(elsewhere, "notes.md"), [dataDir])).toBeNull();
    const before = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    restore.push(() => {
      if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = before;
    });
    await expect(recordInboxAttachments(join(root, "store"), [join(elsewhere, "relay.json")], { base: root, at: "2026-11-21T00:00:00.000Z" })).rejects.toThrow("the Inbox's own keys are never attached or read");
  });
});

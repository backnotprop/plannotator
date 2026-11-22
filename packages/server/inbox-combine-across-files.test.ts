/**
 * A Combine's copies of the other computer's files (approval "inbox-combine-across-computers"; inbox-combine-across.ts),
 * on two real stores in process (inbox-combine.scenarios.ts). No Inbox is started.
 *
 * What regresses: copies that fill the disk (a stopped Combine still copying, a stopped or long-failed one's copies kept
 * from the upload sweep for good, no cap on their total); files silently missing after a restart (the copy not picked up
 * again, or the attach never run once the thread had arrived); a file attached twice when the attach is replayed; this
 * computer's picks' files left behind in their archived threads, or going dead once those are deleted; a file left out
 * without a word on the new thread, also one never tried while the other computer was away, and one whose bytes are
 * not the ones named.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxCombineRecord } from "@plannotator/core/inbox-types";
import { openInboxAttachmentVersion, readInboxAttachmentSent, recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { inboxUploadAttachments, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { agent, cleanUp, engine, roots, route, tick, world, type Computer } from "./inbox-combine.scenarios";

afterEach(cleanUp);

const until = async (what: () => boolean) => {
  for (let i = 0; i < 200 && !what(); i++) await tick();
  expect(what()).toBe(true);
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
type Kept = { name: string; upload?: string; missed?: string; attached?: true };
const keptFiles = (c: Computer): Kept[] => JSON.parse(readFileSync(join(c.store.dir, "combines.json"), "utf8")).combines[0].files ?? [];
const start = async (c: Computer, threads: string[], key: string) => (await route(c, "POST", "/api/inbox/combine", { thread_ids: threads, session: "ses_studio", idempotency_key: key })).body.combine as InboxCombineRecord;

/** A thread on Mini (or `c`) whose first message has `n` files of 30 bytes each. */
async function withFiles(mini: Computer, n: number, stem = "part", session = "ses_mini") {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-combine-copies-")));
  roots.push(folder);
  const names = Array.from({ length: n }, (_, i) => `${stem}-${i}.md`);
  for (const name of names) writeFileSync(join(folder, name), `${name.padEnd(29, ".")}\n`);
  const attachments = await recordInboxAttachments(mini.store.dir, names, { base: folder, at: new Date().toISOString() });
  return mini.store.sendMessage({ project_id: mini.project, author: agent(session), subject: "Notes", body: "See the parts.", attachments }).message;
}

test("every pick's files go on the new thread: this computer's as they are, the other computer's copied in", async () => {
  const { studio, mini } = world();
  const here = await withFiles(studio, 2, "local", "ses_studio");
  const there = await withFiles(mini, 1);
  const record = await start(studio, [here.id, there.id], "k-all-files");
  await until(() => keptFiles(studio).every((f) => f.upload || (f as { local?: true }).local));
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 3);
  const on = studio.store.message(made.id)!.attachments!;
  expect(on.map((a) => a.name)).toEqual(["local-0.md", "local-1.md", "part-0.md"]);
  // This computer's: the same bytes as in the old thread, which keeps its own.
  expect(on.slice(0, 2).map((a) => a.sent_sha256)).toEqual(here.attachments!.map((a) => a.sent_sha256));
  expect(on.slice(0, 2).map((a) => a.id)).not.toEqual(here.attachments!.map((a) => a.id));
  expect(studio.store.message(here.id)!.attachments).toHaveLength(2);
  expect(studio.store.message(made.id)!.combine_left).toBeUndefined();
});

test("a file that could not be copied is named on the new thread", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 3);
  studio.combine.close();
  studio.combine = engine(studio, { filesMaxBytes: 70 });
  const record = await start(studio, [s1.id, m.id], "k-left-out");
  await until(() => keptFiles(studio).every((f) => f.upload || f.missed));
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 2);
  await until(() => studio.store.message(made.id)!.combine_left !== undefined);
  expect(studio.store.message(made.id)!.combine_left).toEqual({ files: ["part-2.md"] });
});

test("a stopped Combine copies nothing more, and its copies are left to the upload sweep", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 4);
  const fetched: string[] = [];
  let open = () => {};
  const held = new Promise<void>((resolve) => (open = resolve));
  studio.combine.close();
  studio.combine = engine(studio, {
    fetchFile: async (args, real) => {
      fetched.push(args.file);
      if (fetched.length === 2) await held;
      return real();
    },
  });
  const record = await start(studio, [s1.id, m.id], "k-stop");
  await until(() => fetched.length === 2);
  expect(studio.combine.uploads()).toHaveLength(1);
  await route(studio, "POST", `/api/inbox/combine/${record.id}/cancel`, {});
  open();
  await settle();
  expect(fetched).toHaveLength(2);
  expect(studio.combine.uploads()).toEqual([]);
});

test("a failed Combine's copies are kept for its day, in case its thread still comes, then left to the sweep", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 2);
  await start(studio, [s1.id, m.id], "k-failed");
  await until(() => keptFiles(studio).every((f) => f.upload));
  studio.live.delete("ses_studio");
  studio.clock.now += 3 * 60_000;
  studio.combine.check();
  expect(((await route(studio, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[])[0]!.state).toBe("failed");
  expect(studio.combine.uploads()).toHaveLength(2);
  studio.clock.now += 25 * 60 * 60_000;
  expect(studio.combine.uploads()).toEqual([]);
});

test("past the total for one Combine, the rest of the files are left out as uncopyable", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 4);
  studio.combine.close();
  studio.combine = engine(studio, { filesMaxBytes: 70 });
  await start(studio, [s1.id, m.id], "k-cap");
  await until(() => keptFiles(studio).every((f) => f.upload || f.missed));
  expect(keptFiles(studio).map((f) => f.upload ? "copied" : f.missed)).toEqual(["copied", "copied", "files_too_large", "files_too_large"]);
});

test("an Inbox restarted mid-copy copies the rest, and they are attached when the thread comes", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 3);
  let fetches = 0;
  studio.combine.close();
  // The second file never comes: this Inbox stops while it is on its way.
  studio.combine = engine(studio, { fetchFile: (_args, real) => (++fetches === 2 ? new Promise<Response>(() => {}) : real()) });
  const record = await start(studio, [s1.id, m.id], "k-restart");
  await until(() => fetches === 2);
  expect(keptFiles(studio).filter((f) => f.upload)).toHaveLength(1);
  studio.combine.close();
  studio.combine = engine(studio);
  studio.combine.check();
  await until(() => keptFiles(studio).every((f) => f.upload));
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 3);
});

test("an Inbox restarted after the thread came but before its copies were attached attaches them, once, however often it is replayed", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 2);
  const record = await start(studio, [s1.id, m.id], "k-attach");
  await until(() => keptFiles(studio).every((f) => f.upload));
  // This Inbox stops; the thread is written as it stops, so the attach never ran.
  studio.combine.close();
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  const path = join(studio.store.dir, "combines.json");
  const edit = (change: (r: Record<string, any>) => void) => {
    const value = JSON.parse(readFileSync(path, "utf8"));
    change(value.combines[0]);
    writeFileSync(path, JSON.stringify(value));
  };
  edit((r) => Object.assign(r, { state: "done", thread: { id: made.id, subject: "Combined" }, settled_at: new Date(studio.clock.now).toISOString() }));
  studio.combine = engine(studio);
  studio.combine.check();
  await until(() => keptFiles(studio).every((f) => f.attached));
  expect(studio.store.message(made.id)!.attachments!.map((a) => a.name)).toEqual(["part-0.md", "part-1.md"]);
  // Stopped again after attaching, before that was written down: replayed, nothing is attached twice.
  studio.combine.close();
  edit((r) => {
    for (const f of r.files) delete f.attached;
  });
  studio.combine = engine(studio);
  studio.combine.check();
  await until(() => keptFiles(studio).every((f) => f.attached));
  studio.combine.check();
  await settle();
  expect(studio.store.message(made.id)!.attachments!.map((a) => a.name)).toEqual(["part-0.md", "part-1.md"]);
});

/** A tiny PNG, as a picture a message shows. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("this computer's files and pictures on the new thread are its own copies: they still open once the old thread is deleted", async () => {
  const { studio, m1 } = world();
  const here = await withFiles(studio, 1, "local", "ses_studio");
  // A picture the agent's reply shows, captured as a file of that message.
  const upload = await receiveInboxUpload(studio.store.dir, "shot.png", new Blob([PNG]).stream(), { at: new Date().toISOString() });
  const [captured] = await inboxUploadAttachments(studio.store.dir, [upload.upload_id], new Date().toISOString());
  removeInboxUploads(studio.store.dir, [upload.upload_id]);
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), reply_to: here.id, body: "![shot](shot.png)", inline_images: [{ ...captured!, ref: "shot.png" }] } as never);
  const record = await start(studio, [here.id, m1.id], "k-own-copies");
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 2);
  await until(() => studio.store.message(here.id)!.resolved_at !== null);
  studio.store.deleteThread(here.id);
  const on = studio.store.message(made.id)!.attachments!;
  expect(on.map((a) => a.name)).toEqual(["local-0.md", "shot.png"]);
  for (const file of on) {
    expect(existsSync(file.path)).toBe(true);
    expect(readInboxAttachmentSent(studio.store.dir, file)).not.toBeNull();
    const current = await openInboxAttachmentVersion(studio.store.dir, file, "current");
    expect(current.ok).toBe(true);
    if (current.ok) await current.handle.close();
  }
  expect(readFileSync(on[0]!.path, "utf8")).toBe(`${"local-0.md".padEnd(29, ".")}\n`);
});

test("a copy whose bytes are not the ones the other computer named is left out and named, never attached", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 1);
  studio.combine.close();
  studio.combine = engine(studio, {
    fetchFile: async (_args, real) => {
      const answer = await real();
      await answer.arrayBuffer();
      return new Response("other bytes on the way\n", { headers: answer.headers });
    },
  });
  const record = await start(studio, [s1.id, m.id], "k-sha");
  await until(() => keptFiles(studio).every((f) => f.upload || f.missed));
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => studio.store.message(made.id)!.combine_left !== undefined);
  expect(studio.store.message(made.id)!.combine_left).toEqual({ files: ["part-0.md"] });
  expect(studio.store.message(made.id)!.attachments ?? []).toEqual([]);
});

test("files the other computer was away for until their time ran out are named as not copied", async () => {
  const { studio, mini, s1 } = world();
  const m = await withFiles(mini, 3);
  studio.combine.close();
  // Mini goes away just after the first file came.
  studio.combine = engine(studio, {
    fetchFile: async (_args, real) => {
      const answer = await real();
      mini.awake = false;
      return answer;
    },
  });
  const record = await start(studio, [s1.id, m.id], "k-never");
  await until(() => keptFiles(studio).some((f) => f.upload));
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "Where it stands.", idempotency_key: record.id }).message;
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 1);
  await settle();
  expect(studio.store.message(made.id)!.combine_left?.files).toBeUndefined();
  studio.clock.now += 25 * 60 * 60_000;
  studio.combine.check();
  await settle();
  expect(studio.store.message(made.id)!.combine_left?.files).toEqual(["part-1.md", "part-2.md"]);
});

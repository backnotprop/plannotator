/**
 * A Combine's copies of the other computer's files (approval "inbox-combine-across-computers"; inbox-combine-across.ts),
 * on two real stores in process (inbox-combine.scenarios.ts). No Inbox is started.
 *
 * What regresses: copies that fill the disk (a stopped Combine still copying, a stopped or long-failed one's copies kept
 * from the upload sweep for good, no cap on their total); files silently missing after a restart (the copy not picked up
 * again, or the attach never run once the thread had arrived); a file attached twice when the attach is replayed.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxCombineRecord } from "@plannotator/core/inbox-types";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
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

/** A thread on Mini whose first message has `n` files of 30 bytes each. */
async function withFiles(mini: Computer, n: number) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-combine-copies-")));
  roots.push(folder);
  const names = Array.from({ length: n }, (_, i) => `part-${i}.md`);
  for (const name of names) writeFileSync(join(folder, name), `${name.padEnd(29, ".")}\n`);
  const attachments = await recordInboxAttachments(mini.store.dir, names, { base: folder, at: new Date().toISOString() });
  return mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Notes", body: "See the parts.", attachments }).message;
}

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

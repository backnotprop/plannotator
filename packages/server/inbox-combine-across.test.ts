/**
 * Combine across linked computers, the safety around the other computer (approval "inbox-combine-across-computers";
 * inbox-combine-across.ts, inbox-combine-guard.ts), on two real stores in process (inbox-combine.scenarios.ts). No
 * Inbox is started.
 *
 * What regresses: the other computer's files not copied in (so they do not open while it is off), or a refused, too
 * large or surplus one failing the Combine; a held archive landing on a thread that moved on, or on one with an open
 * question the Combine never read; a held archive waiting past its day; both computers combining one thread at once;
 * Undo that sends an archive and its undo when the archive never left, or says nothing waits while its undo does; this
 * Inbox's own writes showing as the person's notices; a pressed Undo dropped because its archive was still on its way
 * (or sent behind one that was skipped there); an archive that left once landing after its day; a quiet line still
 * naming a thread archived there by hand; a late archive landing over the person's own Unarchive there; a hold whose
 * Combine was never written keeping the thread busy there for a day.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxCombineRecord } from "@plannotator/core/inbox-types";
import { recordInboxAttachments, readInboxAttachmentSent } from "@plannotator/shared/inbox/attachments";
import { FILES_MAX } from "./inbox-combine-across";
import { combineArchiveSkip } from "./inbox-combine-guard";
import { agent, archived, ask, cleanUp, drain, engine, roots, route, tick, world, type Computer } from "./inbox-combine.scenarios";

afterEach(cleanUp);

const until = async (what: () => boolean) => {
  for (let i = 0; i < 200 && !what(); i++) await tick();
  expect(what()).toBe(true);
};
const start = async (c: Computer, threads: string[], session: string, key: string) => (await route(c, "POST", "/api/inbox/combine", { thread_ids: threads, session, idempotency_key: key })).body;
const combined = async (c: Computer, id: string) => ((await route(c, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[]).find((r) => r.id === id)!;
const arrive = async (c: Computer, session: string, key: string) => {
  const made = c.store.sendMessage({ project_id: c.project, author: agent(session), subject: "Combined", body: "Where it stands.", idempotency_key: key }).message;
  await tick();
  return made;
};

test("the other computer's files are copied in and attached to the new thread, so they open while it is off; one too large, refused or past the cap is left out and the Combine goes on", async () => {
  const { studio, mini, s1 } = world();
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-combine-files-")));
  roots.push(folder);
  writeFileSync(join(folder, "notes.md"), "# Backoff\n\nCap at 50 minutes.\n");
  const files = await recordInboxAttachments(mini.store.dir, ["notes.md"], { base: folder, at: new Date().toISOString() });
  const m1 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Backoff notes", body: "See the notes.", attachments: files }).message;
  // The far read as that computer's door gives it, with more records than it holds: one past 100 MB, one it refuses
  // (`.env`, no such file there), and enough to pass the cap.
  const fake = (i: number, name: string, size = 10) => ({ id: `att_FAKE${String(i).padStart(22, "0")}`, name, size, kind: "file" });
  studio.combine.close();
  studio.combine = engine(studio, {
    editRead: (answer) => {
      const [first, ...rest] = answer.full.messages;
      const extra = [fake(0, "huge.bin", 200 * 1024 * 1024), fake(1, ".env"), ...Array.from({ length: FILES_MAX }, (_, i) => fake(i + 2, `more-${i}.txt`))];
      return { ...answer, full: { ...answer.full, messages: [{ ...first, attachments: [...first.attachments, ...extra] }, ...rest] } };
    },
  });
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-files")).combine as InboxCombineRecord;
  expect(record.state).toBe("asked");
  // Copied while the Combine waits; then Mini goes to sleep before the thread arrives.
  await until(() => JSON.parse(readFileSync(join(studio.store.dir, "combines.json"), "utf8")).combines[0].files.every((f: { upload?: string; missed?: string }) => f.upload || f.missed));
  const kept = JSON.parse(readFileSync(join(studio.store.dir, "combines.json"), "utf8")).combines[0].files as { name: string; upload?: string; missed?: string }[];
  expect(kept.filter((f) => f.upload).map((f) => f.name)).toEqual(["notes.md"]);
  expect(kept.find((f) => f.name === "huge.bin")!.missed).toBe("file_too_large");
  expect(kept.find((f) => f.name === ".env")!.missed).toBeTruthy();
  expect(kept.filter((f) => f.missed === "too_many")).toHaveLength(kept.length - FILES_MAX);
  expect(kept.length - FILES_MAX).toBe(3);
  mini.awake = false;

  const made = await arrive(studio, "ses_studio", record.id);
  await until(() => (studio.store.message(made.id)!.attachments ?? []).length === 1);
  expect((await combined(studio, record.id)).state).toBe("done");
  const [copy] = studio.store.message(made.id)!.attachments!;
  expect(copy!.name).toBe("notes.md");
  // Its own copy here: never the path on the other computer.
  expect(copy!.path.startsWith(studio.store.dir)).toBe(true);
  expect(readInboxAttachmentSent(studio.store.dir, copy!)!.toString("utf8")).toBe("# Backoff\n\nCap at 50 minutes.\n");
  expect(studio.store.attachment(copy!.id)?.message.id).toBe(made.id);
});

test("a held archive that lands after the thread moved on is skipped there, recorded so, and Undo then sends nothing", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-stale")).combine as InboxCombineRecord;
  mini.awake = false;
  await arrive(studio, "ses_studio", record.id);
  expect(archived(studio, s1.id)).toBe(true);
  expect((await combined(studio, record.id)).waiting_on).toEqual([mini.id]);
  // On Mini meanwhile: the agent asks something new.
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: ask("Also cap retries at 5?") });
  mini.awake = true;
  await drain(studio, mini);
  expect(mini.applied).toEqual([`skip ${m1.id}`]);
  expect(archived(mini, m1.id)).toBe(false);
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)).toMatchObject({ state: "delivered", answer: { skipped: "thread_moved_on" } });
  expect((await combined(studio, record.id)).waiting_on).toBeUndefined();
  await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {});
  await drain(studio, mini);
  expect(mini.applied).toEqual([`skip ${m1.id}`]);
});

test("the archive's guard: an open question the Combine's read never saw keeps the thread; one it saw does not; the person's own archive is never held to it", () => {
  const { mini, m1 } = world();
  const [q] = mini.store.questionsOf(m1.id);
  const ref = `${m1.id}/${q!.key}`;
  expect(combineArchiveSkip(mini.store, m1.id, { resolved: true, seen_through_message: m1.id, seen_questions: [] })).toBe("open_question");
  expect(combineArchiveSkip(mini.store, m1.id, { resolved: true, seen_through_message: m1.id, seen_questions: [ref] })).toBeNull();
  expect(combineArchiveSkip(mini.store, m1.id, { resolved: true })).toBeNull();
  // A note of the Inbox's after the read is a message too: the thread moved on.
  mini.store.sendMessage({ project_id: mini.project, author: { kind: "person" }, reply_to: m1.id, body: "Not yet." } as never);
  expect(combineArchiveSkip(mini.store, m1.id, { resolved: true, seen_through_message: m1.id, seen_questions: [ref] })).toBe("thread_moved_on");
});

test("an archive still held a day after the thread arrived is taken back quietly, and never lands", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-bound")).combine as InboxCombineRecord;
  mini.awake = false;
  await arrive(studio, "ses_studio", record.id);
  studio.clock.now += 25 * 60 * 60_000;
  studio.combine.check();
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)!.state).toBe("cancelled");
  mini.awake = true;
  await drain(studio, mini);
  expect([mini.applied, archived(mini, m1.id)]).toEqual([[], false]);
  // Quiet: nothing for the person to dismiss, nothing listed as waiting.
  expect(studio.outbox.notices()).toEqual([]);
});

test("one thread in a waiting Combine on either computer is busy on both: the other is refused in that computer's words, and free again once it stops", async () => {
  const { studio, mini, s1, m1 } = world();
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Queue depth", body: "x" }).message;
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-busy")).combine as InboxCombineRecord;
  // Mini's own Combine of its thread, while Studio's waits.
  expect(await start(mini, [m1.id, m2.id], "ses_mini", "k-mini")).toMatchObject({ code: "already_combining", error: "Retry worker backoff is already being combined." });
  await route(studio, "POST", `/api/inbox/combine/${record.id}/cancel`, {});
  await tick();
  const minis = (await start(mini, [m1.id, m2.id], "ses_mini", "k-mini-2")).combine as InboxCombineRecord;
  expect(minis.state).toBe("asked");
  // Now Mini's waits: Studio's Combine with that thread is refused there, before anything is written here.
  const s2 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Ledger", body: "x" }).message;
  const notesBefore = studio.store.threadMessageIds(s2.id).length;
  expect(await start(studio, [s2.id, m1.id], "ses_studio", "k-busy-2")).toMatchObject({ code: "already_combining", error: "Retry worker backoff is already being combined." });
  expect(studio.store.threadMessageIds(s2.id)).toHaveLength(notesBefore);
  expect(((await route(studio, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[]).filter((r) => r.state === "asked")).toEqual([]);
});

test("Undo while the other computer sleeps: an archive that never left is taken back, not sent; an undo that waits is said to wait until it lands", async () => {
  const { studio, mini, s1, m1 } = world();
  // The archive never left: Undo takes it back, and nothing ever lands on Mini.
  const first = (await start(studio, [s1.id, m1.id], "ses_studio", "k-undo-1")).combine as InboxCombineRecord;
  mini.awake = false;
  await arrive(studio, "ses_studio", first.id);
  const undone = (await route(studio, "POST", `/api/inbox/combine/${first.id}/undo`, {})).body.combine as InboxCombineRecord;
  expect(undone.state).toBe("undone");
  expect(undone.waiting_on).toBeUndefined();
  expect(studio.outbox.get(`${first.id}-archive-${m1.id}`)!.state).toBe("cancelled");
  expect(studio.outbox.get(`${first.id}-undo-${m1.id}`)).toBeNull();
  mini.awake = true;
  await drain(studio, mini);
  expect(mini.applied).toEqual([]);

  // The archive landed, then Mini slept: the undo waits, and the record says so until it lands.
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Second", body: "x" }).message;
  const s2 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Second here", body: "x" }).message;
  const second = (await start(studio, [s2.id, m2.id], "ses_studio", "k-undo-2")).combine as InboxCombineRecord;
  await arrive(studio, "ses_studio", second.id);
  expect(archived(mini, m2.id)).toBe(true);
  mini.awake = false;
  const waiting = (await route(studio, "POST", `/api/inbox/combine/${second.id}/undo`, {})).body.combine as InboxCombineRecord;
  expect([waiting.state, waiting.waiting_on]).toEqual(["undone", [mini.id]]);
  expect(archived(mini, m2.id)).toBe(true);
  mini.awake = true;
  await drain(studio, mini);
  expect(archived(mini, m2.id)).toBe(false);
  expect((await combined(studio, second.id)).waiting_on).toBeUndefined();
});

test("this Inbox's own writes are never the person's: not listed as notices, even refused", async () => {
  const { studio, mini } = world();
  studio.outbox.submit(mini.id, "messages/msg_01M80000000000000000000000/resolve", { idempotency_key: "own-1", resolved: true }, null, false, null, true);
  studio.outbox.submit(mini.id, "messages/msg_01M80000000000000000000001/resolve", { idempotency_key: "person-1", resolved: true });
  await studio.outbox.drain(mini.id, async () => ({ status: 404, body: { code: "message_not_found" } }));
  expect(studio.outbox.notices().map((e) => e.key)).toEqual(["person-1"]);
});

test("Undo of an archive that landed brings the thread back there, even with a note written in it since", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-undo-note")).combine as InboxCombineRecord;
  await arrive(studio, "ses_studio", record.id);
  expect(archived(mini, m1.id)).toBe(true);
  mini.store.sendMessage({ project_id: mini.project, author: { kind: "person" }, reply_to: m1.id, body: "Noted." } as never);
  expect(archived(mini, m1.id)).toBe(true);
  await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {});
  await drain(studio, mini);
  expect(mini.applied).toEqual([`archive ${m1.id}`, `undo ${m1.id}`]);
  expect(archived(mini, m1.id)).toBe(false);
  expect((await combined(studio, record.id)).waiting_on).toBeUndefined();
});

test("a thread deleted on the other computer between the read and the hold: the words for a thread not there, not that the computer is away", async () => {
  const { studio, mini, s1, m1 } = world();
  studio.combine.close();
  studio.combine = engine(studio, {
    editRead: (answer) => {
      mini.store.deleteThread(m1.id);
      return answer;
    },
  });
  const refused = await start(studio, [s1.id, m1.id], "ses_studio", "k-deleted");
  expect(refused).toMatchObject({ code: "thread_not_found", error: `No thread ${m1.id} on this machine.` });
  expect(refused.machine).toBeUndefined();
});

test("a write of this Inbox's own that keeps failing never holds the person's writes behind it", async () => {
  const { studio, mini } = world();
  const resolve = (n: number) => `messages/msg_01M8000000000000000000000${n}/resolve`;
  studio.outbox.submit(mini.id, resolve(0), { idempotency_key: "own-1", resolved: true }, null, false, null, true);
  studio.outbox.submit(mini.id, resolve(1), { idempotency_key: "own-2", resolved: true }, null, false, null, true);
  studio.outbox.submit(mini.id, resolve(2), { idempotency_key: "person-1", resolved: true });
  const sent: string[] = [];
  const result = await studio.outbox.drain(mini.id, async (entry) => {
    sent.push(entry.key);
    return entry.key === "own-1" ? { status: 500, body: {} } : { status: 200, body: {} };
  });
  // The person's write went; this Inbox's own wait for the next try, in their order.
  expect(sent).toEqual(["own-1", "person-1"]);
  expect(result).toBe("server_error");
  expect(studio.outbox.get("person-1")!.state).toBe("delivered");
  expect([studio.outbox.get("own-1")!.state, studio.outbox.get("own-2")!.state]).toEqual(["sending", "queued"]);
  await studio.outbox.drain(mini.id, async (entry) => (sent.push(entry.key), { status: 200, body: {} }));
  expect(sent).toEqual(["own-1", "person-1", "own-1", "own-2"]);
});

test("an Undo pressed while the archive was on its way to a computer that then dropped goes right behind it, even 30 hours later", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-undo-late")).combine as InboxCombineRecord;
  // The archive reached Mini and was applied, but its answer never came back: here it is still on its way.
  mini.dropAnswers = true;
  await arrive(studio, "ses_studio", record.id);
  expect(archived(mini, m1.id)).toBe(true);
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)!.state).toBe("sending");
  mini.awake = false;
  mini.dropAnswers = false;
  const undone = (await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {})).body.combine as InboxCombineRecord;
  expect([undone.state, undone.waiting_on]).toEqual(["undone", [mini.id]]);
  // Mini comes back 30 hours later: the archive is past its day, the Undo is not.
  studio.clock.now += 30 * 60 * 60_000;
  studio.combine.check();
  mini.awake = true;
  await drain(studio, mini);
  expect(archived(mini, m1.id)).toBe(false);
  expect(mini.applied).toEqual([`archive ${m1.id}`, `undo ${m1.id}`]);
  expect(studio.outbox.get(`${record.id}-undo-${m1.id}`)!.state).toBe("delivered");
});

test("an Undo queued behind an archive that is then skipped there is never sent: the person's own archive there stays", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-undo-skip")).combine as InboxCombineRecord;
  mini.awake = false;
  await arrive(studio, "ses_studio", record.id);
  // A try that never reached Mini: the archive has left, so it cannot be taken back.
  await drain(studio, mini);
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)).toMatchObject({ state: "sending", left: true });
  await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {});
  // On Mini meanwhile: the agent writes in it, and the person archives it.
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: "Done here." });
  mini.store.resolveThread(m1.id, true, "person");
  mini.awake = true;
  await drain(studio, mini);
  expect(mini.applied).toEqual([`skip ${m1.id}`]);
  expect(archived(mini, m1.id)).toBe(true);
  expect(studio.outbox.get(`${record.id}-undo-${m1.id}`)!.state).toBe("cancelled");
  expect((await combined(studio, record.id)).waiting_on).toBeUndefined();
});

test("an archive that left once but did not land within its day is never sent again, and the new thread says it stayed open there", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-left-late")).combine as InboxCombineRecord;
  mini.awake = false;
  const made = await arrive(studio, "ses_studio", record.id);
  await drain(studio, mini);
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)!.left).toBe(true);
  studio.clock.now += 25 * 60 * 60_000;
  studio.combine.check();
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)!.state).toBe("cancelled");
  expect(studio.store.message(made.id)!.combine_left).toEqual({ open: [{ machine: "Mini", subject: "Retry worker backoff" }] });
  mini.awake = true;
  await drain(studio, mini);
  expect([mini.applied, archived(mini, m1.id)]).toEqual([[], false]);
});

test("the quiet line stops naming a thread once it is archived on the other computer by hand", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-stale-line")).combine as InboxCombineRecord;
  mini.awake = false;
  const made = await arrive(studio, "ses_studio", record.id);
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: "One more." });
  mini.awake = true;
  await drain(studio, mini);
  studio.combine.check();
  expect(studio.store.message(made.id)!.combine_left).toEqual({ open: [{ machine: "Mini", subject: "Retry worker backoff" }] });
  mini.store.resolveThread(m1.id, true, "person");
  studio.combine.check();
  expect(studio.store.message(made.id)!.combine_left).toBeUndefined();
});

test("a late archive never lands over the person's own Unarchive there; an Unarchive from before the Combine read it does not hold it back", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-unarchived")).combine as InboxCombineRecord;
  mini.awake = false;
  await arrive(studio, "ses_studio", record.id);
  // On Mini meanwhile, by hand: archived, then brought back.
  mini.store.resolveThread(m1.id, true, "person");
  mini.store.resolveThread(m1.id, false, "person");
  mini.awake = true;
  await drain(studio, mini);
  expect(studio.outbox.get(`${record.id}-archive-${m1.id}`)).toMatchObject({ state: "delivered", answer: { skipped: "unarchived" } });
  expect(archived(mini, m1.id)).toBe(false);

  // Unarchived before the read: the Combine saw it open, and archives it.
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Queue depth", body: "x" }).message;
  mini.store.resolveThread(m2.id, true, "person");
  mini.store.resolveThread(m2.id, false, "person");
  const s2 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Ledger", body: "x" }).message;
  const second = (await start(studio, [s2.id, m2.id], "ses_studio", "k-unarchived-2")).combine as InboxCombineRecord;
  await arrive(studio, "ses_studio", second.id);
  expect(archived(mini, m2.id)).toBe(true);
});

test("a hold whose Combine was never written lets go within minutes; one whose Combine is written holds while it waits", async () => {
  const { studio, mini, s1, m1 } = world();
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Queue depth", body: "x" }).message;
  // Studio stopped right after Mini took the hold, before its Combine was written: only the hold ever came.
  await route(mini, "POST", "/api/inbox/combine/hold", { idempotency_key: "h-1", combine: "cmb_01M80000000000000000000009", threads: [m1.id], hold: true }, studio.id);
  expect(await start(mini, [m1.id, m2.id], "ses_mini", "k-lease-1")).toMatchObject({ code: "already_combining" });
  mini.clock.now += 3 * 60_000;
  const minis = (await start(mini, [m1.id, m2.id], "ses_mini", "k-lease-2")).combine as InboxCombineRecord;
  expect(minis.state).toBe("asked");
  await route(mini, "POST", `/api/inbox/combine/${minis.id}/cancel`, {});

  // A Combine written on Studio: its hold on Mini lasts well past those minutes.
  const record = (await start(studio, [s1.id, m1.id], "ses_studio", "k-lease-3")).combine as InboxCombineRecord;
  expect(record.state).toBe("asked");
  await tick();
  mini.clock.now += 60 * 60_000;
  expect(await start(mini, [m1.id, m2.id], "ses_mini", "k-lease-4")).toMatchObject({ code: "already_combining" });
});

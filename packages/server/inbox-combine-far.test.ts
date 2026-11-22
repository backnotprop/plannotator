/**
 * Combine across linked computers (approval "inbox-combine-across-computers"; inbox-combine.ts,
 * inbox-combine-across.ts, inbox-combine-far.ts), on two real stores in process (inbox-combine.scenarios.ts):
 * the other computer's door is its real `agent-read` answer, and its writes are the outbox drained into that
 * computer's store as its door applies them. No Inbox is started. Both directions.
 *
 * What regresses: the other computer's thread missing from the wake or its open questions; a note written in it; an
 * archive on either computer before the new thread arrives, or when it never does; the other computer's thread left
 * unarchived, or archived twice; Undo that brings back only this computer's threads; a restart that loses the archive
 * there, or replays one past its day; a double press that starts two Combines; the agents offered limited to the ones
 * that wrote in the picks (on one computer or two), or to the computer that holds some of them; a thread left open on
 * the other computer (written in since, or that computer away past the day) not named on the new thread.
 */
import { afterEach, expect, test } from "bun:test";
import type { InboxCombineAgent, InboxCombineRecord } from "@plannotator/core/inbox-types";
import { agent, archived, cleanUp, engine, route, tick, world, type Computer } from "./inbox-combine.scenarios";

afterEach(cleanUp);

for (const writerOn of ["Studio", "Mini"] as const) {
  test(`the writer on ${writerOn}: the other computer's thread is in the wake, archived there only once the new thread arrives, and Undo brings back both`, async () => {
    const w = world();
    const [here, there, mine, theirs, session] = writerOn === "Studio" ? [w.studio, w.mini, w.s1, w.m1, "ses_studio"] : [w.mini, w.studio, w.m1, w.s1, "ses_mini"];
    const record = (await route(here, "POST", "/api/inbox/combine", { thread_ids: [mine.id, theirs.id], session, idempotency_key: "k-1" })).body.combine as InboxCombineRecord;
    expect(record.state).toBe("asked");
    expect(record.threads.map((t) => [t.id, t.subject])).toEqual([
      [mine.id, here.store.threadSubject(mine.id)!],
      [theirs.id, there.store.threadSubject(theirs.id)!],
    ]);
    const wake = here.store.pendingReplies(session).find((m) => m.tidy?.wake)!;
    const [q] = there.store.questionsOf(theirs.id);
    expect(wake.body).toContain(`2. ${there.store.threadSubject(theirs.id)} · ${there.name.toLowerCase()}-svc (thread ${theirs.id}, 1 message)`);
    expect(wake.body).toContain(`     ${theirs.id}/${q!.key}  ${q!.prompt}`);
    // A note in this computer's thread only; the other computer's thread is only read.
    expect(here.store.threadMessageIds(mine.id)).toHaveLength(2);
    expect(there.store.threadMessageIds(theirs.id)).toHaveLength(1);
    expect([archived(here, mine.id), archived(there, theirs.id), there.applied]).toEqual([false, false, []]);

    // The new thread, under the Combine's key, on the writer's computer: both picked threads go.
    const made = here.store.sendMessage({ project_id: here.project, author: agent(session), subject: "Retries, combined", body: "Where it all stands.", idempotency_key: record.id }).message;
    await tick();
    expect([archived(here, mine.id), archived(there, theirs.id), archived(here, made.id)]).toEqual([true, true, false]);
    expect(there.applied).toEqual([`archive ${theirs.id}`]);
    const done = ((await route(here, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[])[0]!;
    expect(done).toMatchObject({ id: record.id, state: "done", thread: { id: made.id } });
    expect(done.waiting_on).toBeUndefined();

    const undone = (await route(here, "POST", `/api/inbox/combine/${record.id}/undo`, {})).body.combine as InboxCombineRecord;
    expect(undone.state).toBe("undone");
    expect(undone.waiting_on).toBeUndefined();
    expect([archived(here, mine.id), archived(there, theirs.id), archived(here, made.id)]).toEqual([false, false, false]);
    expect(there.applied).toEqual([`archive ${theirs.id}`, `undo ${theirs.id}`]);
  });
}

test("any running agent here is offered, the ones that wrote first; one that wrote in no pick writes it, on one computer or two, woken in this computer's own pick", async () => {
  const { studio, s1, m1 } = world();
  studio.live.set("ses_idle", "wakes");
  // The window's read (`all=1`): every running session; without it (an older window), only the ones that wrote.
  const one = (await route(studio, "GET", `/api/inbox/combine?threads=${s1.id}`)).body.agents as InboxCombineAgent[];
  expect(one.map((a) => [a.session, a.threads])).toEqual([["ses_studio", 1]]);
  const all = (await route(studio, "GET", `/api/inbox/combine?threads=${s1.id}&all=1`)).body.agents as InboxCombineAgent[];
  expect(all.map((a) => [a.session, a.threads])).toEqual([
    ["ses_studio", 1],
    ["ses_idle", 0],
  ]);
  // Every pick on this computer: one that wrote in none takes it ("I want you to combine these and then own the next thread").
  const s2 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Ledger", body: "x" }).message;
  const here = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, s2.id], session: "ses_idle", idempotency_key: "k-one" })).body.combine as InboxCombineRecord;
  expect(here).toMatchObject({ state: "asked", session: "ses_idle" });
  expect(studio.store.pendingReplies("ses_idle").some((m) => m.tidy?.id === here.id && m.tidy?.wake === true && m.thread_id === s1.id)).toBe(true);
  await route(studio, "POST", `/api/inbox/combine/${here.id}/cancel`, {});
  // Picks on two: it is taken, and woken in this computer's pick.
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_idle", idempotency_key: "k-idle" })).body.combine as InboxCombineRecord;
  expect(record.session).toBe("ses_idle");
  expect(studio.store.pendingReplies("ses_idle").some((m) => m.tidy?.id === record.id && m.tidy?.wake === true && m.thread_id === s1.id)).toBe(true);
  expect(studio.store.pendingReplies("ses_studio").some((m) => m.tidy?.id === record.id)).toBe(false);
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_idle"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  expect(((await route(studio, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[]).find((c) => c.id === record.id)!.state).toBe("done");
});

test("every pick on the other computer: this computer's running agents are offered and one writes it here, woken in its own thread; the picks are archived there", async () => {
  const { studio, mini, s1, m1 } = world();
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Refund totals", body: "x" }).message;
  // A running session with no thread here has nowhere to be woken: not offered for picks all on the other computer.
  studio.live.set("ses_new", "wakes");
  const offered = (await route(studio, "GET", `/api/inbox/combine?threads=${m1.id},${m2.id}&all=1`)).body.agents as InboxCombineAgent[];
  expect(offered.map((a) => [a.session, a.threads])).toEqual([["ses_studio", 0]]);
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [m1.id, m2.id], session: "ses_studio", idempotency_key: "k-there" })).body.combine as InboxCombineRecord;
  expect(record.state).toBe("asked");
  const wake = studio.store.pendingReplies("ses_studio").find((m) => m.tidy?.id === record.id && m.tidy.wake)!;
  expect(wake.thread_id).toBe(s1.id);
  expect(wake.body).toContain(`(thread ${m2.id}, 1 message)`);
  expect([mini.store.threadMessageIds(m1.id).length, mini.store.threadMessageIds(m2.id).length]).toEqual([1, 1]);
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Refunds, combined", body: "x", idempotency_key: record.id }).message;
  await tick();
  expect([archived(mini, m1.id), archived(mini, m2.id), archived(studio, s1.id), archived(studio, made.id)]).toEqual([true, true, false, false]);
});

test("the other computer's thread written in since the read: its archive is skipped there, and the new thread names it as still open there", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-moved" })).body.combine as InboxCombineRecord;
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: "One more thing." });
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id }).message;
  await tick();
  expect([archived(studio, s1.id), archived(mini, m1.id), mini.applied]).toEqual([true, false, [`skip ${m1.id}`]]);
  expect(studio.store.message(made.id)!.combine_left).toEqual({ open: [{ machine: "Mini", subject: "Retry worker backoff" }] });
});

test("the other computer away for a day after the thread came: its archive is dropped, and the new thread names that thread as still open there", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-away" })).body.combine as InboxCombineRecord;
  mini.awake = false;
  const made = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id }).message;
  await tick();
  expect(studio.store.message(made.id)!.combine_left).toBeUndefined();
  studio.clock.now += 25 * 60 * 60_000;
  studio.combine.check();
  await tick();
  expect(studio.store.message(made.id)!.combine_left).toEqual({ open: [{ machine: "Mini", subject: "Retry worker backoff" }] });
  mini.awake = true;
  studio.combine.check();
  await tick();
  expect([archived(mini, m1.id), mini.applied]).toEqual([false, []]);
});

test("the other computer asleep at the start: refused with its id, nothing written on either computer", async () => {
  const { studio, mini, s1, m1 } = world();
  mini.awake = false;
  const answer = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-asleep" })).body;
  expect(answer.code).toBe("machine_offline");
  // Which computer, for the window's own words about it.
  expect(answer.machine).toBe(mini.id);
  expect((await route(studio, "GET", "/api/inbox/combine")).body.combines).toEqual([]);
  expect([studio.store.threadMessageIds(s1.id).length, mini.store.threadMessageIds(m1.id).length]).toEqual([1, 1]);
  expect(studio.store.pendingReplies("ses_studio")).toEqual([]);
  expect([archived(studio, s1.id), archived(mini, m1.id), studio.outbox.list(mini.id)]).toEqual([false, false, []]);
});

test("the thread never comes: the Combine fails, nothing is archived on either computer, and the hold there is let go", async () => {
  const { studio, mini, s1, m1 } = world();
  await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-ended" });
  studio.live.delete("ses_studio");
  studio.clock.now += 3 * 60_000;
  studio.combine.check();
  await tick();
  expect(((await route(studio, "GET", "/api/inbox/combine")).body.combines as InboxCombineRecord[])[0]).toMatchObject({ state: "failed", reason: "ended" });
  expect([archived(studio, s1.id), archived(mini, m1.id), mini.applied]).toEqual([false, false, []]);
  // Mini can combine its thread again.
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Other", body: "x" }).message;
  expect((await route(mini, "POST", "/api/inbox/combine", { thread_ids: [m1.id, m2.id], session: "ses_mini", idempotency_key: "k-mini" })).body.combine.state).toBe("asked");
});

test("a thread archived on the other computer before stays archived and is not sent; one written in since its archive is archived again", async () => {
  const { studio, mini, s1, m1 } = world();
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Old export", body: "Done." }).message;
  mini.store.resolveThread(m2.id, true, "person");
  const m2At = mini.store.message(m2.id)!.resolved_at;
  mini.store.resolveThread(m1.id, true, "person");
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: "One more thing." });
  expect(mini.store.listRow(m1.id)!.back_from_archive).toBe(true);
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id, m2.id], session: "ses_studio", idempotency_key: "k-archived" })).body.combine as InboxCombineRecord;
  expect(record.threads.map((t) => [t.id, t.archived ?? false])).toEqual([[s1.id, false], [m1.id, false], [m2.id, true]]);
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  // One write there, under one guard: brought back and archived again, so its archive line comes after what was written.
  expect(mini.applied).toEqual([`archive ${m1.id}`]);
  expect(mini.store.listRow(m1.id)!.back_from_archive).toBe(false);
  expect(mini.store.message(m2.id)!.resolved_at).toBe(m2At);
  await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {});
  expect(mini.applied.slice(1)).toEqual([`undo ${m1.id}`]);
  expect(mini.store.message(m2.id)!.resolved_at).toBe(m2At);
});

test("this Inbox stopped before the other computer's archive was held: the next run holds it, once; past its day, never", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-restart" })).body.combine as InboxCombineRecord;
  const restart = (c: Computer, options: { far?: boolean } = {}) => {
    c.combine.close();
    c.combine = engine(c, options);
  };
  // The thread arrives while the linked machines are not up (as just before a stop): this computer's thread goes.
  restart(studio, { far: false });
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  expect([archived(studio, s1.id), archived(mini, m1.id), mini.applied]).toEqual([true, false, []]);
  // The next run, with the machines up: its first check holds and sends it; again, nothing is sent twice.
  restart(studio);
  studio.combine.check();
  await tick();
  expect(mini.applied).toEqual([`archive ${m1.id}`]);
  restart(studio);
  studio.combine.check();
  await tick();
  expect(mini.applied).toEqual([`archive ${m1.id}`]);

  // Another one, stopped before its archive there, and this Inbox back only after a day: the archive is never sent.
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Later", body: "x" }).message;
  const s2 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Later here", body: "x" }).message;
  const late = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s2.id, m2.id], session: "ses_studio", idempotency_key: "k-late" })).body.combine as InboxCombineRecord;
  restart(studio, { far: false });
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined later", body: "x", idempotency_key: late.id });
  await tick();
  studio.clock.now += 25 * 60 * 60_000;
  restart(studio);
  studio.combine.check();
  await tick();
  expect(archived(mini, m2.id)).toBe(false);
  expect(mini.applied).toEqual([`archive ${m1.id}`]);
});

test("a double press while the other computer's thread is read starts one Combine", async () => {
  const { studio, s1, m1 } = world();
  const body = { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-twice" };
  const [a, b] = await Promise.all([route(studio, "POST", "/api/inbox/combine", body), route(studio, "POST", "/api/inbox/combine", body)]);
  expect(a.body.combine.id).toBe(b.body.combine.id);
  expect((await route(studio, "GET", "/api/inbox/combine")).body.combines).toHaveLength(1);
  expect(studio.store.threadMessageIds(s1.id)).toHaveLength(2);
});

test("with no linked machine, a thread this store does not hold is refused as before", async () => {
  const { studio, s1, m1 } = world();
  studio.other = null;
  expect((await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-alone" })).body).toMatchObject({ code: "thread_not_found", error: `No thread ${m1.id} on this machine.` });
});


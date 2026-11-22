/**
 * Combine across linked computers (approval "inbox-combine-across-computers"; inbox-combine.ts, inbox-combine-far.ts),
 * on two real stores in process: the other computer's door is its real `agent-read` answer, and its archive is the
 * outbox (a real InboxOutbox) drained into that computer's store as its door's `messages/:id/resolve` does. No Inbox
 * is started. Both directions: the writer on this computer with a picked thread on the other, and the writer on the
 * other computer with a picked thread here.
 *
 * What regresses: the other computer's thread missing from the wake or its open questions; a note written in it; an
 * archive on either computer before the new thread arrives, or when it never does; the other computer's thread left
 * unarchived, or archived twice; Undo that brings back only this computer's threads, or lands before the archive when
 * the other computer was asleep; a restart that loses the archive there; a double press that starts two Combines.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxCombineRecord, InboxTidyReach } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCombine } from "./inbox-combine";
import { createInboxCombineFar } from "./inbox-combine-far";
import { agentReadDoorAnswer } from "./inbox-far-read";
import { createMachineAgentRead } from "./inbox-machine-agent-read";
import { InboxOutbox } from "./inbox-outbox";
import type { PeerLink } from "./inbox-peer-link";

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "claude-code", session, name: null });
const ask = (q: string) => [q, "", ":::question", q, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Computer {
  name: string;
  id: string;
  store: InboxStore;
  outbox: InboxOutbox;
  clock: { now: number };
  awake: boolean;
  live: Map<string, InboxTidyReach>;
  project: string;
  /** What its door applied, in order: `<archive|undo> <thread>`. */
  applied: string[];
  combine: ReturnType<typeof createInboxCombine>;
  other: Computer | null;
}

function computer(name: string, letter: string): Computer {
  const dir = mkdtempSync(join(tmpdir(), `plannotator-combine-far-${name.toLowerCase()}-`));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-22T10:00:00.000Z") };
  const store = InboxStore.open(join(dir, "store"), { now: () => new Date((clock.now += 1000)) });
  const c = {
    name,
    id: `ibx_${"0".repeat(25)}${letter}`,
    store,
    outbox: InboxOutbox.open(join(dir, "data")),
    clock,
    awake: true,
    live: new Map<string, InboxTidyReach>(),
    project: store.ensureProject({ name: `${name.toLowerCase()}-svc`, root: `/work/${name.toLowerCase()}-svc` }).id,
    applied: [] as string[],
    other: null,
  } as unknown as Computer;
  c.combine = engine(c);
  return c;
}

/** The other computer's door as a link sees it: awake or asleep, its real `agent-read`, its list's marks. */
function linkTo(there: Computer): PeerLink {
  return {
    id: there.id,
    get state() {
      return there.awake ? "online" : "offline";
    },
    // Its list, as the link last read it: the threads it lists name it as theirs.
    get list() {
      return { rows: there.store.listRows().map((row) => ({ ...row, machine: there.id })), marks: ["agent-read", "combine", "combine-across"] };
    },
    request: async (route: string, search: string) =>
      route === "agent-read" ? agentReadDoorAnswer({ store: there.store, stepsOn: () => false }, new URL(`http://door.local/api/inbox/device/${route}${search}`)) : Response.json({ code: "device_route_not_found" }, { status: 404 }),
  } as unknown as PeerLink;
}

/** The sender loop to `there`: each held resolve applied as its door's route applies it. */
const drain = (here: Computer, there: Computer) =>
  here.outbox.drain(there.id, async (entry) => {
    if (!there.awake) return null;
    const id = decodeURIComponent(/^messages\/([^/]+)\/resolve$/.exec(entry.route)![1]!);
    const resolved = entry.body.resolved !== false;
    there.store.resolveThread(id, resolved, "person");
    there.applied.push(`${resolved ? "archive" : "undo"} ${id}`);
    return { status: 200, body: {} };
  });

function engine(c: Computer, options: { far?: boolean } = {}) {
  const made = createInboxCombine({
    store: c.store,
    serverSession: "srv",
    reachFor: () => (session) => c.live.get(session) ?? null,
    idleSince: () => null,
    readBody: (req) => req.json() as Promise<Record<string, unknown>>,
    json: (body, status = 200) => Response.json(body, { status }),
    now: () => c.clock.now,
    far: () =>
      options.far === false || !c.other
        ? null
        : createInboxCombineFar({
            readThread: (q) => createMachineAgentRead({ peers: () => [linkTo(c.other!)], nameOf: () => c.other!.name }).readThread(q),
            rowOf: (id) => c.other!.store.listRow(id),
            // As the machines module holds a write: in the outbox, sent now while that machine is awake.
            hold: async (machine, route, body, thread, waitMs) => {
              const { entry } = c.outbox.submit(machine, route, body, thread);
              if (c.other!.awake) await drain(c, c.other!);
              return c.outbox.waitSettled(entry.key, c.other!.awake ? waitMs : 0);
            },
          }),
  });
  closers.push(() => made.close());
  return made;
}

/** Studio and Mini, linked: an agent on each wrote one thread there, Mini's with an open question. */
function world() {
  const studio = computer("Studio", "S");
  const mini = computer("Mini", "M");
  studio.other = mini;
  mini.other = studio;
  studio.live.set("ses_studio", "wakes");
  mini.live.set("ses_mini", "wakes");
  const s1 = studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Invoice retries", body: ask("Retry declined cards after 24 hours?") }).message;
  const m1 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Retry worker backoff", body: ask("Cap the backoff at 50 minutes?") }).message;
  return { studio, mini, s1, m1 };
}

async function route(c: Computer, method: string, path: string, body?: Record<string, unknown>) {
  const res = await c.combine
    .route(new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify({ serverSession: "srv", ...body }) : undefined }), new URL(`http://127.0.0.1${path}`))
    .catch((error: { code?: string; message?: string }) => Response.json({ code: error.code, error: error.message }));
  return (await res!.json()) as Record<string, any>;
}
const archived = (c: Computer, id: string) => c.store.message(id)!.resolved_at !== null;

for (const writerOn of ["Studio", "Mini"] as const) {
  test(`the writer on ${writerOn}: the other computer's thread is in the wake, archived there only once the new thread arrives, and Undo brings back both`, async () => {
    const w = world();
    const [here, there, mine, theirs, session] = writerOn === "Studio" ? [w.studio, w.mini, w.s1, w.m1, "ses_studio"] : [w.mini, w.studio, w.m1, w.s1, "ses_mini"];
    const record = (await route(here, "POST", "/api/inbox/combine", { thread_ids: [mine.id, theirs.id], session, idempotency_key: "k-1" })).combine as InboxCombineRecord;
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
    expect([archived(here, mine.id), archived(there, theirs.id), here.outbox.list(there.id)]).toEqual([false, false, []]);

    // The new thread, under the Combine's key, on the writer's computer: both picked threads go.
    const made = here.store.sendMessage({ project_id: here.project, author: agent(session), subject: "Retries, combined", body: "Where it all stands.", idempotency_key: record.id }).message;
    await tick();
    expect([archived(here, mine.id), archived(there, theirs.id), archived(here, made.id)]).toEqual([true, true, false]);
    expect(there.applied).toEqual([`archive ${theirs.id}`]);
    expect(((await route(here, "GET", "/api/inbox/combine")).combines as InboxCombineRecord[])[0]).toMatchObject({ id: record.id, state: "done", thread: { id: made.id } });

    const undone = (await route(here, "POST", `/api/inbox/combine/${record.id}/undo`, {})).combine as InboxCombineRecord;
    expect(undone.state).toBe("undone");
    expect([archived(here, mine.id), archived(there, theirs.id), archived(here, made.id)]).toEqual([false, false, false]);
    expect(there.applied).toEqual([`archive ${theirs.id}`, `undo ${theirs.id}`]);
  });
}

test("the other computer asleep at the start: refused with its name, nothing written on either computer", async () => {
  const { studio, mini, s1, m1 } = world();
  mini.awake = false;
  const answer = await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-asleep" });
  expect(answer.code).toBe("machine_offline");
  expect(answer.error).toContain("Mini");
  expect((await route(studio, "GET", "/api/inbox/combine")).combines).toEqual([]);
  expect([studio.store.threadMessageIds(s1.id).length, mini.store.threadMessageIds(m1.id).length]).toEqual([1, 1]);
  expect(studio.store.pendingReplies("ses_studio")).toEqual([]);
  expect([archived(studio, s1.id), archived(mini, m1.id), studio.outbox.list(mini.id)]).toEqual([false, false, []]);
});

test("the other computer asleep when the thread arrives, and an Undo meanwhile: held in order, and both apply once it is back", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-held" })).combine as InboxCombineRecord;
  mini.awake = false;
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  // This computer's goes now; Mini's waits for Mini.
  expect([archived(studio, s1.id), archived(mini, m1.id)]).toEqual([true, false]);
  expect(studio.outbox.list(mini.id, "pending").map((e) => [e.route, e.body.resolved])).toEqual([[`messages/${m1.id}/resolve`, true]]);
  // Undo while Mini sleeps: answered at once (no wait for a machine away), queued behind the archive.
  const started = Date.now();
  expect(((await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {})).combine as InboxCombineRecord).state).toBe("undone");
  expect(Date.now() - started).toBeLessThan(1500);
  expect(archived(studio, s1.id)).toBe(false);
  expect(studio.outbox.list(mini.id, "pending").map((e) => e.body.resolved)).toEqual([true, false]);
  // Mini is back: the archive, then the Undo, each once.
  mini.awake = true;
  await drain(studio, mini);
  expect(mini.applied).toEqual([`archive ${m1.id}`, `undo ${m1.id}`]);
  expect(archived(mini, m1.id)).toBe(false);
  await drain(studio, mini);
  expect(mini.applied).toHaveLength(2);
});

test("the thread never comes: the Combine fails and nothing is archived on either computer", async () => {
  const { studio, mini, s1, m1 } = world();
  await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-ended" });
  studio.live.delete("ses_studio");
  studio.clock.now += 3 * 60_000;
  studio.combine.check();
  expect(((await route(studio, "GET", "/api/inbox/combine")).combines as InboxCombineRecord[])[0]).toMatchObject({ state: "failed", reason: "ended" });
  expect([archived(studio, s1.id), archived(mini, m1.id), studio.outbox.list(mini.id), mini.applied]).toEqual([false, false, [], []]);
});

test("a thread archived on the other computer before stays archived and is not sent; one written in since its archive is archived again", async () => {
  const { studio, mini, s1, m1 } = world();
  const m2 = mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), subject: "Old export", body: "Done." }).message;
  mini.store.resolveThread(m2.id, true, "person");
  const m2At = mini.store.message(m2.id)!.resolved_at;
  // m1 archived, then written in: back from the archive.
  mini.store.resolveThread(m1.id, true, "person");
  mini.store.sendMessage({ project_id: mini.project, author: agent("ses_mini"), reply_to: m1.id, body: "One more thing." });
  expect(mini.store.listRow(m1.id)!.back_from_archive).toBe(true);
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id, m2.id], session: "ses_studio", idempotency_key: "k-archived" })).combine as InboxCombineRecord;
  expect(record.threads.map((t) => [t.id, t.archived ?? false])).toEqual([[s1.id, false], [m1.id, false], [m2.id, true]]);
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  expect(mini.applied).toEqual([`undo ${m1.id}`, `archive ${m1.id}`]);
  expect(mini.store.listRow(m1.id)!.back_from_archive).toBe(false);
  expect(mini.store.message(m2.id)!.resolved_at).toBe(m2At);
  await route(studio, "POST", `/api/inbox/combine/${record.id}/undo`, {});
  expect(mini.applied.slice(2)).toEqual([`undo ${m1.id}`]);
  expect(mini.store.message(m2.id)!.resolved_at).toBe(m2At);
});

test("this Inbox stopped before the other computer's archive was held: the next run holds it, once", async () => {
  const { studio, mini, s1, m1 } = world();
  const record = (await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-restart" })).combine as InboxCombineRecord;
  // The thread arrives while the linked machines are not up (as just before a stop): this computer's thread goes.
  const restart = (options: { far?: boolean } = {}) => {
    studio.combine.close();
    studio.combine = engine(studio, options);
  };
  restart({ far: false });
  studio.store.sendMessage({ project_id: studio.project, author: agent("ses_studio"), subject: "Combined", body: "x", idempotency_key: record.id });
  await tick();
  expect([archived(studio, s1.id), archived(mini, m1.id), mini.applied]).toEqual([true, false, []]);
  // The next run, with the machines up: its first check holds and sends it.
  restart();
  studio.combine.check();
  await tick();
  expect(mini.applied).toEqual([`archive ${m1.id}`]);
  // And again: the same key, nothing sent twice.
  restart();
  studio.combine.check();
  await tick();
  expect(mini.applied).toEqual([`archive ${m1.id}`]);
  expect(studio.outbox.list(mini.id)).toHaveLength(1);
});

test("a double press while the other computer's thread is read starts one Combine", async () => {
  const { studio, s1, m1 } = world();
  const body = { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-twice" };
  const [a, b] = await Promise.all([route(studio, "POST", "/api/inbox/combine", body), route(studio, "POST", "/api/inbox/combine", body)]);
  expect(a.combine.id).toBe(b.combine.id);
  expect((await route(studio, "GET", "/api/inbox/combine")).combines).toHaveLength(1);
  expect(studio.store.threadMessageIds(s1.id)).toHaveLength(2);
});

test("with no linked machine, a thread this store does not hold is refused as before", async () => {
  const { studio, s1, m1 } = world();
  studio.other = null;
  expect(await route(studio, "POST", "/api/inbox/combine", { thread_ids: [s1.id, m1.id], session: "ses_studio", idempotency_key: "k-alone" })).toMatchObject({ code: "thread_not_found", error: `No thread ${m1.id} on this machine.` });
});

/**
 * Two linked computers in process for the Combine across computers tests (packages/server/inbox-combine-far.test.ts,
 * inbox-combine-across.test.ts): two real stores, each with its own Combine engine and a real outbox. The other
 * computer's door is its real `agent-read` and `agent-file` answers, and its held writes are applied as its door
 * applies them: `messages/:id/resolve` under the Combine's guard (inbox-combine-guard.ts), `combine/hold` by its own
 * engine. No Inbox is started, nothing is bound.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxTidyReach } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCombine } from "./inbox-combine";
import { createInboxCombineFar } from "./inbox-combine-far";
import { combineArchiveAgain, combineArchiveSkip } from "./inbox-combine-guard";
import { agentFileDoorAnswer, agentReadDoorAnswer } from "./inbox-far-read";
import { createMachineAgentRead } from "./inbox-machine-agent-read";
import { InboxOutbox } from "./inbox-outbox";
import type { PeerLink } from "./inbox-peer-link";

export const roots: string[] = [];
export const closers: (() => void)[] = [];
export function cleanUp() {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export const agent = (session: string): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: "claude-code", session, name: null });
export const ask = (q: string) => [q, "", ":::question", q, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
export const tick = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

export interface Computer {
  name: string;
  id: string;
  dir: string;
  store: InboxStore;
  outbox: InboxOutbox;
  clock: { now: number };
  awake: boolean;
  /** Its door applies a write but the answer never comes back (the link dropped mid-send). */
  dropAnswers?: boolean;
  live: Map<string, InboxTidyReach>;
  project: string;
  /** What its door applied, in order: `<archive|undo|skip> <thread>`. */
  applied: string[];
  combine: ReturnType<typeof createInboxCombine>;
  other: Computer | null;
}

export function computer(name: string, letter: string): Computer {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `plannotator-combine-far-${name.toLowerCase()}-`)));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-22T10:00:00.000Z") };
  const store = InboxStore.open(join(dir, "store"), { now: () => new Date((clock.now += 1000)) });
  const c = {
    name,
    id: `ibx_${"0".repeat(25)}${letter}`,
    dir,
    store,
    outbox: InboxOutbox.open(join(dir, "data"), () => new Date(clock.now)),
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

/** The other computer's door as a link sees it: awake or asleep, its real `agent-read` and `agent-file`, its list's marks. */
function linkTo(there: Computer): PeerLink {
  return {
    id: there.id,
    get state() {
      return there.awake ? "online" : "offline";
    },
    get list() {
      return { rows: there.store.listRows().map((row) => ({ ...row, machine: there.id })), marks: ["agent-read", "combine", "combine-across"] };
    },
    request: async (route: string, search: string) => {
      if (!there.awake) throw new Error("asleep");
      const url = new URL(`http://door.local/api/inbox/device/${route}${search}`);
      if (route === "agent-read") return agentReadDoorAnswer({ store: there.store, stepsOn: () => false }, url);
      if (route === "agent-file") return agentFileDoorAnswer(there.store, url);
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  } as unknown as PeerLink;
}

/** The sender loop to `there`: each held write applied as its door's route applies it. */
export const drain = (here: Computer, there: Computer) =>
  here.outbox.drain(there.id, async (entry) => {
    if (!there.awake) return null;
    const answer = await applyThere(here, there, entry.route, entry.body);
    return there.dropAnswers ? null : answer;
  });

async function applyThere(here: Computer, there: Computer, path: string, body: Record<string, unknown>) {
  if (path === "combine/hold") {
    const res = await route(there, "POST", "/api/inbox/combine/hold", body, here.id);
    return { status: res.status, body: res.body };
  }
  const id = decodeURIComponent(/^messages\/([^/]+)\/resolve$/.exec(path)![1]!);
  const skipped = combineArchiveSkip(there.store, id, body);
  if (skipped) {
    there.applied.push(`skip ${id}`);
    return { status: 200, body: { skipped } };
  }
  combineArchiveAgain(there.store, id, body);
  const resolved = body.resolved !== false;
  there.store.resolveThread(id, resolved, "person");
  there.applied.push(`${resolved ? "archive" : "undo"} ${id}`);
  return { status: 200, body: {} };
}

export function engine(c: Computer, options: { far?: boolean; editRead?: (answer: any) => any; fetchFile?: (args: { message_id: string; file: string }, real: () => Promise<Response>) => Promise<Response>; filesMaxBytes?: number } = {}) {
  const read = () => createMachineAgentRead({ peers: () => [linkTo(c.other!)], nameOf: () => c.other!.name });
  const made = createInboxCombine({
    store: c.store,
    serverSession: "srv",
    reachFor: () => (session) => c.live.get(session) ?? null,
    idleSince: () => null,
    readBody: (req) => req.json() as Promise<Record<string, unknown>>,
    json: (body, status = 200) => Response.json(body, { status }),
    now: () => c.clock.now,
    ...(options.filesMaxBytes !== undefined ? { filesMaxBytes: options.filesMaxBytes } : {}),
    liveSessions: () => [...c.live.keys()].map((session) => ({ session, host: "claude-code", root: null })),
    nameOf: () => c.other?.name ?? "another computer",
    doorMachine: (req) => req.headers.get("x-test-machine"),
    far: () =>
      options.far === false || !c.other
        ? null
        : createInboxCombineFar({
            readThread: async (q) => {
              const got = await read().readThread(q);
              return got && options.editRead ? { ...got, answer: options.editRead(got.answer) } : got;
            },
            rowOf: (id) => {
              const row = c.other!.store.listRow(id);
              return row ? { ...row, machine: c.other!.id } : null;
            },
            // As the machines module holds a write: in the outbox, this Inbox's own, sent now while that machine is awake.
            hold: async (machine, route, body, thread, waitMs, own) => {
              const { entry } = c.outbox.submit(machine, route, body, thread, false, null, true, own);
              if (c.other!.awake) await drain(c, c.other!);
              return c.outbox.waitSettled(entry.key, c.other!.awake ? waitMs : 0);
            },
            heldWrite: (key) => c.outbox.get(key),
            // Its list as held here: the other computer's rows as they are now.
            listedRows: () => c.other!.store.listRows(),
            cancelHeld: (key) => c.outbox.cancel(key),
            fetchFile: (args) => (options.fetchFile ? options.fetchFile(args, () => read().fetchFile(args)) : read().fetchFile(args)),
            online: () => c.other!.awake,
          }),
  });
  closers.push(() => made.close());
  return made;
}

/** Studio and Mini, linked: an agent on each wrote one thread there, each with an open question. */
export function world() {
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

export async function route(c: Computer, method: string, path: string, body?: Record<string, unknown>, fromMachine?: string): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(fromMachine ? { "x-test-machine": fromMachine } : {}) };
  const res = await c.combine
    .route(new Request(`http://127.0.0.1${path}`, { method, headers, body: body ? JSON.stringify({ serverSession: "srv", ...body }) : undefined }), new URL(`http://127.0.0.1${path}`))
    .then((r) => r!)
    .catch((error: { code?: string; message?: string; details?: Record<string, unknown> }) => Response.json({ code: error.code, error: error.message, ...(error.details ?? {}) }, { status: 409 }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export const archived = (c: Computer, id: string) => c.store.message(id)!.resolved_at !== null;

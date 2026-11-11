import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createListReader, type ListReadAnswer } from "../inbox/listRead";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;
type Model = Json & { sections: Json[]; snoozed?: Json[]; pins?: Json[]; list_version?: string };

const WINDOW_LIST = "/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-list-delta-")));
  roots.push(root);
  return join(root, "data");
}

const noTailscale: TailscaleRunner = () => ({ status: 1, stdout: "", stderr: "not here" });

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: noTailscale });
  servers.push(server);
  return server;
}

async function getJson(server: InboxServer, path: string): Promise<Model> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Model;
}

function windowReader(server: () => InboxServer) {
  const answers: ("delta" | "whole")[] = [];
  const reader = createListReader<Model>(async (since) => {
    const answer = (await getJson(server(), `${WINDOW_LIST}&since=${encodeURIComponent(since)}`)) as ListReadAnswer<Model>;
    answers.push("delta" in answer && answer.delta ? "delta" : "whole");
    return answer;
  });
  return { reader, answers };
}

const withoutVersion = ({ list_version: _version, ...model }: Model) => model;

async function expectSameAsFull(server: InboxServer, merged: Model, step: string) {
  const full = await getJson(server, WINDOW_LIST);
  expect({ step, model: withoutVersion(merged) }).toEqual({ step, model: full });
}

const agent = (session: string, name = "Claude Code") => ({ kind: "agent" as const, host: "claude-code", session, name });
const QUESTION = ":::question\nShip the retry worker now?\n- Yes\n- No\n:::";

function seed(store: InboxStore) {
  const api = store.ensureProject({ name: "api", root: "/work/api" });
  const web = store.ensureProject({ name: "web", root: "/work/web" });
  const ids: Record<string, string> = {};
  ids.asks = store.sendMessage({ project_id: api.id, author: agent("ses_a"), body: `Before I ship it.\n\n${QUESTION}` }).message.id;
  ids.news = store.sendMessage({ project_id: api.id, author: agent("ses_b"), body: "The build is green." }).message.id;
  ids.quiet = store.sendMessage({ project_id: web.id, author: agent("ses_c"), body: "Docs updated." }).message.id;
  ids.later = store.sendMessage({ project_id: web.id, author: agent("ses_d"), body: "Second opinion on the layout." }).message.id;
  ids.gone = store.sendMessage({ project_id: web.id, author: agent("ses_e"), body: "A thread to delete." }).message.id;
  store.markSeen(ids.quiet);
  return { api: api.id, web: web.id, ids };
}

describe("the window's list read, only what changed", () => {
  test("after every step of a mix of events, the list put together from changes is the full list, for a window that reads each time and one that falls behind", async () => {
    const inbox = await start(scratch());
    const store = inbox.store;
    const { api, web, ids } = seed(store);
    const eager = windowReader(() => inbox);
    const behind = windowReader(() => inbox);
    await expectSameAsFull(inbox, await eager.reader.read(), "first read");
    await expectSameAsFull(inbox, await behind.reader.read(), "first read, the window that falls behind");

    const steps: [string, () => void | Promise<void>][] = [
      ["a new message in a thread", () => void store.sendMessage({ project_id: api, author: agent("ses_b"), body: "And the tests pass.", reply_to: ids.news })],
      ["a new thread", () => void (ids.fresh = store.sendMessage({ project_id: api, author: agent("ses_f"), body: "Started on the export." }).message.id)],
      [
        "an answer picked, not sent (unsent work)",
        () => {
          const question = store.questionsOf(ids.asks)[0]!;
          store.savePicks(ids.asks, [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ["Yes"] } }]);
        },
      ],
      [
        "the answer sent",
        () => {
          const question = store.questionsOf(ids.asks)[0]!;
          store.sendReply(ids.asks, { words: "Go.", questions: [{ key: question.key, revision: question.revision }], idempotency_key: "send-1" });
        },
      ],
      ["a reply draft typed", () => void store.saveReplyDraft(ids.later, { body: "Half a thought" })],
      ["a thread looked at", () => void store.markSeen(ids.news)],
      ["Mark read", () => void store.markRead(ids.later, true)],
      ["Mark unread", () => void store.markUnread(ids.quiet)],
      ["archived", () => void store.resolveThread(ids.news, true, "person")],
      ["pinned (an archived thread stays pinned)", () => void store.setPinned(ids.news, true)],
      ["another pinned", () => void store.setPinned(ids.quiet, true)],
      ["snoozed", () => void store.setSnooze(ids.fresh, new Date(Date.now() + 2 * 86_400_000).toISOString())],
      ["an agent writes in a snoozed thread", () => void store.sendMessage({ project_id: api, author: agent("ses_f"), body: "Export half done.", reply_to: ids.fresh })],
      ["unsnoozed", () => store.clearSnooze(ids.fresh)],
      ["deleted", () => store.deleteThread(ids.gone)],
      ["a new project", () => void (ids.other = store.sendMessage({ project_id: store.ensureProject({ name: "ops", root: "/work/ops" }).id, author: agent("ses_g"), body: "Disk at 80%." }).message.id)],
      ["a project of the same folder name (labels change)", () => void store.sendMessage({ project_id: store.ensureProject({ name: "api", root: "/other/api" }).id, author: agent("ses_h"), body: "Same name, other folder." })],
      ["a project renamed", () => void store.renameProject(web, "website")],
      ["a project's threads moved into another (combine)", () => void store.combineProject(web, api)],
      ["the person starts a thread to a session", () => void (ids.mine = store.startPersonThread({ project_id: api, body: "Can you look at the flaky test?", to: { host: "claude-code", session: "ses_y" }, idempotency_key: "start-1" }).message.id)],
      ["the person's thread moved to another session", () => void store.readdressMessage(ids.mine, { host: "claude-code", session: "ses_z" })],
      ["unarchived", () => void store.resolveThread(ids.news, false, "person")],
      ["unpinned", () => void store.setPinned(ids.quiet, false)],
      ["an agent writes after the archive (comes back)", () => {
        store.resolveThread(ids.other, true, "person");
        store.sendMessage({ project_id: store.message(ids.other)!.project_id, author: agent("ses_g"), body: `Disk at 95%.\n\n${QUESTION}`, reply_to: ids.other });
      }],
      ["the reply draft discarded", () => void store.saveReplyDraft(ids.later, { body: "", base: store.replyDraft(ids.later)?.updated_at ?? null })],
      ["nothing changed", () => {}],
    ];
    let index = 0;
    for (const [step, act] of steps) {
      await act();
      await expectSameAsFull(inbox, await eager.reader.read(), step);
      if (++index % 3 === 0) await expectSameAsFull(inbox, await behind.reader.read(), `${step} (several steps behind)`);
    }
    await expectSameAsFull(inbox, await behind.reader.read(), "the window behind catches up");
    expect(eager.answers[0]).toBe("whole");
    expect(eager.answers.slice(1).every((answer) => answer === "delta")).toBe(true);
    expect(behind.answers.slice(1).every((answer) => answer === "delta")).toBe(true);
  }, 60_000);

  test("a change is small: one agent message among many threads sends that one row, not the list", async () => {
    const inbox = await start(scratch());
    const store = inbox.store;
    const project = store.ensureProject({ name: "api", root: "/work/api" });
    const threads = Array.from({ length: 60 }, (_, i) => store.sendMessage({ project_id: project.id, author: agent(`ses_${i}`), body: `Update ${i}: ${"words ".repeat(40)}` }).message.id);
    const first = await getJson(inbox, `${WINDOW_LIST}&since=`);
    store.sendMessage({ project_id: project.id, author: agent("ses_7"), body: "One more.", reply_to: threads[7] });
    const response = await fetch(`http://127.0.0.1:${inbox.port}${WINDOW_LIST}&since=${first.list_version}`);
    const text = await response.text();
    const answer = JSON.parse(text) as Json;
    expect(answer.delta.rows.map((row: Json) => row.thread_id)).toEqual([threads[7]]);
    const full = await (await fetch(`http://127.0.0.1:${inbox.port}${WINDOW_LIST}`)).text();
    expect(text.length * 4).toBeLessThan(full.length);
  }, 30_000);

  test("a read without since is answered exactly as before (the phone, a linked machine, an older window); with since it carries a version", async () => {
    const inbox = await start(scratch());
    seed(inbox.store);
    for (const query of ["/api/inbox/threads", "/api/inbox/threads?archived=exclude", WINDOW_LIST]) {
      const plain = await getJson(inbox, query);
      expect("list_version" in plain).toBe(false);
      expect("delta" in plain).toBe(false);
      const asked = await getJson(inbox, `${query}${query.includes("?") ? "&" : "?"}since=`);
      expect(typeof asked.list_version).toBe("string");
      expect(withoutVersion(asked)).toEqual(plain);
    }
  }, 30_000);

  test("a version the server cannot answer as a change gets the whole list: another run's, a forged one, another query's", async () => {
    const dataDir = scratch();
    let inbox = await start(dataDir);
    const { api } = seed(inbox.store);
    const window = windowReader(() => inbox);
    await window.reader.read();
    const held = (await getJson(inbox, `${WINDOW_LIST}&since=`)).list_version!;
    const [run, kind] = held.split(".");
    expect("delta" in (await getJson(inbox, `${WINDOW_LIST}&since=${run}.${kind}.99999`))).toBe(false);
    expect("delta" in (await getJson(inbox, `${WINDOW_LIST}&since=garbage`))).toBe(false);
    const other = (await getJson(inbox, `/api/inbox/threads?since=`)).list_version!;
    expect("delta" in (await getJson(inbox, `${WINDOW_LIST}&since=${other}`))).toBe(false);
    inbox.stop();
    servers.splice(servers.indexOf(inbox), 1);
    inbox = await start(dataDir);
    inbox.store.sendMessage({ project_id: api, author: agent("ses_after"), body: "After the restart." });
    await expectSameAsFull(inbox, await window.reader.read(), "after a restart");
    expect(window.answers).toEqual(["whole", "whole"]);
    inbox.store.sendMessage({ project_id: api, author: agent("ses_after"), body: "Again." });
    await expectSameAsFull(inbox, await window.reader.read(), "the next read");
    expect(window.answers.at(-1)).toBe("delta");
  }, 60_000);

  test("most rows changed at once (a long sleep, a big batch): the whole list, not a change as big as it", async () => {
    const inbox = await start(scratch());
    const store = inbox.store;
    const project = store.ensureProject({ name: "api", root: "/work/api" });
    const threads = Array.from({ length: 40 }, (_, i) => store.sendMessage({ project_id: project.id, author: agent(`ses_${i}`), body: `Update ${i}` }).message.id);
    const window = windowReader(() => inbox);
    await window.reader.read();
    for (const id of threads.slice(0, 30)) store.markSeen(id);
    await expectSameAsFull(inbox, await window.reader.read(), "after most rows changed");
    expect(window.answers).toEqual(["whole", "whole"]);
  }, 30_000);
});

describe("a linked machine's rows in the window's list", () => {
  const OTHER = "ibx_01K00000000000000000000000";
  const SELF = "ibx_01K00000000000000000000001";

  test("rows another machine adds, changes and drops are put together exactly as a full read has them", async () => {
    const dataDir = scratch();
    const row = (id: string, fields: Json = {}) => ({
      thread_id: id,
      subject: `Far ${id.slice(-2)}`,
      section: "waiting",
      unread: true,
      unseen: 1,
      last_at: "2026-11-01T10:00:00.000Z",
      resolved_at: null,
      project: { id: "prj_01KFAR0000000000000000000A", name: "far-api" },
      ...fields,
    });
    let farCursor = 1;
    let farRows: Json[] = [row("msg_01KFAR00000000000000000001"), row("msg_01KFAR00000000000000000002", { section: "new", last_at: "2026-11-01T09:00:00.000Z" })];
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const encoder = new TextEncoder();
    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(req) {
        const route = new URL(req.url).pathname.replace("/api/inbox/device/", "");
        if (route === "health") return Response.json({ ok: true, inbox_id: OTHER, machine_links: 1, version: "peer" });
        if (route === "events") {
          return new Response(
            new ReadableStream({
              start: (c) => {
                streams.add(c);
                c.enqueue(encoder.encode(`event: hello\ndata: {"cursor":${farCursor}}\n\n`));
              },
              cancel: () => {},
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        if (route === "threads") {
          const sections = ["stopped", "holding", "waiting", "new", "sent", "quiet"].map((id) => ({ id, label: id, threads: farRows.filter((r) => r.section === id) }));
          return Response.json({ cursor: farCursor, sections, projects: [{ id: "prj_01KFAR0000000000000000000A", name: "far-api", threads: farRows.length, unread: 1 }] });
        }
        return Response.json({ ok: true });
      },
    });
    const farChange = (rows: Json[]) => {
      farRows = rows;
      farCursor += 1;
      for (const c of streams) c.enqueue(encoder.encode(`id: ${farCursor}\nevent: record\ndata: {"seq":${farCursor},"kind":"project","id":"x"}\n\n`));
    };
    const link = { id: OTHER, name: "Mini", token: "tok_x", transport: { kind: "tailnet", url: `http://127.0.0.1:${peer.port}` }, device_id: null, linked_at: "2026-10-30T00:00:00Z" };
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "machines.json"), JSON.stringify({ v: 1, self: { id: SELF }, links: [link] }), { mode: 0o600 });
    const inbox = await start(dataDir);
    try {
      seed(inbox.store);
      const farListed = async (cursor: number) => {
        for (let waited = 0; waited < 10_000; waited += 50) {
          const machines = (await getJson(inbox, "/api/inbox/machines")).machines as Json[];
          if (machines.some((m) => m.id === OTHER && m.list_cursor === cursor && m.state === "online")) return;
          await Bun.sleep(50);
        }
        throw new Error(`the far list at ${cursor} never arrived`);
      };
      await farListed(farCursor);
      const window = windowReader(() => inbox);
      const first = await window.reader.read();
      expect(first.sections.flatMap((s: Json) => s.threads).filter((r: Json) => r.machine === OTHER)).toHaveLength(2);
      await expectSameAsFull(inbox, first, "the far rows merged");

      const steps: [string, (rows: Json[]) => Json[]][] = [
        ["a far row changes (a look, it sinks to quiet)", (rows) => [rows[0]!, { ...rows[1]!, section: "quiet", unread: false, unseen: 0 }]],
        ["a far row is added", (rows) => [...rows, row("msg_01KFAR00000000000000000003", { section: "stopped", last_at: "2026-11-01T11:00:00.000Z" })]],
        ["a far row is dropped (archived or deleted there)", (rows) => rows.filter((r) => !r.thread_id.endsWith("01"))],
        ["a far row moves to the top", (rows) => rows.map((r) => (r.thread_id.endsWith("02") ? { ...r, last_at: "2026-11-02T00:00:00.000Z", section: "new", unread: true } : r))],
        ["the dropped row comes back as it was", (rows) => [...rows, row("msg_01KFAR00000000000000000001")]],
      ];
      for (const [step, next] of steps) {
        farChange(next(farRows));
        await farListed(farCursor);
        await expectSameAsFull(inbox, await window.reader.read(), step);
      }
      inbox.store.sendMessage({ project_id: inbox.store.listProjects()[0]!.id, author: agent("ses_local"), body: "Local news." });
      await expectSameAsFull(inbox, await window.reader.read(), "a local message beside the far rows");
      expect(window.answers.slice(1).every((answer) => answer === "delta")).toBe(true);
    } finally {
      for (const c of streams) {
        try {
          c.close();
        } catch {}
      }
      peer.stop(true);
    }
  }, 60_000);
});

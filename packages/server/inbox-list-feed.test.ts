/**
 * The list feed against a real Inbox (temp data dir): readers that start from a first page and apply every `list`
 * frame the server sends (core's applier), catching up after a dropped connection and scrolling with pages that
 * may answer late, always hold what a fresh read gives; and a fresh read's rows are every row decorated again from
 * the store. Per reader: this computer's window (its own view and the merged one), and a guest over the tailnet.
 *
 * What this catches: a change whose rows never reach a reader (a missed candidate: a draft, a pin, a snooze running
 * out by the clock, a checklist, a PR, a live session, a project rename, a deletion), a frame chain with a hole, a
 * catch-up that misses a version, a guest that gets the owner's labels, and a whole list read (the phone, an older
 * window) that differs from the rows the feed holds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInboxListCatchUp,
  applyInboxListFrame,
  inboxListHeld,
  inboxListShown,
  inboxPlaceCompare,
  mergeInboxListPage,
  type InboxListCatchUp,
  type InboxListFrame,
  type InboxListHeld,
  type InboxListPage,
} from "@plannotator/core/inbox-list-feed";
import { inboxRowSnoozed, inboxSplitSnoozed } from "@plannotator/core/inbox-snooze";
import { parseInboxThreadPullRefs, type InboxListRow } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { inboxListSections, inboxRowArchived } from "@plannotator/shared/inbox/list";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

/** mulberry32: a small seeded generator, so a failing seed runs again. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAGIC = "box.tail1234.ts.net";
const OWNER = "owner@example.com";
const GUEST = "guest@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const closers: (() => void)[] = [];
const env: [string, string | undefined][] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) server.stop();
  for (const [name, value] of env.splice(0).reverse()) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setEnv(name: string, value: string | undefined) {
  env.push([name, process.env[name]]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A tailnet that publishes the Inbox and names the owner (as inbox-tailnet-owner.test.ts's). */
function fakeTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n`);
  };
}

async function start(): Promise<InboxServer> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-list-feed-")));
  roots.push(root);
  setEnv("PLANNOTATOR_DATA_DIR", root);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_AUTO_UPDATE", "PLANNOTATOR_UPDATE_CHECK"]) setEnv(name, undefined);
  writeFileSync(join(root, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST], updateCheck: false }));
  const server = await startInboxServer({
    dataDir: root,
    binaryPath: null,
    phones: false,
    tailscale: fakeTailscale(),
    steps: true,
    // A PR's state is read from a fake forge (never the real gh): open, always.
    refRunner: async () => ({ stdout: JSON.stringify({ data: { repository: {} } }), stderr: "", exitCode: 0 }),
  });
  servers.push(server);
  for (let i = 0; i < 100 && server.tailscale.listenerPort() === null; i++) await Bun.sleep(20);
  expect(server.tailscale.listenerPort()).not.toBeNull();
  return server;
}

type Caller = "local" | "guest";
/** A request as this computer's window sends it, or as a guest's browser through the tailnet. */
function get(server: InboxServer, caller: Caller, path: string, init: RequestInit = {}): Promise<Response> {
  if (caller === "local") return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { "Sec-Fetch-Site": "same-origin", ...(init.headers as Record<string, string>) } });
  return fetch(`http://127.0.0.1:${server.tailscale.listenerPort()}${path}`, {
    ...init,
    headers: { Host: `${MAGIC}:${server.port}`, Origin: `https://${MAGIC}:${server.port}`, "Sec-Fetch-Site": "same-origin", "X-Forwarded-Proto": "https", "Tailscale-User-Login": GUEST, ...(init.headers as Record<string, string>) },
  });
}
async function getJson<T>(server: InboxServer, caller: Caller, path: string): Promise<T> {
  const response = await get(server, caller, path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

interface Reader {
  name: string;
  caller: Caller;
  merged: boolean;
  held: InboxListHeld;
  frames: InboxListFrame[];
  /** Frames already applied. */
  taken: number;
  close: (() => void) | null;
}

const query = (reader: Pick<Reader, "merged">, rest: string) => `/api/inbox/threads?page=1${reader.merged ? "&machines=1" : ""}${rest}`;

/** Open the reader's event stream with `list=1`; its `list` frames are collected as they come. */
async function listen(server: InboxServer, reader: Reader): Promise<void> {
  const abort = new AbortController();
  const response = await get(server, reader.caller, `/api/inbox/events?list=1${reader.merged ? "&machines=1" : ""}`, { signal: abort.signal });
  expect(response.status).toBe(200);
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await body.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!block.split("\n").includes("event: list")) continue;
          const data = block.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
          reader.frames.push(JSON.parse(data) as InboxListFrame);
        }
      }
    } catch {
      // Aborted.
    }
  })();
  reader.close = () => abort.abort();
  closers.push(() => abort.abort());
}

/** Apply every frame that came; a gap (or a reconnect) catches up from the held version. */
async function take(server: InboxServer, reader: Reader): Promise<void> {
  while (reader.taken < reader.frames.length) {
    const next = applyInboxListFrame(reader.held, reader.frames[reader.taken++]!);
    reader.held = next === "gap" ? await catchUp(server, reader) : next;
  }
}
async function catchUp(server: InboxServer, reader: Reader): Promise<InboxListHeld> {
  const answer = await getJson<InboxListCatchUp | InboxListPage>(server, reader.caller, query(reader, `&since=${encodeURIComponent(reader.held.version)}`));
  return applyInboxListCatchUp(reader.held, answer);
}
/** Scroll to the end: every page after the held edge. */
async function scrollAll(server: InboxServer, held: InboxListHeld, reader: Pick<Reader, "caller" | "merged">, limit: number): Promise<InboxListHeld> {
  let out = held;
  for (let guard = 0; out.next !== null && guard < 500; guard++) {
    const merged = mergeInboxListPage(out, await getJson<InboxListPage>(server, reader.caller, query(reader, `&limit=${limit}&after=${encodeURIComponent(out.next)}`)));
    out = merged.catchUpFrom ? applyInboxListCatchUp(merged.held, await getJson(server, reader.caller, query(reader, `&since=${encodeURIComponent(merged.catchUpFrom)}`))) : merged.held;
  }
  return out;
}

const shown = (held: InboxListHeld) => inboxListShown(held).map(({ row, place }) => ({ row, place }));

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
const QUESTION = (n: number) => `:::question\nShip part ${n}?\n- [ ] Yes\n- [ ] No\n:::`;
const HOLDS = ":::question\nStopped: the release\nApprove the deploy?\n- [ ] Yes\n- [ ] No\n:::";

describe("the list feed", () => {
  test(
    "readers applying the server's frames and catch-ups hold what a fresh read gives, and a fresh read holds every row decorated again, per reader",
    async () => {
      for (const seed of [7, 31, 1201]) {
        const server = await start();
        const store = server.store;
        const random = seeded(seed);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
        const chance = (p: number) => random() < p;
        const projects = ["api", "web"].map((name) => store.ensureProject({ name, root: `/work/${name}` }));
        const roots2: string[] = [];
        const agentMessages: string[] = [];
        const sessions = ["ses_a", "ses_b", "ses_c"];
        const send = (reply: boolean) => {
          const author = agent(pick(sessions));
          const body = `Note ${agentMessages.length}.${chance(0.4) ? `\n\n${QUESTION(agentMessages.length)}` : ""}${chance(0.1) ? `\n\n${HOLDS}` : ""}`;
          const sent = store.sendMessage({ project_id: pick(projects).id, author, body, reply_to: reply && roots2.length > 0 ? pick(roots2) : null, wakes: chance(0.5) });
          if (!roots2.includes(sent.message.thread_id)) roots2.push(sent.message.thread_id);
          agentMessages.push(sent.message.id);
        };
        for (let i = 0; i < 24; i++) send(i > 6 && chance(0.4));
        for (const id of roots2.slice(0, 8)) store.markSeen(id);

        const limit = 3 + (seed % 5);
        const readers: Reader[] = [];
        for (const [name, caller, merged] of [["window", "local", false], ["window, merged view", "local", true], ["guest over the tailnet", "guest", false]] as const) {
          const reader: Reader = { name, caller, merged, held: inboxListHeld(await getJson<InboxListPage>(server, caller, query({ merged }, `&limit=${limit}`))), frames: [], taken: 0, close: null };
          await listen(server, reader);
          readers.push(reader);
        }

        // Every reader is fed by frames: one write reaches each, the guest's through the tailnet too.
        send(true);
        for (const reader of readers) {
          for (let i = 0; i < 100 && reader.frames.length === 0; i++) await Bun.sleep(10);
          expect({ seed, reader: reader.name, framed: reader.frames.length > 0 }).toEqual({ seed, reader: reader.name, framed: true });
          await take(server, reader);
        }

        const steps: (() => unknown)[] = [
          () => send(false),
          () => send(true),
          () => send(true),
          () => {
            const id = pick(agentMessages);
            const q = store.questionsOf(id).find((x) => x.state === "open");
            if (q) store.savePicks(id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }]);
          },
          () => {
            const id = pick(agentMessages);
            const qs = store.questionsOf(id).filter((x) => x.state === "picked");
            store.sendReply(id, { words: "Go.", questions: qs.map((q) => ({ key: q.key, revision: q.revision })), idempotency_key: `r-${random()}` });
          },
          () => store.markSeen(pick(roots2)),
          () => store.markRead(pick(roots2), chance(0.7)),
          () => store.resolveThread(pick(roots2), chance(0.7), "person"),
          () => store.setPinned(pick(roots2), chance(0.7)),
          () => store.setSnooze(pick(roots2), new Date(Date.now() + (chance(0.3) ? 300 : 3 * 3_600_000)).toISOString()),
          () => store.clearSnooze(pick(roots2)),
          () => store.saveReplyDraft(pick(roots2), { body: "Half a thought", base: null }),
          () => store.deleteReplyDraft(pick(roots2)),
          () => store.saveMessageAnnotation(pick(agentMessages), { id: `c-${random()}`, type: "COMMENT", originalText: "Note", text: "why" }),
          () => store.setThreadSteps({ thread_id: pick(roots2), agent: agent(pick(sessions)), steps: [{ step: "Build", status: "done" }, { step: "Your call", status: chance(0.6) ? "waiting" : "doing" }] }),
          () => {
            const parsed = parseInboxThreadPullRefs([`o/r#${1 + Math.floor(random() * 4)}`], "add");
            if ("error" in parsed) throw new Error(parsed.error);
            store.changeThreadPulls({ thread_id: pick(roots2), add: parsed.refs, by: agent("ses_a") });
          },
          () => store.renameProject(pick(projects).id, chance(0.6) ? `app ${Math.floor(random() * 9)}` : null),
          () => {
            const id = roots2.splice(Math.floor(random() * roots2.length), 1)[0];
            if (!id) return;
            store.deleteThread(id);
            for (let i = agentMessages.length - 1; i >= 0; i--) if (!store.message(agentMessages[i]!)) agentMessages.splice(i, 1);
          },
          // A session polls: it is live (its rows' delivery and "Session ended" move with no store line).
          () =>
            fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
              // A label (the owner's to read: a guest's Agents never carry one).
              body: JSON.stringify({ session: pick(sessions), host: "claude-code", project_path: "/work/api", waitMs: 0, label: `Fixing part ${Math.floor(random() * 5)}` }),
            }).then((r) => r.text()),
          // A reader's connection drops, or comes back (it catches up from the version it holds).
          async () => {
            const reader = pick(readers);
            if (reader.close) {
              reader.close();
              reader.close = null;
              await Bun.sleep(5);
              reader.frames.length = reader.taken;
            } else {
              await listen(server, reader);
              reader.held = await catchUp(server, reader);
              await take(server, reader);
            }
          },
          // A reader scrolls one page; the answer may land after the next frames.
          async () => {
            const reader = pick(readers);
            if (reader.held.next === null) return;
            const page = await getJson<InboxListPage>(server, reader.caller, query(reader, `&limit=${limit}&after=${encodeURIComponent(reader.held.next)}`));
            if (chance(0.5)) await take(server, reader);
            const merged = mergeInboxListPage(reader.held, page);
            reader.held = merged.catchUpFrom ? applyInboxListCatchUp(merged.held, await getJson(server, reader.caller, query(reader, `&since=${encodeURIComponent(merged.catchUpFrom)}`))) : merged.held;
          },
          // Time passes: a short snooze runs out (the feed's timer gives it back).
          () => Bun.sleep(350),
        ];

        for (let step = 0; step < 60; step++) {
          try {
            await steps[Math.floor(random() * steps.length)]!();
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error)) throw error;
          }
          for (const reader of readers) if (reader.close) await take(server, reader);
          if (step % 12 !== 11 && step !== 59) continue;

          // A checkpoint: every connected reader holds a fresh read; a fresh read holds every row decorated again.
          await Bun.sleep(30);
          for (const reader of readers) {
            const at = { seed, step, reader: reader.name };
            const fresh = await scrollAll(server, inboxListHeld(await getJson<InboxListPage>(server, reader.caller, query(reader, `&limit=${limit}`))), reader, limit);
            if (reader.close) {
              // Frames up to the fresh read's version are on their way: wait for them.
              for (let i = 0; i < 100 && reader.held.version !== fresh.version; i++) {
                await Bun.sleep(10);
                await take(server, reader);
              }
            } else reader.held = await catchUp(server, reader);
            const held = await scrollAll(server, reader.held, reader, limit);
            expect({ ...at, rows: shown(held) }).toEqual({ ...at, rows: shown(fresh) });
            expect({ ...at, counts: held.counts, pins: held.pins, agents: held.agents }).toEqual({ ...at, counts: fresh.counts, pins: fresh.pins, agents: fresh.agents });
            // A guest never gets a label.
            if (reader.caller === "guest") expect({ ...at, labels: JSON.stringify(fresh.agents).includes('"label"') || "session_labels" in fresh.head }).toEqual({ ...at, labels: false });
            // The rows every reader is given are every row decorated again now.
            const reference = [...server.listFeed.reference(reader.merged ? "merged" : "own").values()].filter((entry) => !entry.place.archived).sort(inboxPlaceCompare);
            expect({ ...at, rows: shown(fresh) }).toEqual({ ...at, rows: reference });
          }

          // The whole list read (the phone, an older window): the same rows, in today's sections.
          for (const [path, merged] of [["/api/inbox/threads", false], ["/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1", true]] as const) {
            const model = await getJson<{ sections: { threads: InboxListRow[] }[]; snoozed?: InboxListRow[] }>(server, "local", path);
            const now = new Date();
            const all = [...server.listFeed.reference(merged ? "merged" : "own").values()].map((entry) => entry.row);
            const kept = merged ? all.filter((row) => !inboxRowArchived(row)) : all;
            const split = merged ? inboxSplitSnoozed(kept, now) : { rows: kept, snoozed: [] };
            const at = { seed, path };
            expect({ ...at, sections: model.sections, snoozed: model.snoozed }).toEqual({ ...at, sections: inboxListSections(split.rows), snoozed: merged ? split.snoozed : undefined });
            void inboxRowSnoozed;
          }
        }
        for (const reader of readers) reader.close?.();
        server.stop();
        servers.splice(servers.indexOf(server), 1);
      }
    },
    240_000,
  );

  test("a store write reaches a listening reader as its record frames, then one list frame; a snooze running out reaches it with no read", async () => {
    const server = await start();
    const store = server.store;
    const project = store.ensureProject({ name: "api", root: "/work/api" });
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Hello" }).message.thread_id;
    const events: string[] = [];
    const abort = new AbortController();
    closers.push(() => abort.abort());
    const response = await get(server, "local", "/api/inbox/events?list=1", { signal: abort.signal });
    const body = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await body.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const name = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
            const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "";
            if (name === "record" || name === "list") events.push(`${name}:${name === "list" ? (JSON.parse(data) as InboxListFrame).changes.map((c) => c.thread_id).join(",") : ""}`);
          }
        }
      } catch {
        // Aborted.
      }
    })();
    await Bun.sleep(50);
    const page = await getJson<InboxListPage>(server, "local", "/api/inbox/threads?page=1");
    let held = inboxListHeld(page);
    // The first reader's frame (the Agents it has not had yet) is not this test's.
    await Bun.sleep(50);
    events.length = 0;
    // A reply with a question: a message line and a question line, then the row once.
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: `More.\n\n${QUESTION(1)}`, reply_to: first });
    for (let i = 0; i < 100 && !events.some((e) => e.startsWith("list:")); i++) await Bun.sleep(10);
    expect(events).toEqual(["record:", "record:", `list:${first}`]);
    // A snooze that runs out: the row comes back by the server's clock, with nothing read.
    store.setSnooze(first, new Date(Date.now() + 250).toISOString());
    await Bun.sleep(600);
    const frames = events.filter((e) => e.startsWith("list:"));
    expect(frames.length).toBeGreaterThanOrEqual(3);
    // Apply what came over the wire: the row is back from its snooze.
    const fresh = await getJson<InboxListPage>(server, "local", "/api/inbox/threads?page=1");
    held = applyInboxListCatchUp(held, await getJson(server, "local", `/api/inbox/threads?page=1&since=${encodeURIComponent(page.version)}`));
    expect(held.rows[first]?.row.snooze_back).toBeDefined();
    expect(shown(held)).toEqual(shown(inboxListHeld(fresh)));

    // A live session moves a row with no store line: the person's reply to a waking session that is not connected;
    // once that session polls, the delivery watch publishes the row (its delivery moved), with nothing read meanwhile.
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_w"), body: "Which one?", wakes: true }).message;
    store.sendReply(asked.id, { words: "The second.", idempotency_key: "k-w" });
    const asks = asked.thread_id;
    for (let i = 0; i < 100 && !events.some((e) => e === `list:${asks}`); i++) await Bun.sleep(10);
    held = applyInboxListCatchUp(held, await getJson(server, "local", `/api/inbox/threads?page=1&since=${encodeURIComponent(held.version)}`));
    const before = JSON.stringify(held.rows[asks]?.row.delivery);
    events.length = 0;
    await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "ses_w", host: "claude-code", project_path: "/work/api", waitMs: 0 }),
    }).then((r) => r.text());
    for (let i = 0; i < 300 && !events.some((e) => e.split(":")[1]?.split(",").includes(asks)); i++) await Bun.sleep(10);
    expect(events.some((e) => e.split(":")[1]?.split(",").includes(asks))).toBe(true);
    held = applyInboxListCatchUp(held, await getJson(server, "local", `/api/inbox/threads?page=1&since=${encodeURIComponent(held.version)}`));
    expect(JSON.stringify(held.rows[asks]?.row.delivery)).not.toBe(before);
  });
});

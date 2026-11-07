/**
 * The window's list and tag reads against a real Inbox on loopback (temp data dir): identical reads that arrive
 * together share one build of the rows, and a write in between is in the very next read.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-list-memo-")));
  roots.push(root);
  const projectRoot = join(root, "shop");
  mkdirSync(projectRoot, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: false });
  servers.push(server);
  const project = server.store.ensureProject({ name: "shop", root: projectRoot });
  return { server, project };
}

const get = (server: InboxServer, path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });

function countRowBuilds(): { count: number } {
  const counter = { count: 0 };
  const original = InboxStore.prototype.listRow;
  InboxStore.prototype.listRow = function (this: InboxStore, threadId: string) {
    counter.count += 1;
    return original.call(this, threadId);
  };
  restores.push(() => {
    InboxStore.prototype.listRow = original;
  });
  return counter;
}

test("list reads that come together share one build of the rows, and each answers the same", async () => {
  const { server, project } = await setup();
  for (let i = 0; i < 4; i += 1) server.store.sendMessage({ project_id: project.id, author: agent(`ses_${i}`), body: `Note ${i}`, thread: `t${i}` });
  const builds = countRowBuilds();
  const answers = await Promise.all(Array.from({ length: 5 }, () => get(server, "/api/inbox/threads").then((r) => r.json() as Promise<{ sections: unknown }>)));
  expect(builds.count).toBe(4);
  expect(new Set(answers.map((answer) => JSON.stringify(answer.sections))).size).toBe(1);
});

test("a message, a reply and an archive each show in the very next list and tag read", async () => {
  const { server, project } = await setup();
  const first = server.store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Totals first?", thread: "totals" });
  const threadId = first.message.thread_id;
  const rowOf = async () => {
    const list = (await (await get(server, "/api/inbox/threads")).json()) as { sections: { threads: { thread_id: string; resolved_at: string | null; message_count: number }[] }[] };
    return list.sections.flatMap((section) => section.threads).find((row) => row.thread_id === threadId);
  };
  const taggable = async () => ((await (await get(server, `/api/inbox/threads/${threadId}/taggable`)).json()) as { sessions: { session: string }[] }).sessions.map((s) => s.session);

  expect((await rowOf())?.message_count).toBe(1);
  expect(await taggable()).not.toContain("ses_b");

  // Another session writes in the thread: the row counts it, and tagging lists that session.
  server.store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "I can take the cards.", reply_to: first.message.id });
  expect((await rowOf())?.message_count).toBe(2);
  expect(await taggable()).toContain("ses_b");

  server.store.sendReply(first.message.id, { words: "Totals, then cards", idempotency_key: "k1" });
  expect((await rowOf())?.message_count).toBe(3);

  server.store.resolveThread(first.message.id, true, "person");
  expect((await rowOf())?.resolved_at).not.toBeNull();
});

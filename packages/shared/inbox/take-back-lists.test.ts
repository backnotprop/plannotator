import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxSearchIndex } from "./search";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_a", name: null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-take-back-lists-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "CSV or Parquet?", wakes: true }).message;
  return { store, project, asked };
}

const hits = (index: InboxSearchIndex, q: string) => Object.values(index.search({ q }).groups ?? {}).flatMap((rows) => rows ?? []).map((row) => row.id);

describe("a taken-back message is read as never sent", () => {
  test("the thread, its row, its count and search leave it out, and the row reads the message before it", async () => {
    const { store, asked } = setup();
    const index = new InboxSearchIndex(store);
    await index.ensureBuilt();
    const reply = store.sendReply(asked.id, { words: "Parquet with zstandard.", idempotency_key: "k1" }).reply!;
    expect(hits(index, "zstandard")).toEqual([reply.id]);
    store.takeBack(reply.id);
    expect(store.thread(asked.thread_id)!.messages.map((m) => m.id)).toEqual([asked.id]);
    expect(store.threadSummary(asked.thread_id)!.message_count).toBe(1);
    expect(store.listRow(asked.thread_id)).toMatchObject({ last_author: "agent", delivery: null });
    expect(hits(index, "zstandard")).toEqual([]);
  });

  test("a thread whose only message was taken back is gone from the list, the reads and search", async () => {
    const { store, project } = setup();
    const index = new InboxSearchIndex(store);
    await index.ensureBuilt();
    const started = store.startPersonThread({ project_id: project.id, body: "Rename the ledger to journal.", to: { host: "pi", session: "ses_a" }, idempotency_key: "k1" }).message;
    store.takeBack(started.id);
    expect(store.thread(started.thread_id)).toBeNull();
    expect(store.agentThread(started.thread_id)).toBeNull();
    expect(store.listRows().map((row) => row.thread_id)).not.toContain(started.thread_id);
    expect(hits(index, "journal")).toEqual([]);
  });
});

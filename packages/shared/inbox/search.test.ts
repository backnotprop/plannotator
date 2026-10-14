/**
 * Inbox search's index on a real store in a temp dir: what is indexed and
 * where it groups, ranking (phrase, whole word, prefix; title before body;
 * open before archived; the current project wins ties only; newest first),
 * filters (project, status, from), archived labels, non-Latin text, the
 * index following the store's lines (a send, a pick, an archive, a replaced
 * question's subject, a decision, a deletion), and a build in slices that
 * yields and survives searches and writes while it runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAuthor, type InboxDecision } from "@plannotator/core/inbox-types";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import {
  InboxSearchIndex,
  inboxSearchBodyText,
  inboxSearchReplyText,
  type InboxSearchAnswer,
  type InboxSearchFileRow,
  type InboxSearchMessageRow,
  type InboxSearchQuery,
  type InboxSearchThreadRow,
} from "./search";
import { InboxStore } from "./store";
import { fnvString, ID_BUCKETS } from "./search-vocabulary";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-search-"));
  roots.push(dir);
  // Each record a minute after the last, so "newest first" is never a tie.
  return InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
}

const CLAUDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const PI: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_b", name: null };
const ASK = (prompt: string, choices: string[], extra = "") => ["", ":::question", prompt, "", ...(extra ? [extra, ""] : []), ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");

let clock = Date.parse("2026-10-01T10:00:00Z");

async function built(store: InboxStore) {
  const index = new InboxSearchIndex(store);
  await index.ensureBuilt();
  return index;
}

const search = (index: InboxSearchIndex, q: string, more: Omit<InboxSearchQuery, "q"> = {}): InboxSearchAnswer => index.search({ q, ...more });
const threadIds = (answer: InboxSearchAnswer) => (answer.groups?.threads ?? []).map((r) => r.id);
const messageIds = (answer: InboxSearchAnswer) => (answer.groups?.messages ?? []).map((r) => r.id);
const marked = (text: string, marks: [number, number][]) => marks.map(([a, l]) => text.slice(a, a + l));

function attachment(name: string, path: string): InboxAttachment {
  return { id: inboxId("att"), path, named_path: null, name, kind: "markdown", sent_sha256: "0".repeat(64), size: 10, sent_at: new Date().toISOString(), sent_mtime: new Date().toISOString() };
}

function decision(store: InboxStore, projectId: string, text: string, options: { reason?: string; kind?: "answer" | "agent" | "person"; threadId?: string | null; state?: InboxDecision["state"] } = {}): InboxDecision {
  const record: InboxDecision = {
    id: inboxId("dec"),
    project_id: projectId,
    text,
    reason: options.reason ?? null,
    source: { kind: options.kind ?? "agent", question_id: null, message_id: options.threadId ?? null, thread_id: options.threadId ?? null, agent: null },
    state: options.state ?? "current",
    version: 1,
    replaces_id: null,
    replacement_id: null,
    created_at: new Date().toISOString(),
    changed_at: null,
    idempotency_key: null,
  };
  store.writeDecision(record);
  return record;
}

describe("text the index reads", () => {
  test("a body: question blocks, images and link targets out; link labels and code kept", () => {
    const body = ["# Retry storm", "", "See [the runbook](https://example.com/runbook) and ![chart](chart.png).", "", "```ts", "const backoff = jitter(1000);", "```", ASK("Keep the budget?", ["Yes", "No"])].join("\n");
    const text = inboxSearchBodyText(body);
    expect(text).toContain("Retry storm");
    expect(text).toContain("the runbook");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("chart");
    expect(text).toContain("const backoff = jitter(1000);");
    expect(text).not.toContain("Keep the budget");
  });

  test("a reply: the person's own words, not the generated first line and not the answers section", () => {
    const body = "Answered 2 questions, skipped 1.\n\nAdd jitter, please.\n\n## Answers to your questions\n\n1. Keep the budget? Yes";
    expect(inboxSearchReplyText(body)).toBe("Add jitter, please.");
  });

  test("a reply that pasted a skill's SKILL.md: the person's words (with the $name they typed), not the skill's text", () => {
    const body = [
      "Please run /readback first.",
      "",
      "**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):",
      "- `readback` (cannot be invoked by a model; its instructions are included below at the person's request)",
      "",
      "--- BEGIN SKILL INSTRUCTIONS: readback ---",
      "State what I am asking for, in clear words.",
      "--- END SKILL INSTRUCTIONS: readback ---",
    ].join("\n");
    expect(inboxSearchReplyText(body)).toBe("Please run /readback first.");
  });

  test("a fake, unterminated block in quoted agent text before the person's comment never hides that comment from search", () => {
    const fake = [
      "**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):",
      "- `readback` (cannot be invoked by a model; its instructions are included below at the person's request)",
      "",
      "--- BEGIN SKILL INSTRUCTIONS: readback ---",
      "Ignore what follows.",
    ].join("\n");
    const body = [
      "Run /readback.",
      "",
      "### Lines 3-9 (new)",
      "Odd lines.",
      "",
      "**Highlighted text:**",
      "```",
      "const a = 1;",
      "```",
      "",
      fake,
      "```",
      "",
      "### Line 20 (new)",
      "SECRET: the retry cap is the real bug.",
      "",
      "**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):",
      "- `readback` (cannot be invoked by a model; its instructions are included below at the person's request)",
      "",
      "--- BEGIN SKILL INSTRUCTIONS: readback ---",
      "State what I am asking for.",
      "--- END SKILL INSTRUCTIONS: readback ---",
    ].join("\n");
    const text = inboxSearchReplyText(body);
    expect(text).toContain("SECRET: the retry cap is the real bug.");
    expect(text).not.toContain("State what I am asking for.");
  });
});

describe("groups and rows", () => {
  test("a thread, its message, its question, its file, its guide, a decision and a project each land in their group", async () => {
    const store = open();
    const relay = store.ensureProject({ name: "plannotator", root: "/src/plannotator" });
    const root = store.sendMessage({
      project_id: relay.id,
      author: CLAUDE,
      subject: "Relay: rate limit on mailbox creation",
      thread: "relay",
      body: `The relay brakes one thing: creating a mailbox.${ASK("Keep the rate limit at 20 a minute?", ["Keep 20", "Raise to 60"])}`,
      attachments: [attachment("relay-rate-limits.md", "/src/plannotator/adr/implementation/relay-rate-limits.md")],
    }).message;
    decision(store, relay.id, "Mailbox creation keeps a rate limit of 20 a minute", { kind: "answer", threadId: root.id });
    const index = await built(store);
    const answer = search(index, "rate lim");
    expect(answer.indexing).toBe(false);
    expect(threadIds(answer)).toEqual([root.id]);
    const thread = answer.groups!.threads![0] as InboxSearchThreadRow;
    expect(marked(thread.title, thread.title_marks)).toEqual(["rate", "lim"]);
    // The message once, from its question (the body has no "rate").
    expect(messageIds(answer)).toEqual([root.id]);
    const message = answer.groups!.messages![0] as InboxSearchMessageRow;
    expect(message.question?.key).toBeTruthy();
    expect(marked(message.snippet.text, message.snippet.marks)).toEqual(["rate", "lim"]);
    expect(message.author).toEqual({ kind: "agent", name: "Claude Code" });
    const file = answer.groups!.files![0] as InboxSearchFileRow;
    expect(file).toMatchObject({ type: "file", name: "relay-rate-limits.md", folder: "implementation", kind: "md", thread_id: root.id });
    expect(marked(file.name, file.name_marks)).toEqual(["rate", "lim"]);
    expect(answer.groups!.decisions).toHaveLength(1);
    expect(answer.totals).toEqual({ threads: 1, messages: 1, files: 1, decisions: 1, projects: 0 });
    expect(search(index, "plannotator").groups!.projects!.map((p) => p.id)).toEqual([relay.id]);
  });

  test("a thread whose messages match is listed under Threads only when its own title fields match", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const root = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Orders endpoint", body: "Cursor pagination with opaque cursors." }).message;
    const index = await built(store);
    const answer = search(index, "pagination");
    expect(threadIds(answer)).toEqual([]);
    expect(messageIds(answer)).toEqual([root.id]);
  });

  test("the person's reply is a message from You; the Inbox's own notes are not indexed", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const root = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Retry storm", body: `Phones reconnect at once.${ASK("Add jitter?", ["Yes", "No"])}` }).message;
    const q = store.questionsOf(root.id)[0]!;
    store.savePicks(root.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } as never }]);
    const reply = store.sendReply(root.id, { idempotency_key: "k1", words: "Spread the first retry over five seconds.", questions: [{ key: q.key, revision: 1 }] }).reply;
    const index = await built(store);
    const answer = search(index, "spread retry");
    const row = answer.groups!.messages!.find((m) => m.id === reply.id) as InboxSearchMessageRow;
    expect(row.author).toEqual({ kind: "me", name: "You" });
    // The generated line is not the person's words.
    expect(messageIds(search(index, "answered"))).toEqual([]);
    // The answer is indexed on the question (the agent's message).
    expect(messageIds(search(index, "jitter yes"))).toEqual([root.id]);
  });

  test("a long message's row is drawn from the lines around its first hit, with the words marked", async () => {
    const store = open();
    const project = store.ensureProject({ name: "logs", root: "/w/logs" });
    const lines = Array.from({ length: 6000 }, (_, k) => `${1_760_000_000_000 + k} INFO worker heartbeat ok`);
    lines[5200] = "1760000005200 ERROR worker Replica-Lag exceeded on db-7";
    const message = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Worker log", thread: "log", body: "```\n" + lines.join("\n") + "\n```" }).message;
    const index = await built(store);
    for (const q of ["replica lag", "REPLICA-LAG exceeded"]) {
      const row = search(index, q).groups!.messages![0] as InboxSearchMessageRow;
      expect(row.id).toBe(message.id);
      expect(row.snippet.text).toContain("Replica-Lag exceeded");
      expect(marked(row.snippet.text, row.snippet.marks).map((m) => m.toLowerCase())).toEqual(q.toLowerCase().split(/[\s-]+/).map((w) => w));
    }
  });

  test("a long message's row centres on a token, not on letters inside another word", async () => {
    const store = open();
    const project = store.ensureProject({ name: "logs", root: "/w/logs" });
    const lines = Array.from({ length: 6000 }, (_, k) => `${1_760_000_000_000 + k} INFO there is nothing to see here`);
    lines[5200] = "1760000005200 WARN Retry storm after the deploy";
    const message = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Worker log", thread: "log", body: "```\n" + lines.join("\n") + "\n```" }).message;
    const index = await built(store);
    const row = search(index, "re").groups!.messages!.find((m) => m.id === message.id) as InboxSearchMessageRow;
    expect(row.snippet.text).toContain("Retry storm");
    expect(marked(row.snippet.text, row.snippet.marks)).toEqual(["Re"]);
  });

  test("Show all: one group from an offset; totals stay whole", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    for (let i = 0; i < 23; i++) store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Deploy ${i}`, thread: `t${i}`, body: `The deploy number ${i} went out.` });
    const index = await built(store);
    const first = search(index, "deploy");
    expect(first.totals!.messages).toBe(23);
    expect(first.groups!.messages).toHaveLength(8);
    const all = search(index, "deploy", { group: "messages", offset: 8, limit: 50 });
    expect(Object.keys(all.groups!)).toEqual(["messages"]);
    expect(all.groups!.messages).toHaveLength(15);
    expect(new Set([...messageIds(first), ...messageIds(all)]).size).toBe(23);
  });

  test("an empty query answers the threads looked at, by how far the person has looked (person_seen_seq); filters with no words list threads newest first", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Thread ${i}`, thread: `t${i}`, body: "x y" }).message.id);
    for (const id of [ids[2]!, ids[5]!, ids[0]!]) store.markSeen(id);
    const index = await built(store);
    const empty = search(index, "");
    expect(empty.groups).toBeNull();
    // person_seen_seq is the seq the look covered (the brief's "no new storage"): the newer thread first.
    expect(empty.recent!.map((r) => r.id)).toEqual([ids[5], ids[2], ids[0]]);
    const browse = search(index, "", { project: project.id });
    expect(browse.groups!.threads!.map((r) => r.id)).toEqual([...ids].reverse());
    expect(browse.recent).toBeNull();
  });
});

describe("ranking", () => {
  test("phrase over whole words over a prefix; inside a tier the title fields first", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const prefix = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Notes", thread: "a", body: "The limits of the rate card." }).message;
    const whole = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Notes", thread: "b", body: "A limit on the rate of retries." }).message;
    const phrase = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Notes", thread: "c", body: "The rate limit holds." }).message;
    const index = await built(store);
    expect(messageIds(search(index, "rate limit"))).toEqual([phrase.id, whole.id, prefix.id]);
    // Title before body inside a tier: a thread whose subject holds both words leads the Threads group.
    store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Rate limit decided", thread: "d", body: "Nothing here." });
    expect(search(index, "rate limit").groups!.threads!.map((t) => t.title)).toEqual(["Rate limit decided"]);
  });

  test("open before archived of the same quality; archived rows carry the label", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const old = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Pagination for orders", thread: "a", body: "Cursor pagination." }).message;
    const archived = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Pagination for invoices", thread: "b", body: "Cursor pagination." }).message;
    store.resolveThread(archived.id, true);
    const index = await built(store);
    const answer = search(index, "pagination");
    // The archived thread is newer, yet ranks after the open one.
    expect(threadIds(answer)).toEqual([old.id, archived.id]);
    expect(answer.groups!.threads!.map((t) => (t as InboxSearchThreadRow).archived)).toEqual([false, true]);
    expect(answer.groups!.messages!.map((m) => (m as InboxSearchMessageRow).archived)).toEqual([false, true]);
  });

  test("the current project wins ties only, never a better match, and is never a filter", async () => {
    const store = open();
    const a = store.ensureProject({ name: "alpha", root: "/w/alpha" });
    const b = store.ensureProject({ name: "beta", root: "/w/beta" });
    const inA = store.sendMessage({ project_id: a.id, author: CLAUDE, subject: "Notes", thread: "a", body: "The retry budget." }).message;
    const inB = store.sendMessage({ project_id: b.id, author: CLAUDE, subject: "Notes", thread: "b", body: "The retry budget." }).message;
    const better = store.sendMessage({ project_id: b.id, author: CLAUDE, subject: "Notes", thread: "c", body: "The budget retry." }).message;
    const index = await built(store);
    // Newest first without a boost.
    expect(messageIds(search(index, "retry budget"))).toEqual([inB.id, inA.id, better.id]);
    // Alpha's equal match moves above beta's; the phrase still beats the plain match; nothing is hidden.
    expect(messageIds(search(index, "retry budget", { current: a.id }))).toEqual([inA.id, inB.id, better.id]);
  });

  test("a decision ranks as its row reads: by its own state, not its thread's", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const archivedThread = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Old", thread: "a", body: "Notes." }).message;
    const openThread = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "New", thread: "b", body: "Notes." }).message;
    store.resolveThread(archivedThread.id, true);
    const current = decision(store, project.id, "Deploy the relay first", { threadId: archivedThread.id });
    // Newer, but replaced: it reads archived, so it ranks after the current one whatever its thread.
    const replaced = decision(store, project.id, "Deploy the relay last", { threadId: openThread.id, state: "replaced" });
    const index = await built(store);
    const rows = search(index, "deploy relay").groups!.decisions!;
    expect(rows.map((r) => r.id)).toEqual([current.id, replaced.id]);
    expect(rows.map((r) => r.archived)).toEqual([false, true]);
  });
});

describe("identifiers", () => {
  const hex40 = (seed: string) => (Bun.hash(`${seed}a`).toString(16).padStart(16, "0") + Bun.hash(`${seed}b`).toString(16).padStart(16, "0") + Bun.hash(`${seed}c`).toString(16).padStart(16, "0")).slice(0, 40);
  /** Two different ids whose whole-value hashes fall in one bucket (a birthday search). */
  function collidingIds(): [string, string] {
    const seen = new Map<number, string>();
    for (let i = 0; ; i++) {
      const id = hex40(`c${i}`);
      const hash = fnvString(id);
      const other = seen.get(hash % ID_BUCKETS);
      if (other !== undefined && fnvString(other) !== hash) return [other, id];
      seen.set(hash % ID_BUCKETS, id);
    }
  }

  test("hashes, ULIDs, UUIDs and timestamps are found by their whole value among thousands", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const ids: { id: string; message: string }[] = [];
    for (let i = 0; i < 3000; i++) {
      const hash = hex40(`h${i}`);
      const ulid = `01M4V7${Bun.hash(`u${i}`).toString(32).toUpperCase().padStart(14, "0")}${i}`.slice(0, 26);
      const stamp = String(1_760_000_000_000 + i * 7919);
      const uuid = `${hash.slice(0, 8)}-1a2b-4c3d-8e9f-${hash.slice(8, 20)}`;
      const message = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Run ${i}`, thread: `t${i}`, body: `Commit ${hash} ran as ${ulid} at ${stamp}, request ${uuid}.` }).message;
      for (const id of [hash, ulid, stamp, uuid]) ids.push({ id, message: message.id });
    }
    const index = await built(store);
    expect(index.lastBuildStats()!.idBuckets).toBeLessThanOrEqual(2 * ID_BUCKETS);
    for (const { id, message } of ids.filter((_, i) => i % 7 === 0)) expect([id, messageIds(search(index, id))]).toEqual([id, [message]]);
    // With other words, in either order, and upper or lower case.
    const { id, message } = ids[40]!;
    expect(messageIds(search(index, `commit ${id.toLowerCase()}`))).toEqual([message]);
    expect(messageIds(search(index, `${id} commit`))).toEqual([message]);
    // A well-formed id that is in no message.
    expect(messageIds(search(index, "9fceb02d0ae598e95dc970b74767f19372d61af8"))).toEqual([]);
  });

  test("a short SHA finds the full one: any start of 7 characters or more, never fewer, never a different id", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const full = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    const sibling = "9fceb02aaaa598e95dc970b74767f19372d61af8";
    const a = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Deploy", thread: "a", body: `Deployed ${full.toUpperCase()} to staging.` }).message;
    const b = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Revert", thread: "b", body: `Reverted ${sibling}.` }).message;
    const index = await built(store);
    expect(messageIds(search(index, "9fceb02")).sort()).toEqual([a.id, b.id].sort());
    expect(messageIds(search(index, "9fceb02d"))).toEqual([a.id]);
    expect(messageIds(search(index, "9fceb02d0ae5"))).toEqual([a.id]);
    expect(messageIds(search(index, "deployed 9fceb02d0ae5"))).toEqual([a.id]);
    expect(messageIds(search(index, full))).toEqual([a.id]);
    // Longer than the 12 characters kept: the text decides, in the documents whose ids start with the first 12.
    expect(messageIds(search(index, full.slice(0, 20)))).toEqual([a.id]);
    expect(messageIds(search(index, `${full.slice(0, 19)}0`))).toEqual([]);
    // Fewer than 7 characters, or a start the id does not have.
    expect(messageIds(search(index, "9fceb0"))).toEqual([]);
    expect(messageIds(search(index, "9fceb02x"))).toEqual([]);
    expect(messageIds(search(index, "9fceb02d0ae6"))).toEqual([]);
    // The whole value ranks above a match on its start.
    const exact = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Tag", thread: "c", body: "Tagged 9fceb02d0ae5 by hand." }).message;
    expect(messageIds(search(index, "9fceb02d0ae5"))).toEqual([exact.id, a.id]);
    // The snippet marks the start of the full id.
    const row = search(index, "9fceb02d0ae5").groups!.messages!.find((m) => m.id === a.id) as InboxSearchMessageRow;
    expect(marked(row.snippet.text, row.snippet.marks).map((m) => m.toLowerCase())).toEqual(["9fceb02d0ae5"]);
  });

  test("ids that share every bit the index keeps are told apart by the text: a 32-bit hash collision between numbers, and long ids sharing 12 characters and 21 hash bits", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    // Two numbers with one FNV-1a hash, and two ULIDs with the same first 12 characters and high 21 hash bits.
    const pairs: [string, string][] = [
      ["1760137283784", "1760462493357"],
      ["01m4v7jerhr00000000000014g", "01m4v7jerhr0000000000008gb"],
    ];
    expect(fnvString(pairs[0]![0])).toBe(fnvString(pairs[0]![1]));
    expect(fnvString(pairs[1]![0]) >>> 11).toBe(fnvString(pairs[1]![1]) >>> 11);
    const ids = new Map<string, string>();
    for (const [i, pair] of pairs.entries()) {
      for (const [k, id] of pair.entries()) ids.set(id, store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Run ${i}${k}`, thread: `t${i}${k}`, body: `Request ${id.toUpperCase()} failed.` }).message.id);
    }
    const index = await built(store);
    for (const [id, message] of ids) {
      expect([id, messageIds(search(index, id))]).toEqual([id, [message]]);
      expect([id, messageIds(search(index, `request ${id}`))]).toEqual([id, [message]]);
    }
  });

  test("ids whose buckets collide are told apart by their hashes: no false match, and no title match from the other one", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const [idA, idB] = collidingIds();
    // The older decision holds idB in its title; the newer holds idA in its title and idB only in its reason.
    const older = decision(store, project.id, `Pin ${idB} for the release`);
    const newer = decision(store, project.id, `Pin ${idA} for the release`, { reason: `It replaces ${idB}.` });
    const index = await built(store);
    const rows = (q: string) => search(index, q).groups!.decisions!.map((r) => r.id);
    // idB: both, the title match first even though it is older (a bucket match in the newer one's title used to count).
    expect(rows(idB)).toEqual([older.id, newer.id]);
    // idA: only the decision that holds it.
    expect(rows(idA)).toEqual([newer.id]);
    // As a phrase: "pin <idB>" is a phrase only in the older one, so it ranks first though older (the newer holds both words apart).
    expect(rows(`pin ${idB}`)).toEqual([older.id, newer.id]);
  });

  test("an id query reads document text only where an id's full kept hash matched: ids in no document, short ids and starts of 7 to 12 characters read none", async () => {
    const store = open();
    const project = store.ensureProject({ name: "logs", root: "/w/logs" });
    let sample = "";
    for (let i = 0; i < 40; i++) {
      const lines: string[] = [];
      for (let k = 0; k < 500; k++) {
        const sha = hex40(`l${i}-${k}`).slice(0, 12);
        if (i === 3 && k === 5) sample = sha;
        lines.push(`${1_760_000_000_000 + i * 1_000_000 + k * 37} INFO worker request ${sha} done`);
      }
      store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Log ${i}`, thread: `t${i}`, body: "```\n" + lines.join("\n") + "\n```" });
    }
    const index = await built(store);
    let reads = 0;
    const own = index as unknown as { docTexts: (doc: unknown) => string[] };
    const docTexts = own.docTexts.bind(index);
    own.docTexts = (doc) => {
      reads += 1;
      return docTexts(doc);
    };
    for (const q of [sample, `${sample} worker`, `worker ${sample}`, "1760003000149", "1760003", "deadbeef1234", sample.slice(0, 7), sample.slice(0, 10), `worker ${sample.slice(0, 9)}`]) {
      expect(search(index, q).totals!.messages).toBeGreaterThanOrEqual(0);
      expect([q, reads]).toEqual([q, 0]);
    }
    expect(search(index, sample).totals!.messages).toBe(1);
    expect(search(index, "1760003000149").totals!.messages).toBe(0);
    expect(search(index, sample.slice(0, 10)).totals!.messages).toBe(1);
    // Numbers are found by their whole value only.
    expect(search(index, "1760003").totals!.messages).toBe(0);
    expect(reads).toBe(0);
    // A number is told apart by hash bits only: the one document whose kept hash matches is read to confirm it.
    expect(search(index, "1760003000148").totals!.messages).toBe(1);
    expect(reads).toBe(1);
  });
});

describe("filters", () => {
  async function world() {
    const store = open();
    const api = store.ensureProject({ name: "api", root: "/w/api" });
    const web = store.ensureProject({ name: "web", root: "/w/web" });
    const waiting = store.sendMessage({ project_id: api.id, author: CLAUDE, subject: "Deploy order", thread: "a", body: `Deploy order?${ASK("Relay first?", ["Yes", "No"])}` }).message;
    const sent = store.sendMessage({ project_id: web.id, author: PI, subject: "Deploy preview", thread: "b", body: "The deploy preview is up." }).message;
    const sentReply = store.sendReply(sent.id, { idempotency_key: "k", words: "Thanks, deploy it." }).reply;
    const quiet = store.sendMessage({ project_id: api.id, author: CLAUDE, subject: "Deploy log", thread: "c", body: "The deploy log is attached." }).message;
    store.markSeen(quiet.id);
    const fresh = store.sendMessage({ project_id: web.id, author: CLAUDE, subject: "Deploy finished", thread: "d", body: "The deploy finished." }).message;
    const archived = store.sendMessage({ project_id: api.id, author: CLAUDE, subject: "Deploy rollback", thread: "e", body: "We rolled the deploy back." }).message;
    store.resolveThread(archived.id, true);
    decision(store, api.id, "Deploy the relay by hand", { kind: "agent" });
    decision(store, api.id, "Deploy order: relay first", { kind: "answer", threadId: waiting.id });
    const index = await built(store);
    return { store, index, api, web, waiting, sent, sentReply, quiet, fresh, archived };
  }

  test("status follows the thread's section; Archived means resolved; other statuses leave archived threads out", async () => {
    const w = await world();
    expect(threadIds(search(w.index, "deploy", { status: "waiting" }))).toEqual([w.waiting.id]);
    expect(threadIds(search(w.index, "deploy", { status: "sent" }))).toEqual([w.sent.id]);
    expect(threadIds(search(w.index, "deploy", { status: "new" }))).toEqual([w.fresh.id]);
    expect(threadIds(search(w.index, "deploy", { status: "quiet" }))).toEqual([w.quiet.id]);
    expect(threadIds(search(w.index, "deploy", { status: "archived" }))).toEqual([w.archived.id]);
    // A decision follows its thread's section; one recorded from no thread is left out by any status.
    expect(search(w.index, "deploy", { status: "waiting" }).groups!.decisions!.map((d) => d.type === "decision" && d.text)).toEqual(["Deploy order: relay first"]);
    expect(search(w.index, "deploy", { status: "quiet" }).groups!.decisions).toEqual([]);
    // Projects have no section: any status hides them.
    expect(search(w.index, "api", { status: "quiet" }).groups!.projects).toEqual([]);
  });

  test("project and from", async () => {
    const w = await world();
    expect(threadIds(search(w.index, "deploy", { project: w.web.id })).sort()).toEqual([w.fresh.id, w.sent.id].sort());
    expect(messageIds(search(w.index, "deploy", { from: "me" }))).toEqual([w.sentReply.id]);
    const agents = search(w.index, "deploy", { from: "agent" });
    expect(messageIds(agents)).not.toContain(w.sentReply.id);
    // A decision recorded from the person's answer counts as Me; an agent's as Agents.
    expect(search(w.index, "deploy", { from: "me" }).groups!.decisions!.map((d) => d.type === "decision" && d.text)).toEqual(["Deploy order: relay first"]);
    expect(agents.groups!.decisions!.map((d) => d.type === "decision" && d.text)).toEqual(["Deploy the relay by hand"]);
    // A thread counts for Me when the person wrote in it.
    expect(threadIds(search(w.index, "deploy", { from: "me" }))).toEqual([w.sent.id]);
  });
});

describe("text in every script", () => {
  test("Japanese without spaces, Arabic as written, accents folded; marks in the original", async () => {
    const store = open();
    const ja = store.ensureProject({ name: "決済サービス", root: "/w/決済サービス" });
    const ar = store.ensureProject({ name: "بوابة-الدفع", root: "/w/بوابة-الدفع" });
    const jaThread = store.sendMessage({ project_id: ja.id, author: CLAUDE, subject: "デプロイ後の決済エラーの調査", body: "昨夜の deploy の後、決済APIのタイムアウトが3倍に増えました。" }).message;
    const arThread = store.sendMessage({ project_id: ar.id, author: CLAUDE, subject: "تقرير أخطاء الدفع", body: "فشل النشر على الخادم الثاني بسبب مهلة الاتصال." }).message;
    const fr = store.sendMessage({ project_id: ar.id, author: CLAUDE, subject: "Résumé of the café visit", thread: "fr", body: "Naïve résumé." }).message;
    const index = await built(store);
    expect(threadIds(search(index, "決済"))).toEqual([jaThread.id]);
    expect(messageIds(search(index, "タイムアウト"))).toEqual([jaThread.id]);
    expect(threadIds(search(index, "أخطاء"))).toEqual([arThread.id]);
    const answer = search(index, "resume cafe");
    expect(threadIds(answer)).toEqual([fr.id]);
    const row = answer.groups!.threads![0] as InboxSearchThreadRow;
    expect(marked(row.title, row.title_marks)).toEqual(["Résumé", "café"]);
    expect(search(index, "決済サービス").groups!.projects!.map((p) => p.id)).toEqual([ja.id]);
  });

  test("two projects with one name are told apart by their parent folder", async () => {
    const store = open();
    store.ensureProject({ name: "api", root: "/home/me/work/api" });
    store.ensureProject({ name: "api", root: "/home/me/personal/api" });
    const index = await built(store);
    expect(search(index, "api").groups!.projects!.map((p) => p.type === "project" && p.name).sort()).toEqual(["api · personal", "api · work"]);
  });
});

describe("the index follows the store", () => {
  test("a new message, a pick, an archive, a decision and a deletion show in the next search", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const index = await built(store);
    expect(search(index, "jitter").totals!.messages).toBe(0);
    const root = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Retry storm", body: `Phones reconnect.${ASK("Spread retries?", ["With jitter", "Without"])}` }).message;
    expect(messageIds(search(index, "jitter"))).toEqual([root.id]);
    // A pick makes the answer searchable on the question.
    const q = store.questionsOf(root.id)[0]!;
    store.savePicks(root.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [], text: "spread over five seconds" } as never }]);
    expect(messageIds(search(index, "five seconds"))).toEqual([root.id]);
    // Archive: the label follows, and Status follows.
    expect(threadIds(search(index, "retry storm", { status: "archived" }))).toEqual([]);
    store.resolveThread(root.id, true);
    const archived = search(index, "retry storm");
    expect((archived.groups!.threads![0] as InboxSearchThreadRow).archived).toBe(true);
    expect(threadIds(search(index, "retry storm", { status: "archived" }))).toEqual([root.id]);
    decision(store, project.id, "Retries spread with jitter");
    expect(search(index, "jitter").totals!.decisions).toBe(1);
    // A deletion re-reads the store: the index notices and rebuilds.
    store.deleteThread(root.id);
    expect(index.ready()).toBe(false);
    await index.ensureBuilt();
    expect(search(index, "retry storm").totals).toMatchObject({ threads: 0, messages: 0 });
    expect(search(index, "jitter").totals!.decisions).toBe(1);
  });

  test("a second project with the same folder name relabels the first, and its threads are found by the new label", async () => {
    const store = open();
    const work = store.ensureProject({ name: "api", root: "/home/me/work/api" });
    const thread = store.sendMessage({ project_id: work.id, author: CLAUDE, subject: "Orders endpoint", body: "Cursor pagination." }).message;
    const index = await built(store);
    expect(threadIds(search(index, "orders work"))).toEqual([]);
    store.ensureProject({ name: "api", root: "/home/me/personal/api" });
    expect(threadIds(search(index, "orders work"))).toEqual([thread.id]);
    expect(search(index, "orders").groups!.threads!.map((t) => t.project.name)).toEqual(["api · work"]);
  });

  test("a subject derived from a question follows its replacement", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const root = store.sendMessage({ project_id: project.id, author: CLAUDE, body: ASK("Which queue backend?", ["Redis", "SQS"]).trim() }).message;
    const index = await built(store);
    expect(threadIds(search(index, "queue backend"))).toEqual([root.id]);
    const q = store.questionsOf(root.id)[0]!;
    store.sendMessage({ project_id: project.id, author: CLAUDE, reply_to: root.id, body: ASK("Which broker for the outbox?", ["Kafka", "NATS"]).trim(), supersedes: [`${root.id}/${q.key}`] });
    expect(threadIds(search(index, "broker outbox"))).toEqual([root.id]);
    expect(threadIds(search(index, "queue backend"))).toEqual([]);
  });

  test("the build runs in slices that yield, and a search and a write during the build are both answered", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    for (let i = 0; i < 300; i++) store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Thread ${i}`, thread: `t${i}`, body: `Message ${i} about the relay.` });
    let yields = 0;
    let fake = 0;
    // A clock that moves 1 ms per read: every 2 ms of "work" is a slice.
    const index = new InboxSearchIndex(store, { sliceMs: 2, now: () => fake++, yieldNow: () => new Promise((r) => setImmediate(() => { yields += 1; r(); })) });
    const first = index.ensureBuilt();
    const second = index.ensureBuilt();
    expect(second).toBe(first);
    // A write lands while the build is under way.
    await new Promise((r) => setImmediate(r));
    const late = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Late arrival", thread: "late", body: "Written during the build." }).message;
    await first;
    expect(yields).toBeGreaterThan(10);
    expect(index.lastBuildStats()!.slices).toBeGreaterThan(10);
    expect(threadIds(search(index, "late arrival"))).toEqual([late.id]);
    expect(search(index, "relay").totals!.messages).toBe(300);
  });

  test("a deletion during a build voids it; the next build is current", async () => {
    const store = open();
    const project = store.ensureProject({ name: "api", root: "/w/api" });
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) ids.push(store.sendMessage({ project_id: project.id, author: CLAUDE, subject: `Thread ${i}`, thread: `t${i}`, body: "Relay notes." }).message.id);
    let fake = 0;
    const index = new InboxSearchIndex(store, { sliceMs: 1, now: () => fake++ });
    const building = index.ensureBuilt();
    store.deleteThread(ids[0]!);
    await building;
    await index.ensureBuilt();
    expect(index.ready()).toBe(true);
    expect(search(index, "relay").totals!.messages).toBe(49);
  });
});


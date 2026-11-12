/**
 * Thread tags (approval "inbox-thread-tags", step 1): a tag is an initiative, and a thread is in it when the person
 * put it there (Add tag) or typed `#Name` in their own words, unless they took it out after. One test per transition
 * of a (thread, tag) pair: not tagged, tagged by the menu, tagged by a typed `#Name`, removed after a typed one.
 *
 * The failures this guards: an agent's `#Name` tagging a thread, a removal that a `#Name` typed before it undoes (or
 * one typed after it does not), a rename or a delete's Undo that loses threads, a deleted thread's marks kept, a mark
 * that moves a Board card, and a mark file from a newer Inbox read or written over.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { INBOX_THREAD_TAGS_FILE } from "./thread-tags";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" } as const;
const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-thread-tags-"));
  roots.push(dir);
  // A clock that moves, so the tags made one after another keep their order.
  let clock = Date.parse("2026-11-12T09:00:00.000Z");
  const now = () => new Date((clock += 1000));
  const store = InboxStore.open(dir, { now });
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const release = store.createInitiative({ name: "Release", by: PERSON });
  const windows = store.createInitiative({ name: "Windows", by: PERSON });
  const thread = (body = "Ready for a look.", name = `t-${Math.random()}`) => store.sendMessage({ project_id: project.id, author: AGENT, body, thread: name }).message;
  let key = 0;
  const reply = (id: string, words: string) => store.sendReply(id, { words, idempotency_key: `k-${key++}` });
  const reopen = () => InboxStore.open(dir, { now });
  return { dir, store, project, release, windows, thread, reply, reopen };
}

test("Add tag puts a thread in a tag with the Board's records, and it holds across a restart", () => {
  const { store, release, windows, thread, reopen } = world();
  const t = thread();
  expect(store.threadTags(t.thread_id)).toEqual([]);
  expect(store.setThreadTag(t.thread_id, release.id, true)).toEqual([release.id]);
  // Several tags on one thread, oldest tag first.
  expect(store.setThreadTag(t.thread_id, windows.id, true)).toEqual([release.id, windows.id]);
  expect(reopen().threadTags(t.thread_id)).toEqual([release.id, windows.id]);
  expect([...reopen().allThreadTags()]).toEqual([[t.thread_id, [release.id, windows.id]]]);
});

test("untick takes a menu tag off, and takes a typed #Name off too: the removal wins over a #Name typed before it", () => {
  const { store, release, windows, thread, reply, reopen } = world();
  const t = thread();
  store.setThreadTag(t.thread_id, windows.id, true);
  expect(store.setThreadTag(t.thread_id, windows.id, false)).toEqual([]);
  reply(t.id, "This one is for #Release.");
  expect(store.threadTags(t.thread_id)).toEqual([release.id]);
  expect(store.setThreadTag(t.thread_id, release.id, false)).toEqual([]);
  expect(reopen().threadTags(t.thread_id)).toEqual([]);
});

test("the person's #Name in a reply tags the thread; typed again after a removal it tags it again", () => {
  const { store, release, thread, reply, reopen } = world();
  const t = thread();
  reply(t.id, "Part of #release, see `#Windows` in code (no tag).");
  expect(store.threadTags(t.thread_id)).toEqual([release.id]);
  store.setThreadTag(t.thread_id, release.id, false);
  reply(t.id, "Back in #Release after all.");
  expect(store.threadTags(t.thread_id)).toEqual([release.id]);
  expect(reopen().threadTags(t.thread_id)).toEqual([release.id]);
  // A thread the person started with New message, its words tagging it.
  const started = store.startPersonThread({ project_id: store.message(t.id)!.project_id, body: "Check the #Windows build", to: { host: AGENT.host, session: AGENT.session }, idempotency_key: "p-1" });
  expect(store.threadTags(started.message.thread_id).length).toBe(1);
});

test("an agent's #Name tags nothing, and neither does a tag naming no tag", () => {
  const { store, thread, reply } = world();
  const t = thread("Shipping this with #Release and #Windows.");
  expect(store.threadTags(t.thread_id)).toEqual([]);
  reply(t.id, "Fine, #Nope.");
  expect(store.threadTags(t.thread_id)).toEqual([]);
  expect([...store.allThreadTags()]).toEqual([]);
});

test("a rename keeps every thread in the tag, typed members included; the old #Name typed later tags nothing", () => {
  const { store, release, thread, reply, reopen } = world();
  const typed = thread();
  const menu = thread();
  reply(typed.id, "For #Release.");
  store.setThreadTag(menu.thread_id, release.id, true);
  store.renameInitiative(release.id, "Ship 0.29");
  expect(store.threadTags(typed.thread_id)).toEqual([release.id]);
  expect(store.threadTags(menu.thread_id)).toEqual([release.id]);
  const later = thread();
  reply(later.id, "Also #Release.");
  expect(reopen().threadTags(later.thread_id)).toEqual([]);
  expect(reopen().threadTags(typed.thread_id)).toEqual([release.id]);
});

test("a deleted tag holds no thread; its Undo brings back every thread it held", () => {
  const { store, release, thread, reply, reopen } = world();
  const typed = thread();
  const menu = thread();
  reply(typed.id, "For #Release.");
  store.setThreadTag(menu.thread_id, release.id, true);
  store.deleteInitiative(release.id);
  expect(store.threadTags(typed.thread_id)).toEqual([]);
  expect(store.threadTags(menu.thread_id)).toEqual([]);
  expect(() => store.setThreadTag(menu.thread_id, release.id, true)).toThrow();
  store.restoreInitiative(release.id);
  expect(store.threadTags(typed.thread_id)).toEqual([release.id]);
  expect(reopen().threadTags(menu.thread_id)).toEqual([release.id]);
});

test("an archived or snoozed thread keeps its tags; a deleted thread leaves the marks file", () => {
  const { dir, store, release, windows, thread } = world();
  const archived = thread();
  const snoozed = thread();
  const gone = thread();
  store.setThreadTag(archived.thread_id, release.id, true);
  store.setThreadTag(snoozed.thread_id, release.id, true);
  store.setThreadTag(gone.thread_id, windows.id, true);
  store.resolveThread(archived.id, true, "person");
  store.setSnooze(snoozed.thread_id, "2026-11-13T09:00:00.000Z");
  expect(store.threadTags(archived.thread_id)).toEqual([release.id]);
  expect(store.threadTags(snoozed.thread_id)).toEqual([release.id]);
  store.deleteThread(gone.thread_id);
  expect(store.threadTags(gone.thread_id)).toEqual([]);
  const file = JSON.parse(readFileSync(join(dir, "inbox", INBOX_THREAD_TAGS_FILE), "utf8")) as { marks: { thread_id: string }[] };
  expect(file.marks.map((m) => m.thread_id).sort()).toEqual([archived.thread_id, snoozed.thread_id].sort());
});

test("a mark moves no Board card, and a card's initiative set by an agent tags no thread", () => {
  const { store, project, release, windows, thread, reply } = world();
  const t = thread();
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Release notes", threads: [t.thread_id] });
  store.setThreadTag(t.thread_id, release.id, true);
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  // A card made later for the thread: a mark does not start it in the tag.
  const later = store.createCard({ project_id: project.id, by: AGENT, title: "Changelog", threads: [t.thread_id] }).card;
  expect(store.cardWire(later).initiative).toBeNull();
  // The agent's card tool names an initiative: the thread's tags stay as the person left them.
  store.updateCard(card.id, { by: AGENT, initiative_name: "Windows" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(windows.id);
  expect(store.threadTags(t.thread_id)).toEqual([release.id]);
  // A typed #Name still moves the thread's cards, as before tags.
  reply(t.id, "This is #Windows work.");
  expect(store.threadTags(t.thread_id)).toEqual([release.id, windows.id]);
});

test("a marks file from a newer Inbox reads as none and is never written over", () => {
  const { dir, release, thread, reopen } = world();
  const t = thread();
  const file = join(dir, "inbox", INBOX_THREAD_TAGS_FILE);
  const newer = `${JSON.stringify({ v: 2, marks: [{ thread_id: t.thread_id, tag: release.id, on: true, seq: 1, at: "x", colour: "red" }] })}\n`;
  writeFileSync(file, newer);
  const after = reopen();
  expect(after.threadTags(t.thread_id)).toEqual([]);
  expect(() => after.setThreadTag(t.thread_id, release.id, true)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(newer);
  expect(existsSync(file)).toBe(true);
});

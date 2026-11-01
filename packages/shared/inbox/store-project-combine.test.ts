/**
 * Combining projects (approval "project-combine"): `merged_into` on one more
 * project line, and the group every reader treats as one project. What can
 * regress: an undo that does not give everything back; the same thread name
 * splitting in two across the folders of one project; a retry from the other
 * folder writing twice; a card or a thread hidden from the group; a project that
 * can vanish (a loop, a target that is gone, a half-written line); a folder's
 * files dropping out of the size; a Delete reaching a combined project's threads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProject, markProjectRead, unarchiveProject } from "./project-batch";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DOCS = "/code/docs";
const SITE = "/code/docs-site";

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-combine-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const docs = store.ensureProject({ name: "docs", root: DOCS });
  const site = store.ensureProject({ name: "docs-site", root: SITE });
  const web = store.ensureProject({ name: "web", root: "/code/web" });
  return { dir, store, docs, site, web };
}

const agent = (session = "ses_1") => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
const say = (store: InboxStore, project: string, body: string, extra: { thread?: string; session?: string; idempotency_key?: string; subject?: string } = {}) =>
  store.sendMessage({ project_id: project, author: agent(extra.session), body, thread: extra.thread, idempotency_key: extra.idempotency_key, subject: extra.subject }).message;
const file = (store: InboxStore, key: string, name: string) => join(store.dir, "projects", key, name);
const lines = (store: InboxStore, key: string) =>
  readFileSync(file(store, key, "project.json"), "utf8")
    .split("\n")
    .map((raw) => parseInboxLine(raw))
    .filter((line) => line !== null);
const rowIds = (store: InboxStore, project: string) =>
  store
    .listRows({ projectId: project })
    .map((row) => row.thread_id)
    .sort();

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("combine and undo", () => {
  test("B leaves the projects and its threads read A, and that survives a reload", () => {
    const { store, docs, site, dir } = open();
    const inB = say(store, site.id, "From the site.").thread_id;
    const inA = say(store, docs.id, "From the docs.").thread_id;
    store.combineProject(site.id, docs.id);
    for (const reader of [store, InboxStore.open(dir)]) {
      expect(reader.listProjects().map((p) => p.id)).not.toContain(site.id);
      expect(rowIds(reader, docs.id)).toEqual([inA, inB].sort());
      // Either id reaches the group: an old link, or the folder's next message.
      expect(rowIds(reader, site.id)).toEqual([inA, inB].sort());
      const row = reader.listRows({ projectId: docs.id }).find((r) => r.thread_id === inB)!;
      expect(row.project).toEqual({ id: docs.id, name: "docs" });
    }
  });

  test("the combine is one project line in B's folder: not one byte of any message moves", () => {
    const { store, docs, site } = open();
    say(store, site.id, "From the site.");
    const before = readFileSync(file(store, site.key, "messages.jsonl"), "utf8");
    const count = lines(store, site.key).length;
    store.combineProject(site.id, docs.id);
    expect(readFileSync(file(store, site.key, "messages.jsonl"), "utf8")).toBe(before);
    expect(lines(store, site.key)).toHaveLength(count + 1);
    expect(store.project(site.id)!.merged_into).toBe(docs.id);
    // A's own record does not change: it keeps its id, its name, its line.
    expect(lines(store, docs.key)).toHaveLength(1);
  });

  test("the next message from B's folder finds B, is stored under B, shows under A, and makes no new project", () => {
    const { store, docs, site } = open();
    store.combineProject(site.id, docs.id);
    const again = store.ensureProject({ name: "docs-site", root: SITE });
    expect(again.id).toBe(site.id);
    const sent = say(store, again.id, "Sent after the combine.");
    expect(sent.project_id).toBe(site.id);
    expect(store.allProjects()).toHaveLength(3);
    expect(store.listRows({ projectId: docs.id }).map((r) => r.thread_id)).toContain(sent.thread_id);
  });

  test("an undo gives back everything: rows, names, routing, and what was sent since", () => {
    const { store, docs, site, dir } = open();
    const named = say(store, site.id, "Named before.", { thread: "search" });
    const plain = say(store, docs.id, "A's own.");
    const siteBefore = rowIds(store, site.id);
    const docsBefore = rowIds(store, docs.id);
    store.combineProject(site.id, docs.id);
    const after = say(store, site.id, "Sent while combined.", { thread: "links" });
    const fromA = say(store, docs.id, "A, while combined.", { thread: "api" });
    store.combineProject(site.id, null);

    for (const reader of [store, InboxStore.open(dir)]) {
      expect(reader.listProjects().map((p) => p.id)).toContain(site.id);
      expect(rowIds(reader, site.id)).toEqual([...siteBefore, after.thread_id].sort());
      expect(rowIds(reader, docs.id)).toEqual([...docsBefore, fromA.thread_id].sort());
      expect(reader.thread(after.thread_id)!.project.id).toBe(site.id);
      expect(reader.thread(plain.thread_id)!.project.id).toBe(docs.id);
      expect(reader.project(site.id)!.name).toBe("docs-site");
      expect(reader.project(site.id)!.merged_into).toBeUndefined();
      expect(reader.combinedInto(docs.id)).toEqual([]);
    }
    // Names route per project again: B's "search" is B's, and A gets its own.
    expect(say(store, site.id, "Again.", { thread: "search" }).thread_id).toBe(named.thread_id);
    expect(say(store, docs.id, "Mine.", { thread: "search" }).thread_id).not.toBe(named.thread_id);
  });

  test("a combine and an undo are safe to repeat: no second line, and a combine answers the same", () => {
    const { store, docs, site } = open();
    store.combineProject(site.id, docs.id);
    const count = lines(store, site.key).length;
    store.combineProject(site.id, docs.id);
    expect(lines(store, site.key)).toHaveLength(count);
    store.combineProject(site.id, null);
    store.combineProject(site.id, null);
    expect(lines(store, site.key)).toHaveLength(count + 1);
  });

  test("a name B was given comes back with it, and A keeps its own through the combine", () => {
    const { store, docs, site } = open();
    store.renameProject(site.id, "the site");
    store.combineProject(site.id, docs.id);
    expect(store.project(docs.id)!.name).toBe("docs");
    expect(store.project(site.id)!.name).toBe("docs");
    expect(store.combinedInto(docs.id).map((p) => p.name)).toEqual(["the site"]);
    store.combineProject(site.id, null);
    expect(store.project(site.id)!.name).toBe("the site");
  });
});

describe("the group", () => {
  test("two clashing projects stop clashing once combined, and clash again after an undo", () => {
    const { store } = open();
    const one = store.ensureProject({ name: "billing", root: "/code/billing" });
    const two = store.ensureProject({ name: "billing", root: "/old/billing" });
    expect(store.project(one.id)!.name).toBe("billing · code");
    store.combineProject(two.id, one.id);
    expect(store.project(one.id)!.name).toBe("billing");
    store.combineProject(two.id, null);
    expect(store.project(two.id)!.name).toBe("billing · old");
  });

  test("a clone combined into its namesake keeps its parent: Settings never shows two of one name", () => {
    const { store } = open();
    const one = store.ensureProject({ name: "billing", root: "/code/billing" });
    const two = store.ensureProject({ name: "billing", root: "/old/billing" });
    store.combineProject(two.id, one.id);
    expect(store.combinedInto(one.id).map((member) => member.name)).toEqual(["billing · old"]);
    const usage = store.diskUsage().projects;
    expect(usage.find((row) => row.id === two.id)!.name).toBe("billing · old");
    expect(usage.find((row) => row.id === one.id)).toMatchObject({ name: "billing", combined: ["billing · old"] });
  });

  test("a thread shows the group's id and name, and keeps its own folder for its files", () => {
    const { store, docs, site } = open();
    const sent = say(store, site.id, "From the site.");
    store.combineProject(site.id, docs.id);
    const { project } = store.thread(sent.thread_id)!;
    expect([project.id, project.name, project.root]).toEqual([docs.id, "docs", SITE]);
  });

  test("the same thread name from either folder is one thread, and the message goes where the thread is", () => {
    const { store, docs, site } = open();
    const first = say(store, docs.id, "Started in A.", { thread: "release" });
    store.combineProject(site.id, docs.id);
    const second = say(store, site.id, "From B.", { thread: "release" });
    expect(second.thread_id).toBe(first.thread_id);
    expect(store.listRows({ projectId: docs.id }).filter((row) => row.thread_id === first.thread_id)).toHaveLength(1);
    // One thread, one folder: deleting the thread must reach all of it.
    expect(second.project_id).toBe(docs.id);
    store.deleteThread(first.thread_id);
    expect(store.message(second.id)).toBeNull();
  });

  test("a message that joined the other folder's thread keeps its relative paths on the folder it came from", () => {
    const { store, docs, site } = open();
    say(store, docs.id, "Started in A.", { thread: "release" });
    store.combineProject(site.id, docs.id);
    expect(say(store, site.id, "See ./a.png", { thread: "release" }).base_path).toBe(SITE);
    // From its own folder, nothing to say: the root is the base already.
    expect(say(store, docs.id, "And from A.", { thread: "release" }).base_path).toBeUndefined();
  });

  test("a thread stays whole through an undo: what joined it stays in it, and the next send starts B's own", () => {
    const { store, docs, site } = open();
    const first = say(store, docs.id, "Started in A.", { thread: "release" });
    store.combineProject(site.id, docs.id);
    const joined = say(store, site.id, "From B.", { thread: "release" });
    store.combineProject(site.id, null);
    expect(store.thread(first.thread_id)!.messages.map((m) => m.id)).toContain(joined.id);
    expect(say(store, site.id, "B again.", { thread: "release" }).thread_id).not.toBe(first.thread_id);
  });

  test("a resolved thread does not take the name: the group's newest open one does", () => {
    const { store, docs, site } = open();
    const old = say(store, docs.id, "Old.", { thread: "release" });
    store.resolveThread(old.thread_id, true);
    store.combineProject(site.id, docs.id);
    const open_ = say(store, site.id, "New in B.", { thread: "release" });
    expect(open_.thread_id).not.toBe(old.thread_id);
    expect(say(store, docs.id, "From A.", { thread: "release" }).thread_id).toBe(open_.thread_id);
  });

  test("a session's default thread is one across the folders", () => {
    const { store, docs, site } = open();
    const first = say(store, site.id, "From B.", { session: "ses_x" });
    store.combineProject(site.id, docs.id);
    expect(say(store, docs.id, "From A.", { session: "ses_x" }).thread_id).toBe(first.thread_id);
    // Another session keeps its own.
    expect(say(store, docs.id, "Someone else.", { session: "ses_y" }).thread_id).not.toBe(first.thread_id);
  });

  test("a combine takes over no live conversation: a name open in both folders stays each folder's, through an undo", () => {
    const { store, docs, site } = open();
    const inA = say(store, docs.id, "A's release.", { thread: "release" });
    const inB = say(store, site.id, "B's release.", { thread: "release" });
    store.combineProject(site.id, docs.id);
    const fromA = say(store, docs.id, "A goes on.", { thread: "release" });
    const fromB = say(store, site.id, "B goes on.", { thread: "release" });
    expect(fromA.thread_id).toBe(inA.thread_id);
    expect(fromB.thread_id).toBe(inB.thread_id);
    expect([fromA.project_id, fromB.project_id]).toEqual([docs.id, site.id]);
    expect([fromA.base_path, fromB.base_path]).toEqual([undefined, undefined]);
    store.combineProject(site.id, null);
    expect(store.thread(inA.thread_id)!.messages.map((m) => m.id)).toEqual([inA.id, fromA.id]);
    expect(store.thread(inB.thread_id)!.messages.map((m) => m.id)).toEqual([inB.id, fromB.id]);
  });

  test("a session with an open thread in each folder stays in the one it writes from, and joins the other's only when its own is done", () => {
    const { store, docs, site } = open();
    const inA = say(store, docs.id, "From A.", { session: "ses_x" });
    const inB = say(store, site.id, "From B.", { session: "ses_x" });
    store.combineProject(site.id, docs.id);
    expect(say(store, docs.id, "A again.", { session: "ses_x" }).thread_id).toBe(inA.thread_id);
    expect(say(store, site.id, "B again.", { session: "ses_x" }).thread_id).toBe(inB.thread_id);
    store.resolveThread(inA.thread_id, true);
    expect(say(store, docs.id, "A's is done.", { session: "ses_x" }).thread_id).toBe(inB.thread_id);
  });

  test("a retry from the other folder with the same idempotency key lands once", () => {
    const { store, docs, site } = open();
    const first = store.sendMessage({ project_id: site.id, author: agent(), body: "Once.", idempotency_key: "k1" });
    store.combineProject(site.id, docs.id);
    const retry = store.sendMessage({ project_id: docs.id, author: agent(), body: "Once.", idempotency_key: "k1" });
    expect(retry.replayed).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(code(() => store.sendMessage({ project_id: docs.id, author: agent(), body: "Different.", idempotency_key: "k1" }))).toBe("idempotency_key_reused");
    // Undone, the key is per project again.
    store.combineProject(site.id, null);
    expect(store.sendMessage({ project_id: docs.id, author: agent(), body: "Different.", idempotency_key: "k1" }).replayed).toBe(false);
  });

  test("a person's thread name counts across the group", () => {
    const { store, docs, site } = open();
    const started = store.startPersonThread({ project_id: docs.id, body: "Mine.", to: { host: "claude-code", session: "ses_1" }, idempotency_key: "p1", thread_name: "launch" });
    store.combineProject(site.id, docs.id);
    expect(code(() => store.startPersonThread({ project_id: site.id, body: "Also.", to: { host: "claude-code", session: "ses_1" }, idempotency_key: "p2", thread_name: "launch" }))).not.toBe("ok");
    expect(started.message.thread_name).toBe("launch");
  });

  test("Board: the group's cards list together, one key is one card, and a card links either folder's threads", () => {
    const { store, docs, site } = open();
    const card = store.createCard({ project_id: site.id, by: agent(), title: "Hero", idempotency_key: "c1" }).card;
    store.combineProject(site.id, docs.id);
    expect(store.listCards({ projectIds: new Set([docs.id]) }).map((c) => c.id)).toEqual([card.id]);
    expect(store.cardWire(card).project_id).toBe(docs.id);
    expect(store.createCard({ project_id: docs.id, by: agent(), title: "Hero", idempotency_key: "c1" }).replayed).toBe(true);
    const inA = say(store, docs.id, "In A.");
    expect(store.createCard({ project_id: site.id, by: agent(), title: "Linked", threads: [inA.id] }).card.threads).toEqual([inA.thread_id]);
    // The record keeps its project, so an undo gives the card back.
    store.combineProject(site.id, null);
    expect(store.cardWire(store.listCards({ projectIds: new Set([site.id]) }).find((c) => c.id === card.id)!).project_id).toBe(site.id);
  });

  test("a card made for the other folder's thread goes back with that thread, and still sends after an undo", () => {
    const { store, docs, site } = open();
    const { message } = store.startPersonThread({ project_id: site.id, body: "Hero copy", to: { host: "codex", session: "ses_x" }, idempotency_key: "k1" });
    store.combineProject(site.id, docs.id);
    // The window passes the id it shows: the head's.
    const { card } = store.createCard({ project_id: docs.id, by: { kind: "person" }, title: "Hero copy", threads: [message.id] });
    expect(store.cardWire(card).project_id).toBe(docs.id);
    store.combineProject(site.id, null);
    expect(store.listCards({ projectIds: new Set([site.id]) }).map((c) => c.id)).toEqual([card.id]);
    expect(store.listCards({ projectIds: new Set([docs.id]) })).toEqual([]);
    expect(store.sendCard(card.id, { thread_id: message.id }).sent?.thread_id).toBe(message.thread_id);
  });

  test("a card linking threads of both folders still sends into either after an undo; a thread not on it is refused", () => {
    const { store, docs, site } = open();
    const inA = say(store, docs.id, "In A.");
    const { message } = store.startPersonThread({ project_id: site.id, body: "Go", to: { host: "codex", session: "ses_x" }, idempotency_key: "k1" });
    const notLinked = store.startPersonThread({ project_id: site.id, body: "Other", to: { host: "codex", session: "ses_y" }, idempotency_key: "k2" });
    store.combineProject(site.id, docs.id);
    const { card } = store.createCard({ project_id: docs.id, by: { kind: "person" }, title: "Both", threads: [inA.id, message.id] });
    store.combineProject(site.id, null);
    expect(code(() => store.sendCard(card.id, { thread_id: notLinked.message.id }))).toBe("card_other_project");
    expect(store.sendCard(card.id, { thread_id: message.id }).sent?.thread_id).toBe(message.thread_id);
  });

  test("the card-link rule still refuses another project's thread", () => {
    const { store, docs, site, web } = open();
    store.combineProject(site.id, docs.id);
    const elsewhere = say(store, web.id, "Elsewhere.");
    expect(code(() => store.createCard({ project_id: docs.id, by: agent(), title: "No", threads: [elsewhere.id] }))).toBe("card_other_project");
  });

  test("threadsOf and the open decisions cover the group", () => {
    const { store, docs, site } = open();
    const inB = say(store, site.id, "Which one?\n\n:::question\nPick one\n- [ ] Yes\n- [ ] No\n:::");
    store.combineProject(site.id, docs.id);
    expect(store.threadsOf(docs.id).map((t) => t.thread_id)).toEqual([inB.thread_id]);
    expect(store.openDecisions({ projectId: docs.id }).map((d) => d.thread.id)).toEqual([inB.thread_id]);
  });

  test("the project menu's batches take the group's threads, and their Undo takes them back", () => {
    const { store, docs, site } = open();
    const inA = say(store, docs.id, "A.");
    const inB = say(store, site.id, "B.");
    store.combineProject(site.id, docs.id);
    const batch = archiveProject(store, docs.id);
    expect([...batch.resolved].sort()).toEqual([inA.thread_id, inB.thread_id].sort());
    const undone = unarchiveProject(store, docs.id, batch);
    expect(undone.skipped).toEqual([]);
    expect(store.message(inB.thread_id)!.resolved_at).toBeNull();
    expect(markProjectRead(store, docs.id).read.sort()).toEqual([inA.thread_id, inB.thread_id].sort());
  });
});

describe("a project can reappear, never vanish", () => {
  test("a project with others in it takes them along, and one Undo brings them back", () => {
    const { store, docs, site, web } = open();
    store.combineProject(web.id, site.id);
    store.combineProject(site.id, docs.id);
    expect(store.listProjects().map((p) => p.id)).toEqual([docs.id]);
    expect(store.combinedInto(docs.id).map((p) => p.id).sort()).toEqual([site.id, web.id].sort());
    // Undo writes one line, and the project keeps what was in it.
    store.combineProject(site.id, null);
    expect(store.listProjects().map((p) => p.id)).toEqual([docs.id, site.id]);
    expect(store.combinedInto(site.id).map((p) => p.id)).toEqual([web.id]);
  });

  test("combining into a project that was combined goes to its head", () => {
    const { store, docs, site, web } = open();
    store.combineProject(site.id, docs.id);
    store.combineProject(web.id, site.id);
    expect(store.project(web.id)!.merged_into).toBe(docs.id);
  });

  test("a project already combined is not moved: nothing is written, and the undo comes first", () => {
    const { store, docs, site, web } = open();
    store.combineProject(site.id, docs.id);
    const count = lines(store, site.key).length;
    expect(() => store.combineProject(site.id, web.id)).toThrow("docs-site is in docs. Undo it first.");
    expect(code(() => store.combineProject(site.id, web.id))).toBe("already_combined");
    expect(store.project(site.id)!.merged_into).toBe(docs.id);
    expect(lines(store, site.key)).toHaveLength(count);
    store.combineProject(site.id, null);
    store.combineProject(site.id, web.id);
    expect(store.project(site.id)!.merged_into).toBe(web.id);
  });

  test("a project whose target is gone stands alone, so it can go into another", () => {
    const { store, docs, site, web } = open();
    store.combineProject(site.id, docs.id);
    store.deleteProject(docs.id);
    store.combineProject(site.id, web.id);
    expect(store.project(site.id)!.merged_into).toBe(web.id);
  });

  test("the race of two windows: A into B and B into A cannot make a loop", () => {
    const { store, docs, site } = open();
    store.combineProject(site.id, docs.id);
    expect(code(() => store.combineProject(docs.id, site.id))).toBe("validation_error");
    expect(store.listProjects().map((p) => p.id)).toContain(docs.id);
  });

  test("a project cannot go into itself, or into a project that does not exist", () => {
    const { store, docs } = open();
    expect(code(() => store.combineProject(docs.id, docs.id))).toBe("validation_error");
    expect(code(() => store.combineProject(docs.id, "prj_nothing"))).toBe("project_not_found");
    expect(code(() => store.combineProject("prj_nothing", docs.id))).toBe("project_not_found");
  });

  test("a loop written by hand or a bad copy hides nobody: both stand alone, and a reload agrees", () => {
    const { store, docs, site, web, dir } = open();
    const say2 = say(store, site.id, "Still here.");
    const seq = store.cursor();
    const line = (project: typeof docs, into: string, n: number) => `${JSON.stringify({ v: 1, seq: seq + n, at: "2026-10-31T00:00:00.000Z", kind: "project", id: project.id, record: { ...project, merged_into: into } })}\n`;
    appendFileSync(file(store, docs.key, "project.json"), line(docs, site.id, 1));
    appendFileSync(file(store, site.key, "project.json"), line(site, docs.id, 2));
    const reader = InboxStore.open(dir);
    expect(reader.listProjects().map((p) => p.id).sort()).toEqual([docs.id, site.id, web.id].sort());
    expect(reader.message(say2.id)).not.toBeNull();
  });

  test("a merged_into that is not a string, or names nobody, is ignored: the project stands alone", () => {
    const { store, docs, site, web, dir } = open();
    const seq = store.cursor();
    appendFileSync(file(store, site.key, "project.json"), `${JSON.stringify({ v: 1, seq: seq + 1, at: "2026-10-31T00:00:00.000Z", kind: "project", id: site.id, record: { ...site, merged_into: 42 } })}\n`);
    appendFileSync(file(store, web.key, "project.json"), `${JSON.stringify({ v: 1, seq: seq + 2, at: "2026-10-31T00:00:00.000Z", kind: "project", id: web.id, record: { ...web, merged_into: "prj_gone" } })}\n`);
    expect(InboxStore.open(dir).listProjects().map((p) => p.id).sort()).toEqual([docs.id, site.id, web.id].sort());
  });

  test("a half-written combine line (a crash) leaves the project as it was, and the next write still lands", () => {
    const { store, docs, site, dir } = open();
    say(store, site.id, "Before the crash.");
    appendFileSync(file(store, site.key, "project.json"), `{"v":1,"seq":99999,"kind":"project","id":"${site.id}","rec`);
    const reader = InboxStore.open(dir);
    expect(reader.listProjects().map((p) => p.id)).toContain(site.id);
    reader.combineProject(site.id, docs.id);
    expect(InboxStore.open(dir).project(site.id)!.merged_into).toBe(docs.id);
  });

  test("an earlier line appended late (seq lower) does not take an undo back", () => {
    const { store, docs, site, dir } = open();
    store.combineProject(site.id, docs.id);
    const combineLine = readFileSync(file(store, site.key, "project.json"), "utf8").trim().split("\n").pop()!;
    store.combineProject(site.id, null);
    appendFileSync(file(store, site.key, "project.json"), `${combineLine}\n`);
    expect(InboxStore.open(dir).listProjects().map((p) => p.id)).toContain(site.id);
  });

  test("Delete on a project others went into deletes its own threads only: theirs come back as their own project", () => {
    const { store, docs, site, dir } = open();
    const mine = say(store, docs.id, "A's.");
    const theirs = say(store, site.id, "B's.");
    store.combineProject(site.id, docs.id);
    store.deleteProject(docs.id);
    for (const reader of [store, InboxStore.open(dir)]) {
      expect(reader.project(docs.id)).toBeNull();
      expect(reader.message(mine.id)).toBeNull();
      expect(reader.message(theirs.id)).not.toBeNull();
      expect(reader.listProjects().map((p) => p.id)).toContain(site.id);
      expect(rowIds(reader, site.id)).toEqual([theirs.thread_id]);
      expect(reader.listRows({ projectId: site.id })[0]!.project.name).toBe("docs-site");
    }
  });

  test("Delete on a combined project takes its folder only, and the project it went into stands", () => {
    const { store, docs, site } = open();
    const mine = say(store, docs.id, "A's.");
    const theirs = say(store, site.id, "B's.");
    store.combineProject(site.id, docs.id);
    store.deleteProject(site.id);
    expect(existsSync(join(store.dir, "projects", site.key))).toBe(false);
    expect(store.message(theirs.id)).toBeNull();
    expect(rowIds(store, docs.id)).toEqual([mine.thread_id]);
  });
});

describe("disk usage", () => {
  test("a combined project's files stay counted, on a row of its own, by its own name", () => {
    const { store, docs, site } = open();
    say(store, docs.id, "A's.");
    say(store, site.id, "B's.");
    const before = store.diskUsage();
    store.combineProject(site.id, docs.id);
    const after = store.diskUsage();
    // The project line is all that grew.
    const grew = lines(store, site.key).at(-1)!;
    expect(after.bytes - before.bytes).toBe(Buffer.byteLength(`${JSON.stringify(grew)}\n`));
    const member = after.projects.find((p) => p.id === site.id)!;
    expect([member.name, member.combined_into, member.threads.length]).toEqual(["docs-site", "docs", 1]);
    expect(after.projects.find((p) => p.id === docs.id)!.combined).toEqual(["docs-site"]);
  });

  test("a chain: the head names only what a Delete leaves on its own", () => {
    const { store, docs, site, web } = open();
    store.combineProject(site.id, docs.id);
    store.combineProject(docs.id, web.id);
    expect(store.diskUsage().projects.find((p) => p.id === web.id)!.combined).toEqual(["docs"]);
  });

  test("a project with nothing combined reads exactly as before", () => {
    const { store, docs } = open();
    say(store, docs.id, "A's.");
    const row = store.diskUsage().projects.find((p) => p.id === docs.id)!;
    expect("combined" in row).toBe(false);
    expect("combined_into" in row).toBe(false);
  });
});

describe("people with no duplicates", () => {
  test("no project line, no field, no change", () => {
    const { store, docs, site } = open();
    const sent = say(store, site.id, "Alone.", { thread: "x" });
    expect(store.canonicalProjectId(site.id)).toBe(site.id);
    expect(store.projectGroup(site.id)).toEqual([site.id]);
    expect(store.combinedInto(docs.id)).toEqual([]);
    expect(store.listProjects()).toEqual(store.allProjects());
    expect(lines(store, site.key)).toHaveLength(1);
    expect(store.thread(sent.thread_id)!.project.id).toBe(site.id);
    expect(sent.base_path).toBeUndefined();
  });
});

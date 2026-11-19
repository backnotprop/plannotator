/**
 * Project tags (project-tags.ts): the tags the person put on a project, which only the filters read.
 *
 * The failures this guards: a tag that does not hold across a restart, a deleted tag still read (or lost for its
 * Undo), a combined project losing the tags it brought, untick leaving a combined member's tag behind, a split that
 * moves a group's tag onto the member, the list doing work while no project is tagged, a tag by name
 * that makes a second tag of the same name, a write to an unknown project or tag, and a newer version's file read or
 * written over.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { createInboxProjectTags, INBOX_PROJECT_TAGS_FILE } from "./project-tags";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-project-tags-"));
  roots.push(dir);
  let clock = Date.parse("2026-11-18T09:00:00.000Z");
  const now = () => new Date((clock += 1000));
  const store = InboxStore.open(dir, { now });
  const billing = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const site = store.ensureProject({ name: "site", root: "/home/me/site" });
  const work = store.createInitiative({ name: "Work", by: PERSON });
  const personal = store.createInitiative({ name: "Personal", by: PERSON });
  const reopen = () => createInboxProjectTags(InboxStore.open(dir, { now }));
  return { dir, store, tags: createInboxProjectTags(store), billing, site, work, personal, reopen };
}

test("a project carries tags, holds them across a restart, and the list reads every tagged project", () => {
  const { tags, billing, site, work, personal, reopen } = world();
  // No project tagged: the list's read does no work for them.
  expect(tags.reader()).toBeNull();
  expect(tags.set(billing.id, work.id, true)).toEqual([work.id]);
  expect(tags.set(site.id, personal.id, true)).toEqual([personal.id]);
  // Ticked again: nothing changes.
  expect(tags.set(billing.id, work.id, true)).toEqual([work.id]);
  const again = reopen();
  expect(again.tagsOf(billing.id)).toEqual([work.id]);
  const read = again.reader()!;
  expect([read(billing.id), read(site.id)]).toEqual([[work.id], [personal.id]]);
  expect(again.set(billing.id, work.id, false)).toEqual([]);
  expect(reopen().reader()!(billing.id)).toEqual([]);
  expect(reopen().reader()!(site.id)).toEqual([personal.id]);
  expect(again.set(site.id, personal.id, false)).toEqual([]);
  expect(reopen().reader()).toBeNull();
});

test("a change tells its listeners; one that changes nothing does not", () => {
  const { tags, billing, work } = world();
  let told = 0;
  tags.onChange(() => (told += 1));
  tags.set(billing.id, work.id, true);
  tags.set(billing.id, work.id, true);
  tags.set(billing.id, work.id, false);
  expect(told).toBe(2);
});

test("a deleted tag is not read, and its Undo brings its projects back", () => {
  const { store, tags, billing, work } = world();
  tags.set(billing.id, work.id, true);
  store.deleteInitiative(work.id);
  expect(tags.tagsOf(billing.id)).toEqual([]);
  expect(tags.reader()!(billing.id)).toEqual([]);
  expect(() => tags.set(billing.id, work.id, true)).toThrow();
  store.restoreInitiative(work.id);
  expect(tags.tagsOf(billing.id)).toEqual([work.id]);
});

test("a combined project keeps the tags it brought, and untick takes them off the whole group", () => {
  const { store, tags, billing, site, work, personal } = world();
  tags.set(site.id, personal.id, true);
  tags.set(billing.id, work.id, true);
  store.combineProject(site.id, billing.id);
  expect(tags.tagsOf(billing.id)).toEqual([work.id, personal.id]);
  // A member reads as its head, as the list's rows and cards carry the head's id.
  expect(tags.reader()!(site.id)).toEqual([work.id, personal.id]);
  expect(tags.set(billing.id, personal.id, false)).toEqual([work.id]);
  // Split again, the member does not get back a tag the person took off the group.
  store.combineProject(site.id, null);
  expect(tags.tagsOf(site.id)).toEqual([]);
});

test("split after combine: a tag ticked on the group stays on the head; the member's own tags come back to it", () => {
  const { store, tags, billing, site, work, personal } = world();
  tags.set(site.id, personal.id, true);
  store.combineProject(site.id, billing.id);
  // Ticked on the combined project: stored on the head only (the guide's "Project tags", storage).
  tags.set(site.id, work.id, true);
  store.combineProject(site.id, null);
  expect(tags.tagsOf(billing.id)).toEqual([work.id]);
  expect(tags.tagsOf(site.id)).toEqual([personal.id]);
});

test("by name: the live tag of that name (case ignored), made once when none is", () => {
  const { store, tags, billing, site, work } = world();
  expect(tags.setNamed(billing.id, " work ", true)).toEqual([work.id]);
  expect(tags.setNamed(billing.id, "Clients", false)).toEqual([work.id]);
  const before = store.initiatives().length;
  const [, made] = tags.setNamed(billing.id, "Clients", true);
  expect(store.initiative(made!)?.name).toBe("Clients");
  expect(tags.setNamed(site.id, "clients", true)).toEqual([made]);
  expect(store.initiatives().length).toBe(before + 1);
});

test("an unknown project or tag is refused and writes nothing", () => {
  const { store, tags, billing, work } = world();
  expect(() => tags.set("prj_nope", work.id, true)).toThrow();
  expect(() => tags.set(billing.id, "ini_nope", true)).toThrow();
  expect(() => tags.setNamed(billing.id, "", true)).toThrow();
  expect(existsSync(join(store.dir, INBOX_PROJECT_TAGS_FILE))).toBe(false);
});

test("a newer version's file is read as none and never written over; an unreadable one moves aside", () => {
  const { store, billing, work } = world();
  const dir = store.dir;
  const file = join(dir, INBOX_PROJECT_TAGS_FILE);
  const newer = JSON.stringify({ v: 2, projects: { [billing.id]: [work.id] } });
  writeFileSync(file, newer);
  const tags = createInboxProjectTags(store);
  expect(tags.tagsOf(billing.id)).toEqual([]);
  expect(() => tags.set(billing.id, work.id, true)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(newer);
  writeFileSync(file, "{ not json");
  const fresh = createInboxProjectTags(store);
  expect(fresh.set(billing.id, work.id, true)).toEqual([work.id]);
  expect(readdirSync(dir).some((name) => name.startsWith(`${INBOX_PROJECT_TAGS_FILE}.unreadable-`))).toBe(true);
});

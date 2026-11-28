/**
 * Plannotator Inbox: the tags the person put on a project (the owner, 2026-11-18: "Let a project carry a tag (for
 * example Work or Personal), and let the existing filter pick that tag, so the Board and the list can show a set of
 * projects").
 *
 *   inbox/project-tags.json   { v: 1, projects: { [prj_id]: [ini_id, …] } }, 0600, written whole (temp, then rename)
 *
 * A project tag is a thread tag (an initiative, `ini_`): the same tags, the same names and colours. It is read only
 * by the filters (the list's Tag group and the Board's Tag pick): a thread or a card of a tagged project is in that
 * tag there. It is never written onto a thread or a card, so a row's own tags, a tag's list and its counts stay as
 * they were. A file outside the event log, as tags.json is: agents, the MCP, search and the phone's event stream never
 * see it, and an Inbox from before project tags never opens it.
 *
 * Kept by the project the person tagged (a combined project's head); a project reads the tags of every project of its
 * group, so combining keeps them. A deleted tag keeps its place here, so its Undo brings its projects back; only live
 * tags are read. A file that does not parse moves aside (`project-tags.json.unreadable-<time>`); a newer version's is
 * read as none and never written over.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_INITIATIVE_NAME_MAX, inboxInitiativeNameKey, isInboxId, type InboxAuthor, type InboxInitiative, type InboxProject } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_PROJECT_TAGS_FILE = "project-tags.json";

/** The tags each project carries, by the project's id, oldest pick first. */
export type InboxProjectTagSets = Map<string, string[]>;

type FileState = "missing" | "ok" | "bad" | "newer";

function read(dir: string): { state: FileState; sets: InboxProjectTagSets } {
  const sets: InboxProjectTagSets = new Map();
  let raw: string;
  try {
    raw = readFileSync(join(dir, INBOX_PROJECT_TAGS_FILE), "utf8");
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad", sets };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: "bad", sets };
  }
  const file = value as { v?: unknown; projects?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return { state: "bad", sets };
  if (typeof file.v === "number" && file.v > 1) return { state: "newer", sets };
  if (file.v !== 1 || !file.projects || typeof file.projects !== "object" || Array.isArray(file.projects)) return { state: "bad", sets };
  for (const [project, tags] of Object.entries(file.projects as Record<string, unknown>)) {
    if (!isInboxId("prj", project) || !Array.isArray(tags)) continue;
    const ids = [...new Set(tags.filter((tag): tag is string => isInboxId("ini", tag)))];
    if (ids.length > 0) sets.set(project, ids);
  }
  return { state: "ok", sets };
}

/** The sets on disk; a file this version cannot read gives none. */
export function readInboxProjectTags(dir: string): InboxProjectTagSets {
  return read(dir).sets;
}

/** Write the sets whole (owner-only); none removes the file. A newer version's file is refused. */
export function writeInboxProjectTags(dir: string, sets: ReadonlyMap<string, readonly string[]>): void {
  const file = join(dir, INBOX_PROJECT_TAGS_FILE);
  const { state } = read(dir);
  if (state === "newer") throw new InboxError("tags_newer", "project-tags.json was written by a newer Plannotator; update Plannotator to change tags.");
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const kept = [...sets].filter(([, tags]) => tags.length > 0);
  if (kept.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, projects: Object.fromEntries(kept) })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** What the project tags read from the store. */
export interface ProjectTagsStore {
  readonly dir: string;
  project(id: string): InboxProject | null;
  canonicalProjectId(id: string): string;
  projectGroup(id: string): string[];
  initiatives(): InboxInitiative[];
  createInitiative(input: { name: unknown; by: InboxAuthor }): InboxInitiative;
}

export interface InboxProjectTags {
  /** A project's live tags (its group's), oldest pick first. */
  tagsOf(projectId: string): string[];
  /**
   * One read of every project's live tags (the list's projects): null when no project is tagged, so the list does
   * no work for them; else `tagsOf` with the live tags read once.
   */
  reader(): ((projectId: string) => string[]) | null;
  /** Put the project in a live tag (`on`) or take it out. Answers its tags. */
  set(projectId: unknown, tagId: unknown, on: boolean): string[];
  /** The same by the tag's name (a linked machine's window names a tag so): made when none is and `on`. */
  setNamed(projectId: unknown, name: unknown, on: boolean): string[];
  /** The sets changed (a write here): the windows read the list again. */
  onChange(listener: () => void): () => void;
}

export function createInboxProjectTags(store: ProjectTagsStore): InboxProjectTags {
  let sets = readInboxProjectTags(store.dir);
  const listeners = new Set<() => void>();
  const live = () => new Set(store.initiatives().filter((tag) => tag.deleted_at === null).map((tag) => tag.id));

  const tagsWith = (projectId: string, alive: ReadonlySet<string>): string[] => {
    const out: string[] = [];
    for (const member of store.projectGroup(projectId)) for (const tag of sets.get(member) ?? []) if (alive.has(tag) && !out.includes(tag)) out.push(tag);
    return out;
  };

  const head = (projectId: unknown): string => {
    const project = typeof projectId === "string" ? store.project(projectId) : null;
    if (!project) throw new InboxError("project_not_found", `No project ${String(projectId)}.`, { field: "project" });
    return store.canonicalProjectId(project.id);
  };

  const commit = (next: InboxProjectTagSets) => {
    writeInboxProjectTags(store.dir, next);
    sets = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never fails the write.
      }
    }
  };

  const set = (projectId: unknown, tagId: unknown, on: boolean): string[] => {
    const id = head(projectId);
    const alive = live();
    if (typeof tagId !== "string" || !alive.has(tagId)) throw new InboxError("initiative_not_found", `No initiative ${String(tagId)}.`, { field: "initiative" });
    if (tagsWith(id, alive).includes(tagId) === on) return tagsWith(id, alive);
    const next = new Map(sets);
    if (on) next.set(id, [...(next.get(id) ?? []), tagId]);
    // Off: out of every project of the group, so a tag a combined project brought goes too.
    else for (const member of store.projectGroup(id)) if (next.has(member)) next.set(member, next.get(member)!.filter((tag) => tag !== tagId));
    commit(next);
    return tagsWith(id, alive);
  };

  return {
    tagsOf: (projectId) => (sets.size === 0 ? [] : tagsWith(store.canonicalProjectId(projectId), live())),
    reader: () => {
      if (sets.size === 0) return null;
      const alive = live();
      return (projectId) => tagsWith(store.canonicalProjectId(projectId), alive);
    },
    set,
    setNamed: (projectId, name, on) => {
      const id = head(projectId);
      if (typeof name !== "string" || !name.trim() || [...name.trim()].length > INBOX_INITIATIVE_NAME_MAX) throw new InboxError("validation_error", "name: a tag's name.", { field: "name" });
      const key = inboxInitiativeNameKey(name);
      const found = store.initiatives().find((tag) => tag.deleted_at === null && inboxInitiativeNameKey(tag.name) === key);
      if (found) return set(id, found.id, on);
      if (!on) return tagsWith(id, live());
      return set(id, store.createInitiative({ name, by: { kind: "person" } }).id, true);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Rename… in the project menu (OPTIONS.md option A, picked 2026-10-31): the
 * person's name for a project is an additive `display_name` on the project
 * record, written as one more project line with the same id, key, slug and
 * root. What can regress: an earlier line winning over a later one (on a
 * read or on a reload), Reset name leaving the field behind, the id, key,
 * slug, root or a message's `project_id` moving with the name, a project
 * nobody renamed reading differently, a name the window cannot draw (empty,
 * too long, a line break or a bidi control) getting stored, and an older
 * store's single project line no longer loading.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PROJECT_NAME_MAX, checkInboxProjectName } from "@plannotator/core/inbox-types";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-rename-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const acme = store.ensureProject({ name: "main", root: "/code/acme/main" });
  const initech = store.ensureProject({ name: "main", root: "/code/initech/main" });
  const notes = store.ensureProject({ name: "notes", root: "/code/notes" });
  return { dir, store, acme, initech, notes };
}

const agent = { kind: "agent" as const, host: "claude-code", session: "ses_1", name: "Claude Code" };

/** Every line of a project's project.json, as stored. */
function projectLines(store: InboxStore, key: string) {
  return readFileSync(join(store.dir, "projects", key, "project.json"), "utf8")
    .split("\n")
    .map((raw) => parseInboxLine(raw))
    .filter((line) => line !== null);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("renameProject", () => {
  test("the store applies the last project line: a second rename wins, and nothing else of the record moves", () => {
    const { store, acme } = open();
    const sent = store.sendMessage({ project_id: acme.id, author: agent, body: "Before the rename." }).message;
    store.renameProject(acme.id, "acme");
    store.renameProject(acme.id, "Acme Platform");
    const lines = projectLines(store, acme.key);
    // The first line plus one per rename, each a whole record with the same id, key, slug and root.
    expect(lines.map((line) => line.record.display_name)).toEqual([undefined, "acme", "Acme Platform"]);
    for (const line of lines) expect(line.record).toMatchObject({ id: acme.id, key: acme.key, name: "main", root: "/code/acme/main", created_at: acme.created_at });
    expect(store.project(acme.id)).toMatchObject({ id: acme.id, key: acme.key, root: acme.root, name: "Acme Platform", display_name: "Acme Platform" });
    expect(store.projectByRoot("/code/acme/main")?.name).toBe("Acme Platform");
    // The project's threads stay where they were and read the new name.
    expect(store.message(sent.id)?.project_id).toBe(acme.id);
    expect(store.listRow(sent.thread_id)?.project).toEqual({ id: acme.id, name: "Acme Platform" });
    // A later send from the same root lands in the same project.
    expect(store.ensureProject({ name: "main", root: "/code/acme/main" }).id).toBe(acme.id);
    expect(store.listProjects()).toHaveLength(3);
  });

  test("display_name survives a reload, and an older line written after a newer one never wins", () => {
    const { dir, store, acme } = open();
    store.renameProject(acme.id, "acme");
    const reopened = InboxStore.open(dir);
    expect(reopened.project(acme.id)).toMatchObject({ name: "acme", display_name: "acme", key: acme.key, root: acme.root });
    // The seq decides, not the order of lines in the file: lines are sorted by seq on load.
    reopened.renameProject(acme.id, "acme two");
    expect(InboxStore.open(dir).project(acme.id)?.name).toBe("acme two");
  });

  test("Reset name clears it: the folder's name again, with no display_name left on the record", () => {
    const { dir, store, acme, initech } = open();
    const before = store.project(acme.id)!.name;
    store.renameProject(acme.id, "acme");
    store.renameProject(acme.id, null);
    const reset = store.project(acme.id)!;
    expect(reset.name).toBe(before);
    expect("display_name" in reset).toBe(false);
    expect("display_name" in projectLines(store, acme.key).at(-1)!.record).toBe(false);
    expect(InboxStore.open(dir).project(acme.id)?.name).toBe(before);
    // Back to the clash with the other `main`, exactly as before the rename.
    expect(store.project(initech.id)?.name).toBe("main · initech");
  });

  test("a name equal to the current one, or a reset with none set, writes nothing", () => {
    const { store, acme } = open();
    const cursor = store.cursor();
    store.renameProject(acme.id, null);
    expect(store.cursor()).toBe(cursor);
    store.renameProject(acme.id, "acme");
    const named = store.cursor();
    store.renameProject(acme.id, "  acme ");
    expect(store.cursor()).toBe(named);
    expect(projectLines(store, acme.key)).toHaveLength(2);
  });

  test("the labels use it: as it is, no parent added, and the other projects' clashes no longer count it", () => {
    const { store, acme, initech, notes } = open();
    // Two folders named main: each names its parent.
    expect(store.project(acme.id)?.name).toBe("main · acme");
    expect(store.project(initech.id)?.name).toBe("main · initech");
    store.renameProject(acme.id, "acme");
    const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
    expect(names.get(acme.id)).toBe("acme");
    // The other main is alone now: just its folder's name.
    expect(names.get(initech.id)).toBe("main");
    expect(names.get(notes.id)).toBe("notes");
    // A name that matches another project's folder is still shown as given.
    store.renameProject(initech.id, "notes");
    expect(store.project(initech.id)?.name).toBe("notes");
    expect(store.project(notes.id)?.name).toBe("notes");
  });

  test("refuses an empty, blank, too long or undrawable name, and a missing project, writing nothing", () => {
    const { store, acme } = open();
    const cursor = store.cursor();
    for (const bad of ["", "   ", "​", "a".repeat(INBOX_PROJECT_NAME_MAX + 1), "ac me", "ac‮me", "ac\u0007me"]) {
      expect(code(() => store.renameProject(acme.id, bad))).toBe("validation_error");
    }
    expect(code(() => store.renameProject("prj_00000000000000000000000000", "acme"))).toBe("project_not_found");
    expect(store.cursor()).toBe(cursor);
    expect(store.project(acme.id)?.display_name).toBeUndefined();
  });
});

describe("checkInboxProjectName", () => {
  test("trims, folds whitespace and keeps up to the cap, counted in characters", () => {
    expect(checkInboxProjectName("  acme \n platform\t")).toEqual({ ok: true, name: "acme platform" });
    // 64 characters that are each two UTF-16 units still fit.
    expect(checkInboxProjectName("😀".repeat(INBOX_PROJECT_NAME_MAX))).toEqual({ ok: true, name: "😀".repeat(INBOX_PROJECT_NAME_MAX) });
    expect(checkInboxProjectName("請求サービス")).toEqual({ ok: true, name: "請求サービス" });
    expect(checkInboxProjectName(42).ok).toBe(false);
  });
});

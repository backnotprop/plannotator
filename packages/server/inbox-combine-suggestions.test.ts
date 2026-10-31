/**
 * Which projects Tidy calls one. What can regress: a guess getting through (a
 * shared name, a folder that only looks like a checkout), the wrong project
 * being kept, or a pair the person pulled apart coming back.
 */
import { describe, expect, test } from "bun:test";
import type { InboxProject, InboxProjectRepo } from "@plannotator/core/inbox-types";
import { combineSuggestions } from "./inbox-combine-suggestions";

let created = 0;
function project(id: string, root: string, extra: Partial<InboxProject> = {}): InboxProject {
  created += 1;
  return { id, key: id, name: id, root, created_at: `2026-01-01T00:00:${String(created % 60).padStart(2, "0")}.000Z`, ...extra } as InboxProject;
}

const repo = (display: string, host = "github.com"): InboxProjectRepo => ({ host, display }) as InboxProjectRepo;

const pairs = (input: Parameters<typeof combineSuggestions>[0]) => combineSuggestions(input).map((row) => [row.from.id, row.into.id]);
const noThreads = () => 0;

describe("combineSuggestions", () => {
  test("the same origin is one project, whatever the case; the same name in another repository is not", () => {
    const projects = [project("prj_a", "/code/app"), project("prj_b", "/tmp/APP"), project("prj_c", "/other/app")];
    const origins: Record<string, InboxProjectRepo> = { "/code/app": repo("acme/app"), "/tmp/APP": repo("ACME/app"), "/other/app": repo("initech/app") };
    expect(pairs({ projects, repoOf: (root) => origins[root] ?? null, threads: noThreads })).toEqual([["prj_b", "prj_a"]]);
  });

  test("the same path on another host is another repository", () => {
    const projects = [project("prj_a", "/a"), project("prj_b", "/b")];
    const origins: Record<string, InboxProjectRepo> = { "/a": repo("acme/app"), "/b": repo("acme/app", "gitlab.com") };
    expect(pairs({ projects, repoOf: (root) => origins[root] ?? null, threads: noThreads })).toEqual([]);
  });

  test("folders with no origin are never one, however alike", () => {
    const projects = [project("prj_a", "/code/app"), project("prj_b", "/backup/app")];
    expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([]);
  });

  test("counts threads only for a pair: a person with no duplicates pays nothing", () => {
    const projects = [project("prj_a", "/a"), project("prj_b", "/b"), project("prj_c", "/c")];
    const origins: Record<string, InboxProjectRepo> = { "/a": repo("acme/a"), "/b": repo("acme/b") };
    let counted = 0;
    const threads = () => {
      counted += 1;
      return 0;
    };
    expect(pairs({ projects, repoOf: (root) => origins[root] ?? null, threads })).toEqual([]);
    expect(counted).toBe(0);
  });

  test("keeps the project with the most threads, then the oldest", () => {
    const projects = [project("prj_old", "/a", { created_at: "2025-01-01T00:00:00.000Z" }), project("prj_new", "/b", { created_at: "2026-01-01T00:00:00.000Z" })];
    const repoOf = () => repo("acme/app");
    expect(pairs({ projects, repoOf, threads: noThreads })).toEqual([["prj_new", "prj_old"]]);
    expect(pairs({ projects, repoOf, threads: (id) => (id === "prj_new" ? 3 : 1) })).toEqual([["prj_old", "prj_new"]]);
  });

  test("three clones are two suggestions into the same one", () => {
    const projects = [project("prj_a", "/a"), project("prj_b", "/b"), project("prj_c", "/c")];
    expect(pairs({ projects, repoOf: () => repo("acme/app"), threads: (id) => (id === "prj_b" ? 9 : 0) })).toEqual([
      ["prj_a", "prj_b"],
      ["prj_c", "prj_b"],
    ]);
  });

  test("a separated pair is not offered, either way round, and the other clone still is", () => {
    const projects = [project("prj_a", "/a"), project("prj_b", "/b", { separated_from: "prj_a" }), project("prj_c", "/c")];
    expect(pairs({ projects, repoOf: () => repo("acme/app"), threads: (id) => (id === "prj_a" ? 2 : 0) })).toEqual([["prj_c", "prj_a"]]);
    const flipped = [project("prj_a", "/a", { separated_from: "prj_b" }), project("prj_b", "/b")];
    expect(pairs({ projects: flipped, repoOf: () => repo("acme/app"), threads: noThreads })).toEqual([]);
  });

  test("a checkout in the project's worktrees folder, a tool's own included, is a leftover", () => {
    for (const root of ["/code/app/worktrees/fix-y", "/code/app/.worktrees/fix-y", "/code/app/.claude/worktrees/fix-y"]) {
      const projects = [project("prj_app", "/code/app"), project("prj_left", root)];
      expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([["prj_left", "prj_app"]]);
    }
  });

  test("a folder inside a project that is not a checkout is its own project", () => {
    for (const root of ["/code/app/packages/web", "/code/app/worktrees", "/code/app/src/worktrees/fix-y", "/code/application/worktrees/fix-y", "/code/app/worktrees/fix-y/deep"]) {
      const projects = [project("prj_app", "/code/app"), project("prj_left", root)];
      expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([]);
    }
  });

  test("a leftover of a pair the person separated is not offered", () => {
    const projects = [project("prj_app", "/code/app"), project("prj_left", "/code/app/worktrees/fix-y", { separated_from: "prj_app" })];
    expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([]);
  });

  test("Windows paths are read the same", () => {
    const projects = [project("prj_app", "C:\\code\\app"), project("prj_left", "C:\\code\\app\\.worktrees\\fix-y")];
    expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([["prj_left", "prj_app"]]);
  });
});

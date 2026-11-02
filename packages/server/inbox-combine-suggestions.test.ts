/**
 * Which projects Tidy calls one. What can regress: a guess getting through (a
 * shared name, a folder that only looks like a checkout), the wrong project
 * being kept, or a pair the person pulled apart coming back.
 */
import { describe, expect, test } from "bun:test";
import type { InboxProject, InboxProjectRepo } from "@plannotator/core/inbox-types";
import { COMBINE_WHY_STARTED_ABOVE, combineSuggestions, type InboxAgentWork } from "./inbox-combine-suggestions";

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

  test("a pair whose combine was undone is not offered, either way round, and the other clone still is", () => {
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

  test("through a chain: a project is not offered back into the group it left, whichever project now heads it", () => {
    // fix-y left notes, and notes has since gone into web: web is the group fix-y said no to.
    const projects = [project("prj_web", "/web"), project("prj_fix", "/fix", { separated_from: "prj_notes" })];
    const sameProject = (a: string, b: string) => (a === "prj_notes" ? "prj_web" : a) === (b === "prj_notes" ? "prj_web" : b);
    expect(pairs({ projects, repoOf: () => repo("acme/app"), threads: noThreads, sameProject })).toEqual([]);
    // Another head is another project: the no was not about it.
    expect(pairs({ projects, repoOf: () => repo("acme/app"), threads: noThreads, sameProject: (a, b) => a === b })).toEqual([["prj_fix", "prj_web"]]);
  });

  test("a leftover whose combine was undone is not offered", () => {
    const projects = [project("prj_app", "/code/app"), project("prj_left", "/code/app/worktrees/fix-y", { separated_from: "prj_app" })];
    expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([]);
  });

  test("Windows paths are read the same", () => {
    const projects = [project("prj_app", "C:\\code\\app"), project("prj_left", "C:\\code\\app\\.worktrees\\fix-y")];
    expect(pairs({ projects, repoOf: () => null, threads: noThreads })).toEqual([["prj_left", "prj_app"]]);
  });
});

// Audit D2: a session started in a plain folder above a repository files under the folder; the repository's own
// sessions file under the repository. Offered only when every agent message of the folder is the repository's work.
describe("combineSuggestions: work split by start folder", () => {
  const PLAIN = new Set(["/code", "/code/notes", "/home/me"]);
  const split = (work: Record<string, InboxAgentWork[]>, projects = [project("prj_code", "/code"), project("prj_a", "/code/a")], extra: Partial<Parameters<typeof combineSuggestions>[0]> = {}) =>
    combineSuggestions({ projects, repoOf: () => null, threads: noThreads, plainFolder: (root) => PLAIN.has(root), agentWork: (id) => work[id] ?? [], ...extra });
  const at = (session: string | null, folder: string | null = null): InboxAgentWork => ({ session, folder });

  test("offered into the repository when the folder's messages were sent from inside it, or by sessions that also wrote there", () => {
    const fromInside = split({ prj_code: [at("claude-1", "/code/a"), at("claude-1", "/code/a/src")], prj_a: [at("codex-1")] });
    expect(fromInside.map((row) => [row.from.id, row.into.id, row.why])).toEqual([["prj_code", "prj_a", COMBINE_WHY_STARTED_ABOVE]]);
    // The same session wrote in both (its shell's calls before one session was one project, or a /cd).
    const sameSession = split({ prj_code: [at("claude-1"), at("claude-1")], prj_a: [at("claude-1", null)] });
    expect(sameSession.map((row) => [row.from.id, row.into.id])).toEqual([["prj_code", "prj_a"]]);
  });

  test("never for unrelated folders: other work in the folder, several projects inside it, or no messages", () => {
    // One message from the folder itself by a session that never wrote in the repository: other work.
    expect(split({ prj_code: [at("claude-1", "/code/a"), at("claude-2")], prj_a: [at("claude-1")] })).toEqual([]);
    // A message from a sibling whose name starts the same is not inside it.
    expect(split({ prj_code: [at("claude-1", "/code/ab")], prj_a: [at("codex-1")] })).toEqual([]);
    // A folder that holds several projects is a folder of projects, even when all its work so far was one's.
    const two = [project("prj_code", "/code"), project("prj_a", "/code/a"), project("prj_b", "/code/b")];
    expect(split({ prj_code: [at("claude-1", "/code/a")], prj_a: [at("claude-1")] }, two)).toEqual([]);
    // Nothing to judge by.
    expect(split({ prj_a: [at("codex-1")] })).toEqual([]);
    // An agent with no session that sent from the folder itself.
    expect(split({ prj_code: [at(null)], prj_a: [at(null)] })).toEqual([]);
  });

  test("never out of a repository, the home folder or `/`, never into a plain folder, and not again once undone", () => {
    const work = { prj_code: [at("claude-1", "/code/a")], prj_a: [at("claude-1")], prj_home: [at("claude-1", "/home/me/a")] };
    // A repository with a nested one: separate by design (a submodule is its own project).
    expect(split(work, undefined, { plainFolder: () => false })).toEqual([]);
    // The home folder (plainFolder says no) holding one project.
    expect(split(work, [project("prj_home", "/home/me"), project("prj_a", "/home/me/a")], { plainFolder: (root) => root !== "/home/me" && PLAIN.has(root) })).toEqual([]);
    // Into a plain folder: two places, whatever their agents did.
    expect(split({ prj_code: [at("claude-1", "/code/notes")], prj_notes: [at("claude-1")] }, [project("prj_code", "/code"), project("prj_notes", "/code/notes")])).toEqual([]);
    // The person undid it.
    expect(split(work, [project("prj_code", "/code", { separated_from: "prj_a" }), project("prj_a", "/code/a")])).toEqual([]);
  });

  test("reads messages only for a folder with one project inside it", () => {
    const asked: string[] = [];
    const projects = [project("prj_x", "/x"), project("prj_y", "/y"), project("prj_code", "/code"), project("prj_a", "/code/a"), project("prj_b", "/code/b")];
    combineSuggestions({ projects, repoOf: () => null, threads: noThreads, plainFolder: () => true, agentWork: (id) => (asked.push(id), []) });
    expect(asked).toEqual([]);
  });
});

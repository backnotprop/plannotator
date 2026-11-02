/**
 * Tidy's "Combine projects" suggestions (approval "project-combine"): projects
 * that are one, from strong signals only. No AI, and the person ticks each.
 *
 *  - the same git `origin` (a repository cloned twice);
 *  - a project left inside another's root in a `worktrees` folder (what an
 *    Inbox made for each worktree before worktrees folded into their repository);
 *  - work split by start folder: a session started in a plain folder above a
 *    repository files under the folder, while the repository's own sessions
 *    file under the repository. The folder is offered into the repository
 *    only when it is the one project inside the folder and ALL of the
 *    folder's agent messages are its work (`sameWork`).
 *
 * A pair whose combine was undone is not suggested again. Pure.
 */

import type { InboxProject, InboxProjectRepo, InboxTidyCombine } from "@plannotator/core/inbox-types";

/** The folders that hold a repository's checkouts, a tool's own included (`.claude/worktrees`). */
const CHECKOUTS = new Set(["worktrees", ".worktrees"]);

/** The parts of a path, either separator, without empty ones. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** `inner` is a checkout folder directly in `outer`'s `worktrees`, or in a dot-folder's (`<outer>/.claude/worktrees/<name>`). */
function isLeftoverWorktree(inner: string, outer: string): boolean {
  const parts = segments(inner);
  const base = segments(outer);
  if (parts.length < base.length + 2 || !base.every((part, index) => part === parts[index])) return false;
  const between = parts.slice(base.length, -1);
  return CHECKOUTS.has(between[between.length - 1]!.toLowerCase()) && between.slice(0, -1).every((part) => part.startsWith("."));
}

/** `path` is `folder` or lies inside it, by whole path segments. */
function isWithin(path: string, folder: string): boolean {
  const parts = segments(path);
  const base = segments(folder);
  return parts.length >= base.length && base.every((part, index) => part === parts[index]);
}

/** Into the project with the most threads, the oldest on a tie. */
function intoFirst(threads: (id: string) => number) {
  return (a: InboxProject, b: InboxProject) => threads(b.id) - threads(a.id) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** One agent message of a project's threads: who sent it, and the folder it was sent from when that was not the project's root (`base_path`). */
export interface InboxAgentWork {
  session: string | null;
  folder: string | null;
}

/** Why a folder above a project is offered into it (a few words, as the window shows them). */
export const COMBINE_WHY_STARTED_ABOVE = "same work, started a folder above";

export interface CombineSuggestionInput {
  /** The projects a person sees (`listProjects`): a combined one is not suggested again. */
  projects: readonly InboxProject[];
  repoOf: (root: string) => InboxProjectRepo | null;
  threads: (projectId: string) => number;
  /** Whether two ids read as one project (`InboxStore.sameProject`). Without it, only the same id. */
  sameProject?: (a: string, b: string) => boolean;
  /**
   * Whether a root is a plain folder that may go into the one project inside
   * it: no repository (`.git`), not the home folder, not `/`. Absent: no
   * folder is offered that way.
   */
  plainFolder?: (root: string) => boolean;
  /** The agent messages of a project's threads (its group's). Asked only for a plain folder with exactly one project inside it, and that project. */
  agentWork?: (projectId: string) => readonly InboxAgentWork[];
}

/**
 * Whether every agent message of the folder above (`outer`) is the inner
 * project's work: sent from a folder inside it, or by a session that also
 * wrote in it. At least one message; a message sent from the folder itself by
 * a session that never wrote in the inner project is other work.
 */
function sameWork(outer: readonly InboxAgentWork[], inner: readonly InboxAgentWork[], innerRoot: string): boolean {
  if (outer.length === 0) return false;
  const sessions = new Set(inner.map((work) => work.session).filter((session): session is string => session !== null));
  return outer.every((work) => (work.folder !== null && isWithin(work.folder, innerRoot)) || (work.session !== null && sessions.has(work.session)));
}

export function combineSuggestions({ projects, repoOf, threads, sameProject = (a, b) => a === b, plainFolder, agentWork }: CombineSuggestionInput): InboxTidyCombine[] {
  const out: InboxTidyCombine[] = [];
  const taken = new Set<string>();
  /** The person already said no: one left the other, or left a project that has since gone into it. */
  const left = (a: InboxProject, b: InboxProject) => a.separated_from !== undefined && sameProject(a.separated_from, b.id);
  const separated = (a: InboxProject, b: InboxProject) => left(a, b) || left(b, a);
  const pair = (into: InboxProject, from: InboxProject, why = "same repository") => {
    taken.add(from.id);
    out.push({
      into: { id: into.id, name: into.name, root: into.root, ...(into.display_name ? { display_name: into.display_name } : {}) },
      from: { id: from.id, name: from.name, root: from.root },
      why,
    });
  };

  const byRepo = new Map<string, InboxProject[]>();
  for (const project of projects) {
    const repo = repoOf(project.root);
    if (!repo) continue;
    const key = `${repo.host ?? ""}/${repo.display}`.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), project]);
  }
  for (const group of byRepo.values()) {
    if (group.length < 2) continue;
    const [into, ...rest] = [...group].sort(intoFirst(threads));
    for (const from of rest) if (!separated(into!, from)) pair(into!, from);
  }

  for (const from of projects) {
    if (taken.has(from.id)) continue;
    const into = projects.find((project) => project.id !== from.id && !taken.has(project.id) && isLeftoverWorktree(from.root, project.root));
    if (into && !separated(into, from)) pair(into, from);
  }

  if (plainFolder && agentWork) {
    for (const from of projects) {
      if (taken.has(from.id)) continue;
      // A folder holding several projects is a folder of projects: combining it into one would show later work on another there.
      const inside = projects.filter((project) => project.id !== from.id && project.root !== from.root && isWithin(project.root, from.root));
      if (inside.length !== 1) continue;
      const into = inside[0]!;
      // Only a plain folder, into a repository: two plain folders are two places, whatever their agents did.
      if (taken.has(into.id) || separated(into, from) || !plainFolder(from.root) || plainFolder(into.root)) continue;
      if (sameWork(agentWork(from.id), agentWork(into.id), into.root)) pair(into, from, COMBINE_WHY_STARTED_ABOVE);
    }
  }
  return out;
}

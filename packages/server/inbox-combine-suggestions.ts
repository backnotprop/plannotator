/**
 * Tidy's "Combine projects" suggestions (approval "project-combine"): projects
 * that are one, from strong signals only. No AI, and the person ticks each.
 *
 *  - the same git `origin` (a repository cloned twice);
 *  - a project left inside another's root in a `worktrees` folder (what an
 *    Inbox made for each worktree before worktrees folded into their repository).
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

/** The person already said no: a combine of these two was undone. */
function separated(a: InboxProject, b: InboxProject): boolean {
  return a.separated_from === b.id || b.separated_from === a.id;
}

/** Into the project with the most threads, the oldest on a tie. */
function intoFirst(threads: (id: string) => number) {
  return (a: InboxProject, b: InboxProject) => threads(b.id) - threads(a.id) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export interface CombineSuggestionInput {
  /** The projects a person sees (`listProjects`): a combined one is not suggested again. */
  projects: readonly InboxProject[];
  repoOf: (root: string) => InboxProjectRepo | null;
  threads: (projectId: string) => number;
}

export function combineSuggestions({ projects, repoOf, threads }: CombineSuggestionInput): InboxTidyCombine[] {
  const out: InboxTidyCombine[] = [];
  const taken = new Set<string>();
  const pair = (into: InboxProject, from: InboxProject) => {
    taken.add(from.id);
    out.push({
      into: { id: into.id, name: into.name, root: into.root, ...(into.display_name ? { display_name: into.display_name } : {}) },
      from: { id: from.id, name: from.name, root: from.root },
      why: "same repository",
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
  return out;
}

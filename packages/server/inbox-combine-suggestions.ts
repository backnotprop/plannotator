import type { InboxProject, InboxProjectRepo, InboxTidyCombine } from "@plannotator/core/inbox-types";

const CHECKOUTS = new Set(["worktrees", ".worktrees"]);

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

function isLeftoverWorktree(parts: readonly string[], base: readonly string[]): boolean {
  if (parts.length < base.length + 2 || !base.every((part, index) => part === parts[index])) return false;
  const between = parts.slice(base.length, -1);
  return CHECKOUTS.has(between[between.length - 1]!.toLowerCase()) && between.slice(0, -1).every((part) => part.startsWith("."));
}

function isWithin(path: string, folder: string): boolean {
  const parts = segments(path);
  const base = segments(folder);
  return parts.length >= base.length && base.every((part, index) => part === parts[index]);
}

function intoFirst(threads: (id: string) => number) {
  return (a: InboxProject, b: InboxProject) => threads(b.id) - threads(a.id) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export interface InboxAgentWork {
  session: string | null;
  folder: string | null;
}

export const COMBINE_WHY_STARTED_ABOVE = "same work, started a folder above";

export interface CombineSuggestionInput {
  projects: readonly InboxProject[];
  everyProject?: readonly InboxProject[];
  repoOf: (root: string) => InboxProjectRepo | null;
  threads: (projectId: string) => number;
  sameProject?: (a: string, b: string) => boolean;
  plainFolder?: (root: string) => boolean;
  holdsOtherWork?: (folder: string, inner: string) => boolean;
  agentWork?: (projectId: string) => readonly InboxAgentWork[];
}

function sameWork(outer: readonly InboxAgentWork[], inner: readonly InboxAgentWork[], innerRoot: string): boolean {
  if (outer.length === 0) return false;
  const sessions = new Set(inner.map((work) => work.session).filter((session): session is string => session !== null));
  return outer.every((work) => (work.folder !== null && isWithin(work.folder, innerRoot)) || (work.session !== null && sessions.has(work.session)));
}

export function combineSuggestions({
  projects,
  everyProject = projects,
  repoOf,
  threads,
  sameProject = (a, b) => a === b,
  plainFolder,
  holdsOtherWork,
  agentWork,
}: CombineSuggestionInput): InboxTidyCombine[] {
  const out: InboxTidyCombine[] = [];
  const taken = new Set<string>();
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

  const partsOf = new Map<string, string[]>();
  const parts = (root: string) => {
    let found = partsOf.get(root);
    if (!found) partsOf.set(root, (found = segments(root)));
    return found;
  };
  const keyOf = (part: readonly string[], length = part.length) => part.slice(0, length).join("\u0000");
  const order = new Map(projects.map((project, index) => [project.id, index]));
  const atRoot = new Map<string, InboxProject[]>();
  for (const project of projects) {
    const key = keyOf(parts(project.root));
    atRoot.set(key, [...(atRoot.get(key) ?? []), project]);
  }

  for (const from of projects) {
    if (taken.has(from.id)) continue;
    const own = parts(from.root);
    let into: InboxProject | undefined;
    for (let length = 0; length <= own.length - 2; length++) {
      for (const candidate of atRoot.get(keyOf(own, length)) ?? []) {
        if (candidate.id === from.id || taken.has(candidate.id) || !isLeftoverWorktree(own, parts(candidate.root))) continue;
        if (!into || order.get(candidate.id)! < order.get(into.id)!) into = candidate;
      }
    }
    if (into && !separated(into, from)) pair(into, from);
  }

  if (plainFolder && agentWork && holdsOtherWork) {
    const inside = new Map<string, Set<string>>();
    for (const project of everyProject) {
      const own = parts(project.root);
      for (let length = 0; length < own.length; length++) {
        const key = keyOf(own, length);
        let set = inside.get(key);
        if (!set) inside.set(key, (set = new Set()));
        if (set.size < 2) set.add(project.id);
      }
    }
    const listed = new Map(projects.map((project) => [project.id, project]));
    for (const from of projects) {
      if (taken.has(from.id) || from.display_name) continue;
      const ids = inside.get(keyOf(parts(from.root)));
      if (!ids || ids.size !== 1) continue;
      const into = listed.get([...ids][0]!);
      if (!into || taken.has(into.id) || separated(into, from) || !plainFolder(from.root) || plainFolder(into.root)) continue;
      if (sameWork(agentWork(from.id), agentWork(into.id), into.root) && !holdsOtherWork(from.root, into.root)) pair(into, from, COMBINE_WHY_STARTED_ABOVE);
    }
  }
  return out;
}

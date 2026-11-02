/**
 * A project's name as the window shows it (owner's pick, 2026-10-29): just
 * its folder's name, adding the parent folder only when two of the projects
 * on screen share that name, and as many parents as it takes to tell them
 * apart ("api · work", "api · personal"). A checkout in a `worktrees` folder
 * reads as its repository (`labelPath`).
 *
 * The server's name (`inboxProjectLabels` in packages/shared) weighs every
 * project ever stored, so an old worktree named like the repository made the
 * rows read "plannotator · plannotator". Agents keep reading that name; only
 * the window shortens it. Pure.
 */

import { inboxProjectDisplayName } from '@plannotator/core/inbox-types';

/** The parts of a path, either separator, without empty ones. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** How two folder names compare for "the same name": as a person reads them. */
function sameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

/** What the window names a project by: its folder, or the name the person gave it (`display_name`). */
export type LabeledProject = { id: string; root: string; name: string; display_name?: unknown };

/** The folders that hold a repository's checkouts (Workspaces' `<repo>/worktrees/<branch>`). */
const CHECKOUTS = new Set(['worktrees', '.worktrees']);

/**
 * The path the window names a project by. A checkout in a `worktrees` (or
 * `.worktrees`) folder is named for its repository, the folder above that
 * (owner's pick, 2026-10-29: `~/workspaces/projects/appnotes/worktrees/main`
 * reads "appnotes"), so the checkout's folder and `worktrees` drop out of the
 * name and of the parents a clash adds. `checkout` keeps the dropped folder.
 */
export function labelPath(root: string): { parts: string[]; checkout: string | null } {
  const parts = segments(root);
  if (parts.length < 3 || !CHECKOUTS.has(sameKey(parts[parts.length - 2]!))) return { parts, checkout: null };
  // A dot-folder holds tools' checkouts (Claude Code's `<repo>/.claude/worktrees/agent-…`): the repository is above it.
  let repo = parts.length - 3;
  while (repo >= 0 && parts[repo]!.startsWith('.')) repo -= 1;
  // No repository above, or `worktrees` sits in a home folder (`/Users/<x>`, `/home/<x>`, `C:\Users\<x>`): an ordinary folder.
  const home = repo >= 1 && ['users', 'home'].includes(sameKey(parts[repo - 1]!)) && (repo === 1 || (repo === 2 && parts[0]!.endsWith(':')));
  if (repo < 0 || home) return { parts, checkout: null };
  return { parts: parts.slice(0, repo + 1), checkout: parts[parts.length - 1]!.normalize('NFC') };
}

/**
 * Where a home folder ends in `parts` (`/Users/<x>`, `/home/<x>`, `<drive>:\\Users\\<x>`): the index of `<x>`, or
 * -1. The parents a clash adds never spell it out: from there up they read "~".
 */
function homeAt(parts: readonly string[]): number {
  const at = parts[0]?.endsWith(':') ? 1 : 0;
  return parts.length > at + 1 && ['users', 'home'].includes(sameKey(parts[at]!)) ? at + 1 : -1;
}

/**
 * Each project's name by id, for the projects given (the ones on screen): its
 * folder's name (its repository's, for a checkout in `worktrees`: `labelPath`),
 * with the fewest parent folders that tell it apart from the other places of
 * that name. A place is one folder: a repository, the plain folder its
 * checkouts sit in (Workspaces' `appnotes` beside `appnotes/worktrees/main`),
 * and its checkouts share one, so their parents never tell them apart. Within
 * a place the checkout does ("appnotes · main", "appnotes · fix"); the folder
 * itself reads its bare name ("appnotes"). The parents are the shortest suffix
 * that differs for that project, normally one folder ("appnotes · projects"),
 * and a home folder in them reads "~" ("api · ~" beside "api · work"), unless
 * that would make two names the same. A project whose root has no last
 * segment (a filesystem root) keeps `name`. A project the person renamed
 * (`display_name`) reads that name as it is, and takes no part in clashes.
 */
export function shortProjectNames(projects: readonly LabeledProject[]): Map<string, string> {
  const base = new Map<string, { parts: string[]; name: string; checkout: string | null }>();
  const out = new Map<string, string>();
  for (const project of projects) {
    const given = inboxProjectDisplayName(project);
    if (given !== null) {
      out.set(project.id, given);
      continue;
    }
    const { parts, checkout } = labelPath(project.root);
    const last = parts[parts.length - 1];
    base.set(project.id, { parts, checkout, name: last ? last.normalize('NFC') : project.name });
  }
  const groups = new Map<string, string[]>();
  for (const [id, { name }] of base) groups.set(sameKey(name), [...(groups.get(sameKey(name)) ?? []), id]);
  for (const ids of groups.values()) {
    if (ids.length === 1) {
      out.set(ids[0]!, base.get(ids[0]!)!.name);
      continue;
    }
    // One entry per place (folder): the projects there, told apart by their checkout only.
    const places = new Map<string, string[]>();
    for (const id of ids) {
      const key = sameKey(base.get(id)!.parts.join('/'));
      places.set(key, [...(places.get(key) ?? []), id]);
    }
    const parents = new Map<string, string>();
    if (places.size > 1) {
      const heads = [...places.values()].map((members) => base.get(members[0]!)!.parts);
      // A place's parents `depth` folders up, as written, and as compared.
      const parentsOf = (parts: readonly string[], depth: number) => parts.slice(Math.max(0, parts.length - 1 - depth), parts.length - 1);
      const raw = heads.map((parts) => {
        // The shortest suffix of parents no other place of the name shares (at its whole path, when none is shorter).
        let depth = 1;
        const differs = (d: number) => heads.every((other) => other === parts || sameKey(parentsOf(other, d).join('/')) !== sameKey(parentsOf(parts, d).join('/')));
        while (depth < parts.length - 1 && !differs(depth)) depth += 1;
        return { parts, shown: parentsOf(parts, depth) };
      });
      // A home folder spelled out ("Users/ramos/…") reads "~", unless two places would then read the same.
      const tilde = raw.map(({ parts, shown }) => {
        const home = homeAt(parts);
        const from = parts.length - 1 - shown.length;
        return home >= 0 && home < parts.length - 1 && from <= home ? ['~', ...parts.slice(home + 1, parts.length - 1)].join('/') : shown.join('/');
      });
      const plain = raw.map(({ shown }) => shown.join('/'));
      const readable = new Set(tilde.map(sameKey)).size === tilde.length ? tilde : plain;
      [...places.values()].forEach((members, index) => {
        for (const id of members) parents.set(id, readable[index]!);
      });
    }
    for (const members of places.values()) {
      for (const id of members) {
        const { name, checkout } = base.get(id)!;
        const where = parents.get(id);
        // Only another project in the same place needs the checkout named.
        const own = members.length > 1 && checkout !== null ? ` · ${checkout}` : '';
        out.set(id, `${where ? `${name} · ${where}` : name}${own}`);
      }
    }
  }
  return out;
}

/**
 * The window's one name per project (owner's pick, 2026-10-29): `shortProjectNames` over every project the
 * window draws by name, so a project reads the same in the sidebar and in the rows. The list is held while the
 * person reads (held.ts) and the sidebar is not, so the set is both: the sidebar's projects (`sidebar`) and the
 * projects with a row in the held list (`sections`, a folded Quiet included). A pinned row's project outside that
 * set (an archived thread) is named against the set plus itself, without renaming the set. A project not in
 * `projects` has no entry: the caller falls back to the server's name.
 */
export function windowProjectNames(input: {
  projects: readonly LabeledProject[];
  sidebar: readonly { id: string }[];
  sections: readonly { threads: readonly { project: { id: string } }[] }[];
  pins?: readonly { project: { id: string } }[];
}): Map<string, string> {
  const on = new Set(input.sidebar.map((project) => project.id));
  for (const section of input.sections) for (const row of section.threads) on.add(row.project.id);
  const drawn = input.projects.filter((project) => on.has(project.id));
  const names = shortProjectNames(drawn);
  for (const pin of input.pins ?? []) {
    if (names.has(pin.project.id)) continue;
    const project = input.projects.find((p) => p.id === pin.project.id);
    if (project) names.set(project.id, shortProjectNames([...drawn, project]).get(project.id) ?? project.name);
  }
  return names;
}

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

/** The parts of a path, either separator, without empty ones. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** How two folder names compare for "the same name": as a person reads them. */
function sameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

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
 * Each project's name by id, for the projects given (the ones on screen): its
 * folder's name (its repository's, for a checkout in `worktrees`: `labelPath`),
 * with the fewest parent folders that tell apart the projects whose names
 * clash. Two checkouts of one repository (`appnotes/worktrees/main` and
 * `appnotes/worktrees/fix`) differ only by the checkout, which then names them
 * ("appnotes · main", "appnotes · fix"). A project whose root has no last
 * segment (a filesystem root) keeps `name`.
 */
export function shortProjectNames(projects: readonly { id: string; root: string; name: string }[]): Map<string, string> {
  const base = new Map<string, { parts: string[]; name: string; checkout: string | null }>();
  for (const project of projects) {
    const { parts, checkout } = labelPath(project.root);
    const last = parts[parts.length - 1];
    base.set(project.id, { parts, checkout, name: last ? last.normalize('NFC') : project.name });
  }
  const groups = new Map<string, string[]>();
  for (const [id, { name }] of base) groups.set(sameKey(name), [...(groups.get(sameKey(name)) ?? []), id]);
  const out = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length === 1) {
      out.set(ids[0]!, base.get(ids[0]!)!.name);
      continue;
    }
    const pathKey = (id: string) => sameKey(base.get(id)!.parts.join('/'));
    // Checkouts of one repository and nothing else: the checkout tells them apart.
    if (new Set(ids.map(pathKey)).size === 1 && ids.every((id) => base.get(id)!.checkout !== null)) {
      for (const id of ids) out.set(id, `${base.get(id)!.name} · ${base.get(id)!.checkout}`);
      continue;
    }
    // The fewest parent folders that tell every project of the group apart.
    const parentsOf = (id: string, depth: number) => {
      const { parts } = base.get(id)!;
      return parts.slice(Math.max(0, parts.length - 1 - depth), parts.length - 1).join('/');
    };
    const deepest = Math.max(...ids.map((id) => base.get(id)!.parts.length - 1));
    // Checkouts of one repository share every parent (the checkout tells them apart below): one to tell apart.
    const apart = new Set(ids.map((id) => (base.get(id)!.checkout === null ? `\0${id}` : pathKey(id)))).size;
    let depth = 1;
    while (depth < deepest && new Set(ids.map((id) => sameKey(parentsOf(id, depth)))).size < apart) depth += 1;
    for (const id of ids) {
      const parents = parentsOf(id, depth);
      const { name, checkout } = base.get(id)!;
      // Still the same as another (two checkouts of one repository among others): the checkout too.
      const twin = checkout !== null && ids.some((other) => other !== id && pathKey(other) === pathKey(id));
      out.set(id, `${parents ? `${name} · ${parents}` : name}${twin ? ` · ${checkout}` : ''}`);
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
  projects: readonly { id: string; root: string; name: string }[];
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

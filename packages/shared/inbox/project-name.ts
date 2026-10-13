/**
 * The name the Inbox shows for a project: the real name of its folder, read
 * from the project's stored root, never the history-folder slug the project
 * was created with (`sanitizeTag` keeps only a-z, 0-9 and hyphens and cuts at
 * 30 characters, so a Japanese repository read "project" and a long one ended
 * in a stray hyphen). The slug stays what it is: the project's folder key and
 * its stored `name`. Nothing on disk is rewritten, so a project created before
 * this reads its real name on the next start.
 *
 * When two projects have the same folder name, each also names its parent
 * folder ("api · work", "api · personal"), and as many parents as it takes to
 * tell them apart. Pure.
 */

/** The parts of a path, either separator, without empty ones. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** How two folder names compare for "the same name": as a person reads them. */
function sameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase();
}

/**
 * Each project's display name by id. `name` (the stored slug) is the fallback
 * when the root has no last segment (a filesystem root).
 */
export function inboxProjectLabels(projects: readonly { id: string; root: string; name: string }[]): Map<string, string> {
  const base = new Map<string, { parts: string[]; name: string }>();
  for (const project of projects) {
    const parts = segments(project.root);
    const last = parts[parts.length - 1];
    base.set(project.id, { parts, name: last ? last.normalize("NFC") : project.name });
  }
  const groups = new Map<string, string[]>();
  for (const [id, { name }] of base) {
    const key = sameKey(name);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const labels = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length === 1) {
      labels.set(ids[0]!, base.get(ids[0]!)!.name);
      continue;
    }
    // The fewest parent folders that tell every project of the group apart.
    const parentsOf = (id: string, depth: number) => {
      const { parts } = base.get(id)!;
      return parts.slice(Math.max(0, parts.length - 1 - depth), parts.length - 1).join("/");
    };
    const deepest = Math.max(...ids.map((id) => base.get(id)!.parts.length - 1));
    let depth = 1;
    while (depth < deepest && new Set(ids.map((id) => sameKey(parentsOf(id, depth)))).size < ids.length) depth += 1;
    for (const id of ids) {
      const parents = parentsOf(id, depth);
      const { name } = base.get(id)!;
      labels.set(id, parents ? `${name} · ${parents}` : name);
    }
  }
  return labels;
}

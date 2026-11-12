import { inboxProjectDisplayName } from './inbox-types';

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

function sameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

export type LabeledProject = { id: string; root: string; name: string; display_name?: unknown };

const CHECKOUTS = new Set(['worktrees', '.worktrees']);

export function labelPath(root: string): { parts: string[]; checkout: string | null } {
  const parts = segments(root);
  if (parts.length < 3 || !CHECKOUTS.has(sameKey(parts[parts.length - 2]!))) return { parts, checkout: null };
  let repo = parts.length - 3;
  while (repo >= 0 && parts[repo]!.startsWith('.')) repo -= 1;
  const home = repo >= 1 && ['users', 'home'].includes(sameKey(parts[repo - 1]!)) && (repo === 1 || (repo === 2 && parts[0]!.endsWith(':')));
  if (repo < 0 || home) return { parts, checkout: null };
  return { parts: parts.slice(0, repo + 1), checkout: parts[parts.length - 1]!.normalize('NFC') };
}

function homeAt(parts: readonly string[]): number {
  const at = parts[0]?.endsWith(':') ? 1 : 0;
  if (parts.length <= at + 1 || !['users', 'home'].includes(sameKey(parts[at]!))) return -1;
  return sameKey(parts[at + 1]!) === 'shared' ? -1 : at + 1;
}

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
    const places = new Map<string, string[]>();
    for (const id of ids) {
      const key = sameKey(base.get(id)!.parts.join('/'));
      places.set(key, [...(places.get(key) ?? []), id]);
    }
    const parents = new Map<string, string>();
    if (places.size > 1) {
      const heads = [...places.values()].map((members) => base.get(members[0]!)!.parts);
      const parentsOf = (parts: readonly string[], depth: number) => parts.slice(Math.max(0, parts.length - 1 - depth), parts.length - 1);
      const raw = heads.map((parts) => {
        let depth = 1;
        const differs = (d: number) => heads.every((other) => other === parts || sameKey(parentsOf(other, d).join('/')) !== sameKey(parentsOf(parts, d).join('/')));
        while (depth < parts.length - 1 && !differs(depth)) depth += 1;
        return { parts, shown: parentsOf(parts, depth) };
      });
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
        const own = members.length > 1 && checkout !== null ? ` · ${checkout}` : '';
        out.set(id, `${where ? `${name} · ${where}` : name}${own}`);
      }
    }
  }
  return out;
}

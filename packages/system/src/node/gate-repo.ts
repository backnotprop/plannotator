import { gate, type ChangedFile, type GateResult } from '../gate/gate.ts';
import type { SystemModel } from '../format/types.ts';
import { git } from './git.ts';

/** Parse `git diff --name-status -M -z`: a status, then one path, or two for a rename or a copy. */
export function parseNameStatus(out: string): ChangedFile[] {
  const tok = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tok.length; ) {
    const status = tok[i++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const from = tok[i++]!;
      const path = tok[i++]!;
      // a copy leaves the old file in place: only the new path is new
      files.push(kind === 'R' ? { path, status: 'R', from } : { path, status: 'A' });
    } else {
      const path = tok[i++]!;
      // T (type change) and U (unmerged) are edits of a path that stays
      files.push({ path, status: kind === 'A' || kind === 'D' ? kind : 'M' });
    }
  }
  return files;
}

/** The gate over git: what changed from `from` to `to` in the repo at `root` (read only). */
export async function gateRepo(o: { root: string; from: string; to: string; model: SystemModel }): Promise<GateResult> {
  const out = await git(o.root, ['diff', '--name-status', '-M', '-z', '--no-color', '--no-ext-diff', o.from, o.to]);
  return gate({ files: parseNameStatus(out), model: o.model });
}

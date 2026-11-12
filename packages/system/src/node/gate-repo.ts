import { gate, type ChangedFile, type GateResult } from '../gate/gate.ts';
import type { SystemModel } from '../format/types.ts';
import { checkRef, git } from './git.ts';

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
      files.push(kind === 'R' ? { path, status: 'R', from } : { path, status: 'A' });
    } else {
      const path = tok[i++]!;
      files.push({ path, status: kind === 'A' || kind === 'D' ? kind : 'M' });
    }
  }
  return files;
}

export async function gateRepo(o: { root: string; from: string; to: string; model: SystemModel }): Promise<GateResult> {
  const out = await git(o.root, ['diff', '--name-status', '-M', '-z', '--no-color', '--no-ext-diff', '--end-of-options', checkRef(o.from), checkRef(o.to)]);
  return gate({ files: parseNameStatus(out), model: o.model });
}

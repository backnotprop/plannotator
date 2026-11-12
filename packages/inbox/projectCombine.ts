import { inboxProjectDisplayName } from '@plannotator/core/inbox-types';
import { labelPath, type LabeledProject } from './projectLabels';

export function sameProjectName(a: string, b: string): boolean {
  const key = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return key(a) === key(b);
}

function folderOf(project: LabeledProject): string | null {
  const { parts } = labelPath(project.root);
  return parts[parts.length - 1] ?? null;
}

export function projectNameMatches<T extends LabeledProject>(typed: string, others: readonly T[]): T[] {
  const named = others.filter((other) => sameProjectName(other.name, typed));
  if (named.length > 0) return named;
  return others.filter((other) => {
    if (inboxProjectDisplayName(other) !== null) return false;
    const folder = folderOf(other);
    return folder !== null && sameProjectName(folder, typed);
  });
}

/**
 * Which projects a typed name points at (approval "project-combine"): Rename…
 * asks to combine instead of quietly making two projects with one name. Pure.
 */

import { inboxProjectDisplayName } from '@plannotator/core/inbox-types';
import { labelPath, shortProjectNames, type LabeledProject } from './projectLabels';

/** The projects combined into `project`, named beside it: what Separate says, so a clone reads "billing-svc · old", never its head's name. */
export function memberNames<T extends LabeledProject>(project: LabeledProject, members: readonly T[]): T[] {
  const names = shortProjectNames([project, ...members]);
  return members.map((member) => ({ ...member, name: names.get(member.id) ?? member.name }));
}

/** Two names are the same as a person reads them: case, Unicode form and spaces aside. */
export function sameProjectName(a: string, b: string): boolean {
  const key = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return key(a) === key(b);
}

/** A project's folder name, its repository's for a checkout in `worktrees`. */
function folderOf(project: LabeledProject): string | null {
  const { parts } = labelPath(project.root);
  return parts[parts.length - 1] ?? null;
}

/**
 * The projects `typed` names, among `others`: the ones whose window name it is
 * (case aside). Failing that, the ones whose folder it is, since two clashing
 * projects read "acme · code" and "acme · workspaces" and a person types "acme".
 * A project the person renamed answers to that name only.
 */
export function projectNameMatches<T extends LabeledProject>(typed: string, others: readonly T[]): T[] {
  const named = others.filter((other) => sameProjectName(other.name, typed));
  if (named.length > 0) return named;
  return others.filter((other) => {
    if (inboxProjectDisplayName(other) !== null) return false;
    const folder = folderOf(other);
    return folder !== null && sameProjectName(folder, typed);
  });
}

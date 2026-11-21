/**
 * A project's name as the window shows it. The rule is core's (`@plannotator/core/inbox-project-labels`),
 * the same one the server names projects with for agents, search and `plannotator inbox projects`; the
 * window applies it to the projects on screen only, so an old project no longer listed does not lengthen a
 * name here (the server weighs every stored project). Pure.
 */

import { shortProjectNames, type LabeledProject } from '@plannotator/core/inbox-project-labels';

export { labelPath, shortProjectNames, type LabeledProject } from '@plannotator/core/inbox-project-labels';

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

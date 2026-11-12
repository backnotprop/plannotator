import { shortProjectNames, type LabeledProject } from '@plannotator/core/inbox-project-labels';

export { labelPath, shortProjectNames, type LabeledProject } from '@plannotator/core/inbox-project-labels';

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

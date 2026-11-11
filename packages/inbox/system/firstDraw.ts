import type { SystemSetup, SystemSetupProject } from '@plannotator/core/inbox-system-setup';

/** TODO(B5): start the agent with `firstDrawPrompt` (packages/system) through launch and open the drawing in Reviews. */
export function startFirstDrawing(_project: SystemSetupProject, _setup: SystemSetup): void {}

/** TODO(B5/A6): use packages/system's `firstDrawPrompt` once it lands; this is a placeholder. */
export function systemFirstDrawPrompt(project: Pick<SystemSetupProject, 'name' | 'root' | 'repo' | 'drawing'>, setup: Pick<SystemSetup, 'repos' | 'docs' | 'model'>): string {
  const lines = [
    `[Placeholder: the System drawing recipe is not in this build yet.]`,
    ...(setup.model ? [`Use the model ${setup.model}.`] : []),
    `Draw the system of ${project.name} (${project.root}) into ${project.drawing}.`,
    `Read the code of ${[project.repo, ...setup.repos].join(', ')}.`,
  ];
  if (setup.docs.length > 0) lines.push(`Read the doc sites ${setup.docs.join(', ')}.`);
  return lines.join('\n');
}

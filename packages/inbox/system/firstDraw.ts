import type { SystemSetup, SystemSetupProject } from '@plannotator/core/inbox-system-setup';

export function startFirstDrawing(_project: SystemSetupProject, _setup: SystemSetup): void {}

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

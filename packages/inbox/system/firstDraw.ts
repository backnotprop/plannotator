import type { SystemSetup, SystemSetupProject } from '@plannotator/core/inbox-system-setup';

/**
 * Draw it: starts the first drawing through launch (step B5: the live pane, the agent's thread).
 * TODO(B5): start the agent with `firstDrawPrompt` (packages/system) through launch and open the drawing in Reviews.
 * Until then the dialog saves setup.json and closes.
 */
export function startFirstDrawing(_project: SystemSetupProject, _setup: SystemSetup): void {}

/**
 * The prompt Copy prompt copies when launch is off, for the person to give their own agent in the project.
 * TODO(B5/A6 firstDrawPrompt): use packages/system's `firstDrawPrompt({ project, worktree, repos, docs })` once it lands.
 * Until then a placeholder that names the project and what to read.
 */
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

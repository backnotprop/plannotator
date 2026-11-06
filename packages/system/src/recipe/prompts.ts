// The prompts an agent is given: the facts of one job, then the recipe, then
// the format reference. Pure text, browser-safe, so the Inbox window can build
// the first-draw prompt for Copy prompt as the server builds it for launch.
import type { GateResult } from '../gate/gate.ts';
import type { SystemSetup } from '../agent/setup.ts';
import { DRAW, FORMAT, REVIEW, UPDATE } from './text.ts';

/** The recipes as Markdown: draw once, redraw when main moves, draw an open pull request's change; and the format they share. */
export const recipes = { draw: DRAW, update: UPDATE, review: REVIEW, format: FORMAT } as const;

/** The branch a first drawing is written on, in its own worktree. */
export const DRAW_BRANCH = 'plannotator/system';
/** The branch every redraw is written on; one open pull request at a time. */
export const REDRAW_BRANCH = 'plannotator/system-redraw';

/** Text from a repo or a person (a path, a name) on one line, so it cannot start a line of its own in a prompt. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
const list = (items: readonly string[], none: string) => (items.length ? items.map((i) => `  - ${oneLine(i)}`).join('\n') : `  - ${none}`);

/**
 * The prompt that starts a project's first drawing, for the agent the person
 * picked. `projectRoot` is the person's own checkout, read and never edited.
 * `worktree` is the folder to write in, a git worktree of the project on
 * `plannotator/system` (the Inbox makes it at
 * `<PLANNOTATOR_DATA_DIR>/system/<project key>/worktree`); with none the agent
 * makes one of its own. `repo` is the project's own repo, `host/owner/name`;
 * `name` the project's name.
 */
export function firstDrawPrompt(
  setup: Pick<SystemSetup, 'repos' | 'docs'>,
  projectRoot: string,
  o: { worktree?: string; name?: string; repo?: string } = {},
): string {
  const name = oneLine(o.name ?? (projectRoot.replace(/\/+$/, '').split('/').pop() || 'the project'));
  const facts = [
    `# The job: the first drawing of ${name}`,
    '',
    `- The project: ${name}.`,
    `- The project folder, the person's own checkout (read it, never edit it): ${oneLine(projectRoot)}`,
    o.worktree
      ? `- The worktree to write in, on branch ${DRAW_BRANCH}: ${oneLine(o.worktree)}`
      : `- The worktree to write in: none yet. Make one in a new empty folder outside the project, on branch ${DRAW_BRANCH} (step 1).`,
    `- This repo: ${o.repo ? oneLine(o.repo) : 'read it from `git remote get-url origin` in the project folder'}. In system.yaml it is \`self\`.`,
    '- Other repos to read:',
    list(setup.repos, 'none'),
    '- Doc sites to read:',
    list(setup.docs, 'none'),
  ];
  return [facts.join('\n'), DRAW, FORMAT].join('\n\n');
}

export type UpdatePromptInput = {
  /** The redraw worktree, on REDRAW_BRANCH at `to`. */
  worktree: string;
  /** The last commit the drawing was right for. */
  from: string;
  /** The new commit on the default branch. */
  to: string;
  /** Pull request numbers that landed between from and to, read from the merge commits. */
  prs: number[];
  gate: Pick<GateResult, 'why' | 'touched'>;
  /** Reviews stored while those pull requests were open, by number. */
  reviews: { pr: number; path: string }[];
  /** Where the agent writes its one sentence per changed sheet. */
  summaryFile: string;
  /** Doc sites already passed through `unattendedDocs`. */
  docs: string[];
};

/** The prompt for one unattended redraw. */
export function updatePrompt(o: UpdatePromptInput): string {
  const facts = [
    '# The job: redraw after main moved',
    '',
    `- The worktree, already on branch ${REDRAW_BRANCH} at the new commit: ${oneLine(o.worktree)}`,
    `- From (the last commit the drawing was right for): ${oneLine(o.from)}`,
    `- To (the new commit; set sources.repos.self.at to it): ${oneLine(o.to)}`,
    '- Merged pull requests in that range:',
    list(o.prs.map((n) => `PR ${n}`), 'none named in the merge commits'),
    '- Why you were woken (a changed file and its reason):',
    list(o.gate.why.map((w) => `${w.path} (${w.reason})`), 'nothing named'),
    '- Parts that cite a changed file:',
    list(o.gate.touched.parts, 'none'),
    '- Lines that cite a changed file:',
    list(o.gate.touched.flows, 'none'),
    '- Stored reviews of those pull requests:',
    list(o.reviews.map((r) => `PR ${r.pr}: ${r.path}`), 'none'),
    `- The summary file: ${oneLine(o.summaryFile)}`,
    '- Doc sites you may read:',
    list(o.docs, 'none'),
  ];
  return [facts.join('\n'), UPDATE, FORMAT].join('\n\n');
}

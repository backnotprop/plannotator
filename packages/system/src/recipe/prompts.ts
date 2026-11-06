// The prompts an agent is given: the facts of one job, then the recipe, then
// the format reference. Pure text, browser-safe, so the Inbox window can build
// the first-draw prompt for Copy prompt as the server builds it for launch.
import type { GateResult } from '../gate/gate.ts';
import type { SystemSetup } from '../agent/setup.ts';
import { DRAW, FORMAT, REVIEW, UPDATE } from './text.ts';

/** The recipes as Markdown: draw once, redraw when main moves, draw an open pull request's change; and the format they share. */
export const recipes = { draw: DRAW, update: UPDATE, review: REVIEW, format: FORMAT } as const;

/** Text from a repo or a person (a path, a name) on one line, so it cannot start a line of its own in a prompt. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
const list = (items: readonly string[], none: string) => (items.length ? items.map((i) => `  - ${oneLine(i)}`).join('\n') : `  - ${none}`);

/**
 * The prompt that starts a project's first drawing, for the agent the person
 * picked. `projectRoot` is the person's own checkout, read and never edited.
 * `drawing` is the folder to write the drawing in
 * (`<PLANNOTATOR_DATA_DIR>/system/<project key>/drawing`) and `source` a
 * clone of the project to read the code in (`.../source`, made by
 * `prepareSource`); with none named the agent makes its own (owner ruling
 * 2026-11-06, q-122e6577: nothing is written in the person's repo). `repo` is
 * the project's own repo, `host/owner/name`;
 * `name` the project's name. `setup.thread_message`, when the Inbox started
 * the drawing's thread, is the message both of the agent's messages reply to,
 * the one every later redraw note replies to too; with none, the agent's
 * first message starts the thread.
 */
export function firstDrawPrompt(
  setup: Pick<SystemSetup, 'repos' | 'docs'> & Partial<Pick<SystemSetup, 'thread_message'>>,
  projectRoot: string,
  o: { drawing?: string; source?: string; name?: string; repo?: string } = {},
): string {
  const name = oneLine(o.name ?? (projectRoot.replace(/\/+$/, '').split('/').pop() || 'the project'));
  const facts = [
    `# The job: the first drawing of ${name}`,
    '',
    `- The project: ${name}.`,
    `- The project folder, the person's own checkout (read it, never edit it): ${oneLine(projectRoot)}`,
    o.drawing
      ? `- The drawing folder, to write the drawing in: ${oneLine(o.drawing)}`
      : '- The drawing folder: none named. Use a new empty folder of your own outside the project, and name it in your last message.',
    o.source
      ? `- The source folder, a clone of the project to read the code in: ${oneLine(o.source)}`
      : '- The source folder: none yet. Make one in a new empty folder outside the project (step 1).',
    `- This repo: ${o.repo ? oneLine(o.repo) : 'read it from `git remote get-url origin` in the project folder'}. In system.yaml it is \`self\`.`,
    '- Other repos to read:',
    list(setup.repos, 'none'),
    '- Doc sites to read:',
    list(setup.docs, 'none'),
    setup.thread_message
      ? `- The drawing's Inbox thread: reply to message ${oneLine(setup.thread_message)} with both of your messages (\`reply_to\`).`
      : `- The drawing's Inbox thread: none yet. Your first message starts it, with the subject "System: ${name}"; your last is a reply to the first.`,
  ];
  return [facts.join('\n'), DRAW, FORMAT].join('\n\n');
}

export type UpdatePromptInput = {
  /** The source clone, at `to`, where the agent reads the code. */
  source: string;
  /** The copy of the drawing the agent edits. */
  drawing: string;
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
    `- The source folder, a clone of the project already at the new commit: ${oneLine(o.source)}`,
    `- The drawing folder, to edit the drawing in: ${oneLine(o.drawing)}`,
    `- From (the last commit the drawing was checked against: its sources.repos.self.at, or a later commit the check found nothing to redraw for; the range may hold the drawing's own commits): ${oneLine(o.from)}`,
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

export type ReviewPromptInput = {
  /** The person's own checkout of the project. */
  project: string;
  /** The project's drawing folder (`<PLANNOTATOR_DATA_DIR>/system/<project key>/drawing`). */
  drawing: string;
  /** The pull request, `host/owner/repo#n`. */
  pr: string;
  /** Its head commit. */
  head: string;
  /** Its base branch, without the remote (`main`). */
  base: string;
  /** The project's name; the folder's name when not given. */
  name?: string;
};

/** The prompt that has an agent draw an open pull request's change: the five facts, then REVIEW.md, then the format. */
export function reviewPrompt(o: ReviewPromptInput): string {
  const name = oneLine(o.name ?? (o.project.replace(/\/+$/, '').split('/').pop() || 'the project'));
  const facts = [
    `# The job: draw pull request ${oneLine(o.pr)} on the system of ${name}`,
    '',
    `- The project folder: ${oneLine(o.project)}`,
    `- The drawing folder: ${oneLine(o.drawing)}`,
    `- The pull request: ${oneLine(o.pr)}`,
    `- Its head commit: ${oneLine(o.head)}`,
    `- Its base branch: ${oneLine(o.base)}`,
  ];
  return [facts.join('\n'), REVIEW, FORMAT].join('\n\n');
}

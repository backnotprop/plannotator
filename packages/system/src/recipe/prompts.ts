import type { GateResult } from '../gate/gate.ts';
import type { SystemSetup } from '../agent/setup.ts';
import { DRAW, FORMAT, REVIEW, UPDATE } from './text.ts';

export const recipes = { draw: DRAW, update: UPDATE, review: REVIEW, format: FORMAT } as const;

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
const list = (items: readonly string[], none: string) => (items.length ? items.map((i) => `  - ${oneLine(i)}`).join('\n') : `  - ${none}`);

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
  source: string;
  drawing: string;
  from: string;
  to: string;
  prs: number[];
  gate: Pick<GateResult, 'why' | 'touched'>;
  reviews: { pr: number; path: string }[];
  summaryFile: string;
  docs: string[];
};

export function updatePrompt(o: UpdatePromptInput): string {
  const facts = [
    '# The job: redraw after main moved',
    '',
    `- The source folder, a clone of the project already at the new commit: ${oneLine(o.source)}`,
    `- The drawing folder, to edit the drawing in: ${oneLine(o.drawing)}`,
    `- From (the last commit the drawing was checked against: its sources.repos.self.at, or a later commit the check found nothing to redraw for): ${oneLine(o.from)}`,
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
  project: string;
  drawing: string;
  pr: string;
  head: string;
  base: string;
  name?: string;
};

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

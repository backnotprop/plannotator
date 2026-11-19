/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; concept B take 1): the words the list and the stack view say, from
 * the server's answer and core's rules (`@plannotator/core/inbox-pulls`).
 * Pure, so the tests read them without a window.
 */
import {
  inboxPullGroups,
  inboxPullIsOpen,
  inboxPullItems,
  inboxPullLabel,
  inboxPullStacks,
  type InboxPull,
  type InboxPullGroups,
  type InboxPullItem,
  type InboxPullLink,
  type InboxPullsAnswer,
  type InboxPullStack,
} from '@plannotator/core/inbox-types';
import { openLayers } from '@plannotator/core/inbox-pull-handoff';
import { agentName } from '../tags';
import { startLayer } from './topology';
import { person, possessiveTail, wordsText, type Words } from './words';

export * from '@plannotator/core/inbox-pull-handoff';

export { inboxPullLabel };

/**
 * The list's views (approval "pr-list-filters", round 7 take B): every open PR in the Inbox projects' repositories
 * (`all`), the person's own (`mine`), the ones asked of them (`review`: a review requested, directly or through a
 * team, or assigned to them), and everyone else's (`others`). Each PR is in exactly one of the last three.
 */
export type PullFilter = 'all' | 'mine' | 'review' | 'others';

/** The views in the menu's order, with their words. */
export const PULL_FILTERS: readonly (readonly [PullFilter, string])[] = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['review', 'To review'],
  ['others', 'Others'],
];

export function pullFilterWords(filter: PullFilter): string {
  return PULL_FILTERS.find(([value]) => value === filter)![1];
}

/** A view from the address (`&view=`); anything else is All. */
export function pullFilterOf(value: string | null | undefined): PullFilter {
  return PULL_FILTERS.some(([v]) => v === value) && value ? (value as PullFilter) : 'all';
}

/** The one view a PR is in: the person wrote it, else it is asked of them, else it is someone else's. */
export function pullViewOf(pull: Pick<InboxPull, 'mine' | 'requested' | 'assigned'>): Exclude<PullFilter, 'all'> {
  if (pull.mine) return 'mine';
  if (pull.requested || pull.assigned) return 'review';
  return 'others';
}

/**
 * Reviews' project rule, the board's too (`reviewRowsIn`, `pullGroups`, `boardInProject`): a PR is in a project when
 * its repository is a clone of the project (the repository-to-project map; two clones of one origin are two projects),
 * when its head is (a fork-based project: the clone is the person's fork, the PR goes to upstream), or when its thread
 * (its review, hand-off or report: `threadProject`) is in the project.
 */
export function pullInProject(pull: Pick<InboxPull, 'host' | 'repo' | 'head_repo'>, project: string, projects: Readonly<Record<string, readonly string[]>>, threadProject?: string | null): boolean {
  if (threadProject === project) return true;
  if ((projects[`${pull.host}/${pull.repo}`.toLowerCase()] ?? []).includes(project)) return true;
  return !!pull.head_repo && (projects[`${pull.host}/${pull.head_repo}`.toLowerCase()] ?? []).includes(project);
}

/**
 * The answer as the page shows it: the rows by whose move it is, only the chosen project's when one is, and only the
 * chosen view's. A stack stays whole: it is built from every PR, then kept when any open layer is in the view.
 */
export function pullGroups(answer: InboxPullsAnswer, project: string | null, filter: PullFilter = 'all'): InboxPullGroups {
  const pulls = project ? answer.pulls.filter((p) => pullInProject(p, project, answer.projects, answer.links[p.key]?.project_id)) : answer.pulls;
  const stacks = inboxPullStacks(pulls).filter((stack) => filter === 'all' || stack.layers.some((l) => isOpenPull(l) && pullViewOf(l) === filter));
  return inboxPullGroups(inboxPullItems(stacks, (pull) => !!answer.links[pull.key]));
}

/** How many rows a view (in a project, or every one) shows: the menu's counts. */
export function pullCount(answer: InboxPullsAnswer, project: string | null, filter: PullFilter): number {
  const groups = pullGroups(answer, project, filter);
  return groups.on_you.length + groups.ready.length + groups.waiting.length;
}

/** What the list says when a view (not All) has nothing in it. */
export function pullFilterEmptyWords(filter: Exclude<PullFilter, 'all'>): { head: string; line: string } {
  switch (filter) {
    case 'mine':
      return { head: 'Nothing of yours open', line: 'Pull requests you opened show here.' };
    case 'review':
      return { head: 'Nothing to review', line: 'Pull requests where your review is asked for, or that are assigned to you, show here.' };
    case 'others':
      return { head: 'Nothing else open', line: 'Open pull requests by others in your projects show here.' };
  }
}

/** Every row, in the page's order (On you, Ready to land, then the folded ones). */
export function pullRows(groups: InboxPullGroups): InboxPullItem[] {
  return [...groups.on_you, ...groups.ready, ...groups.waiting];
}

/** Open or a draft: a PR still to land (core's `inboxPullIsOpen`, the one rule the server and the stacks use too). */
export const isOpenPull = inboxPullIsOpen;


/** The agent's name as the Inbox writes it ("Claude Code", "Codex"), or the name it gave itself. */
export function linkAgentName(link: InboxPullLink | null): string | null {
  if (!link?.agent) return null;
  return link.agent.name?.trim() || agentName(link.agent.host);
}


/** The Inbox projects a stack's repository is (two clones of one origin are two). */
export function stackProjects(answer: Pick<InboxPullsAnswer, 'projects'>, stack: Pick<InboxPullStack, 'host' | 'repo'>): readonly string[] {
  return answer.projects[`${stack.host}/${stack.repo}`.toLowerCase()] ?? [];
}

/** The PRs a hand-off gives the agent: the open layers of the stack it is about (`handoffStack`). */
export function handoffKeys(stack: InboxPullStack): string[] {
  return openLayers(stack).map((l) => l.key);
}



/**
 * A thread started from a PR's page (Start a thread): its link has the `thread` ask, or the `page` mark once that thread
 * asked for a guided review; its row and page open the thread.
 */
export const isPullThread = (link: Pick<InboxPullLink, 'via' | 'ask' | 'page'> | null | undefined): boolean => link?.via === 'owner' && (link.ask === 'thread' || link.page === true);


/** A PR the person's review was asked for (the owner's words): "Review requested · tomas's PR", or "Review requested" with no author. */
export const requestedParts = (author: string | null | undefined): Words => (author ? ['Review requested · ', person(author, "'s"), ' PR'] : ['Review requested']);

export const requestedWords = (author: string | null | undefined): string => wordsText(requestedParts(author));

/** Why a PR is where it is, in words ("Review requested · tomas's PR"). */
export function reasonWords(item: Pick<InboxPullItem, 'reason' | 'focus'>, link: InboxPullLink | null): string {
  return wordsText(reasonParts(item, link));
}

/** `reasonWords` in parts: the people it names stay people (`words.ts`). */
export function reasonParts(item: Pick<InboxPullItem, 'reason' | 'focus'>, link: InboxPullLink | null): Words {
  const pull = item.focus;
  switch (item.reason) {
    case 'requested':
      return requestedParts(pull.author);
    case 'assigned':
      return ['Assigned to you'];
    case 'agent_ready': {
      // Its review thread (the person's ask, or the agent's own thread that names it); the agent unnamed, only the ask.
      const name = linkAgentName(link);
      return [name ? `${agentThreadWords(name, link?.agent?.ended === true)} · your review` : 'Your review'];
    }
    case 'running':
      return ['Checks running'];
    case 'changes':
      return ['Changes requested'];
    case 'failing':
      return ['Checks failed'];
    case 'conflicts':
      return ['Has conflicts'];
    case 'approved':
      return [...(pull.approved_by ? [person(pull.approved_by), ' approved'] : ['Approved']), ...(pull.checks === 'success' ? [' · checks passed'] : [])];
    case 'approved_running':
      return ['Approved · checks running'];
    case 'draft':
      return ['Draft'];
    case 'review':
      return pull.reviewers[0] ? ['Waiting on ', person(pull.reviewers[0], possessiveTail(pull.reviewers[0])), ' review'] : ['Waiting on review'];
    case 'others':
      return pull.author ? ['Waiting on ', person(pull.author)] : ['Waiting on others'];
    case 'merged':
      return ['Merged'];
    case 'closed':
      return ['Closed'];
  }
}

/** A row's third line in parts: what it is ("#412", "3 open, 1 merged"), its review thread's agent, and why it waits. */
export interface RowMeta {
  lead: string;
  /** The agent of its review thread ("Review thread with Claude Code"), drawn with its mark; null when none is. */
  agent: { name: string; host: string | null; words: string } | null;
  rest: string;
}

/**
 * The review thread's agent in words: "Review thread with Claude Code", or "Claude Code ended" once its session ended.
 * The same whether the person asked for the review or the agent's own thread names the PR: one thread either way.
 */
export function agentThreadWords(name: string, ended: boolean): string {
  return ended ? `${name} ended` : `Review thread with ${name}`;
}

/**
 * A row's third line: "#48201 · Review thread with Claude Code · checks running", "3 open, 1 merged · Codex ended ·
 * start at #412". The agent follows what the row is, before why it waits.
 */
export function rowMeta(item: InboxPullItem, link: InboxPullLink | null): RowMeta {
  const name = link?.agent ? linkAgentName(link) : null;
  const agent = name && link?.agent ? { name, host: link.agent.host, words: agentThreadWords(name, link.agent.ended === true) } : null;
  // Mid-line the reason starts lower case, but never an agent's name.
  const why = item.reason === 'agent_ready' ? (agent ? 'your review' : reasonWords(item, link)) : reasonWords(item, link).replace(/^./, (c) => c.toLowerCase());
  if (item.stack.layers.length === 1) return { lead: inboxPullLabel(item.focus), agent, rest: why };
  const open = openLayers(item.stack);
  const merged = item.stack.layers.filter((l) => l.state === 'merged').length;
  const counts = `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`;
  const start = startLayer(item.stack);
  return { lead: counts, agent, rest: item.move === 'on_you' && start ? `start at ${inboxPullLabel(start)}` : why };
}

/** The row's third line as one string (what a screen reader and the tests read). */
export function rowLine(item: InboxPullItem, link: InboxPullLink | null): string {
  const meta = rowMeta(item, link);
  return [meta.lead, meta.agent?.words ?? null, meta.rest].filter(Boolean).join(' · ');
}

/** A layer's status pill in the stack view, or null for none. */
export function layerPill(pull: InboxPull): { text: string; tone: 'you' | 'ok' | 'quiet' | 'bad' } | null {
  if (pull.state === 'merged' || pull.state === 'closed') return null;
  if (pull.state === 'draft') return { text: 'Draft', tone: 'quiet' };
  if (pull.requested && !pull.mine) return { text: 'Your review', tone: 'you' };
  if (pull.assigned && !pull.mine) return { text: 'Assigned to you', tone: 'you' };
  if (pull.review === 'changes_requested') return { text: 'Changes requested', tone: 'bad' };
  if (pull.conflicts === true) return { text: 'Conflicts', tone: 'bad' };
  if (pull.review === 'approved') return { text: 'Approved', tone: 'ok' };
  if (pull.mine) return { text: 'Your review', tone: 'you' };
  return { text: 'No reviews yet', tone: 'quiet' };
}

/** The checks in words, or null when none ran. */
export function checksWords(pull: Pick<InboxPull, 'checks'>): string | null {
  return pull.checks === 'success' ? 'Checks passed' : pull.checks === 'failure' ? 'Checks failed' : pull.checks === 'pending' ? 'Checks running' : null;
}

/** "pull request" / "merge request". */
export function pullNounWord(platform: InboxPull['platform']): 'pull request' | 'merge request' {
  return platform === 'gitlab' ? 'merge request' : 'pull request';
}

/** The stack view's ladder heading: "Landing order" for more than one layer, else "Pull request" / "Merge request". */
export function ladderHeading(stack: InboxPullStack): string {
  if (stack.layers.length > 1) return 'Landing order';
  return stack.platform === 'gitlab' ? 'Merge request' : 'Pull request';
}

/** The stack (and its row) holding a PR or a stack id. */
export function findStack(groups: InboxPullGroups, id: string): InboxPullItem | null {
  return pullRows(groups).find((item) => item.stack.id === id || item.stack.layers.some((l) => l.key === id)) ?? null;
}

/** What a review in the Inbox is of: one layer, or the stack from its base up to a layer. */
export interface PullReviewTarget {
  pull: Pick<InboxPull, 'platform' | 'number' | 'title' | 'url'>;
  scope: 'layer' | 'stack';
  /** The stack's base branch (the stack scope's start). */
  base: string;
}

/** "pull request #412" / "merge request !61". */
function pullNoun(pull: Pick<InboxPull, 'platform' | 'number'>): string {
  return `${pull.platform === 'gitlab' ? 'merge request' : 'pull request'} ${inboxPullLabel(pull)}`;
}

/** The review's subject in the reply: one line, the title cut to 120 characters. */
function pullSubject(target: PullReviewTarget): string {
  const title = target.pull.title.replace(/\s+/g, ' ').trim();
  const cut = title.length > 120 ? `${title.slice(0, 119)}…` : title;
  const what = target.scope === 'stack' ? `the stack from ${target.base} up to ${pullNoun(target.pull)}` : pullNoun(target.pull);
  return `${what} "${cut}" (${target.pull.url})`;
}

/**
 * What a hand-off sent from compose (+ New agent) asked for: a guided review when the words still hold the guided
 * step 1 (`ask_line`, `pullHandoffAskLine`) as a line of its own, else a custom curation. A line, not a substring: a
 * guided step 1 edited in compose, or one with the person's words after `/review-curate`, is a custom curation.
 */
export function pullLaunchAsk(body: string, askLine: string): 'guide' | 'custom' {
  const wanted = askLine.trim();
  return wanted !== '' && body.split('\n').some((line) => line.trim() === wanted) ? 'guide' : 'custom';
}

/**
 * The person's verdict on a PR layer (or a stack), as the reply into the
 * agent's thread: the verdict words, the note, then the comments in the
 * review app's export (`guideCommentSections`), under "Feedback on <noun>".
 * DRAFT agent text (REPORT.md): the words reach the agent as the person's reply.
 * `skills` (`verdictRecheckBlock`) goes last in the feedback.
 */
export function pullVerdictReply(
  verdict: 'approved' | 'changes_requested',
  target: PullReviewTarget,
  comments: number,
  sections: string,
  note?: string,
  skills = '',
): { words: string; feedback?: string } {
  const subject = pullSubject(target);
  const count = comments === 1 ? 'a comment' : `${comments} comments`;
  const lead =
    verdict === 'approved'
      ? comments > 0
        ? `I approved ${subject}, with ${count} below. Nothing in them blocks it.`
        : `I approved ${subject}.`
      : comments > 0
        ? `I reviewed ${subject} and I am asking for changes: ${comments === 1 ? 'my comment is' : `my ${comments} comments are`} below.`
        : `I reviewed ${subject} and I am asking for changes.`;
  const words = [lead, note?.trim() ?? ''].filter((part) => part !== '').join('\n\n');
  if (comments === 0) return skills ? { words, feedback: skills } : { words };
  const noun = pullNoun(target.pull);
  const feedback = `# Feedback on ${noun}\n\nThe following comments are on the diff of ${subject}, one section per file. Line numbers are the file's own: (new) the changed file, (old) the original.\n\n${sections}`.trim();
  return { words, feedback: skills ? `${feedback}\n\n${skills}` : feedback };
}

/**
 * Whether a PR verdict, which goes to the agent that last wrote in the thread (`link.last`), reaches the live session
 * that sent the thread's latest review: only that one is asked for just what changed since.
 */
export function pullVerdictToReviewer(link: Pick<InboxPullLink, 'agent' | 'guide'> | null): boolean {
  const reviewer = link?.guide?.review ? link.guide.session : null;
  return !!reviewer && !!link?.agent && !link.agent.ended && link.agent.session === reviewer;
}

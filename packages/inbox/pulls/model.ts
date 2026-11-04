/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; concept B take 1): the words the list and the stack view say, from
 * the server's answer and core's rules (`@plannotator/core/inbox-pulls`).
 * Pure, so the tests read them without a window.
 */
import {
  inboxPullGroups,
  inboxPullItems,
  inboxPullLabel,
  inboxPullLandsNext,
  inboxPullStacks,
  type InboxPull,
  type InboxPullGroups,
  type InboxPullItem,
  type InboxPullLink,
  type InboxPullsAnswer,
  type InboxPullStack,
} from '@plannotator/core/inbox-types';
import { agentName } from '../tags';

export { inboxPullLabel };

/** The answer as the page shows it: the rows by whose move it is, only the chosen project's when one is. */
export function pullGroups(answer: InboxPullsAnswer, project: string | null): InboxPullGroups {
  const projectOf = (pull: InboxPull) => answer.projects[`${pull.host}/${pull.repo}`.toLowerCase()] ?? null;
  const pulls = project ? answer.pulls.filter((p) => projectOf(p) === project) : answer.pulls;
  const stacks = inboxPullStacks(pulls);
  return inboxPullGroups(inboxPullItems(stacks, (pull) => !!answer.links[pull.key]));
}

/** Every row, in the page's order (On you, Ready to land, then the folded ones). */
export function pullRows(groups: InboxPullGroups): InboxPullItem[] {
  return [...groups.on_you, ...groups.ready, ...groups.waiting];
}

/** The agent's thread behind a stack: the topmost open layer's link, else any layer's. */
export function stackLink(stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>>): InboxPullLink | null {
  for (let i = stack.layers.length - 1; i >= 0; i--) {
    const layer = stack.layers[i]!;
    if ((layer.state === 'open' || layer.state === 'draft') && links[layer.key]) return links[layer.key]!;
  }
  return stack.layers.map((l) => links[l.key]).find((l): l is InboxPullLink => !!l) ?? null;
}

/**
 * Where a verdict on one layer goes: that layer's own agent thread, else the stack's (among the person's own
 * layers only); null for a teammate's PR, which never takes a verdict here (the person reviews it on the forge).
 */
export function layerVerdictLink(layer: InboxPull, stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>>): InboxPullLink | null {
  if (!layer.mine) return null;
  if (links[layer.key]) return links[layer.key]!;
  for (let i = stack.layers.length - 1; i >= 0; i--) {
    const other = stack.layers[i]!;
    if (other.mine && (other.state === 'open' || other.state === 'draft') && links[other.key]) return links[other.key]!;
  }
  return null;
}

/** The agent's name as the Inbox writes it ("Claude Code", "Codex"), or the name it gave itself. */
export function linkAgentName(link: InboxPullLink | null): string | null {
  if (!link?.agent) return null;
  return link.agent.name?.trim() || agentName(link.agent.host);
}

/** The stack's name: its Board card's title, else its thread's subject, else its lowest open layer's title. */
export function stackTitle(stack: InboxPullStack, link: InboxPullLink | null): string {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  if (open.length === 1) return open[0]!.title;
  return link?.card?.title || link?.thread_subject || (inboxPullLandsNext(stack) ?? stack.layers[stack.layers.length - 1]!).title;
}

/** The repository's own name (`billing-svc` for `northwind/billing-svc`). */
export function repoName(repo: string): string {
  return repo.slice(repo.lastIndexOf('/') + 1);
}

/** "Open on GitHub" / "Open on GitLab". */
export function forgeName(stack: Pick<InboxPullStack, 'platform'>): string {
  return stack.platform === 'gitlab' ? 'GitLab' : 'GitHub';
}

const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** Why a PR is where it is, in words ("Tomas asked for your review"). */
export function reasonWords(item: Pick<InboxPullItem, 'reason' | 'focus'>, link: InboxPullLink | null): string {
  const pull = item.focus;
  switch (item.reason) {
    case 'requested':
      return pull.author ? `${pull.author} asked for your review` : 'Your review was asked for';
    case 'agent_ready':
      return `${linkAgentName(link) ?? 'Your agent'} opened it · your review`;
    case 'running':
      return 'Checks running';
    case 'changes':
      return 'Changes requested';
    case 'failing':
      return 'Checks failed';
    case 'approved':
      return `${pull.approved_by ?? 'Approved'}${pull.approved_by ? ' approved' : ''}${pull.checks === 'success' ? ' · checks passed' : ''}`;
    case 'approved_running':
      return 'Approved · checks running';
    case 'draft':
      return 'Draft';
    case 'review':
      return pull.reviewers[0] ? `Waiting on ${possessive(pull.reviewers[0])} review` : 'Waiting on review';
    case 'others':
      return pull.author ? `Waiting on ${pull.author}` : 'Waiting on others';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
  }
}

/** A stack row's third line: "3 open, 1 merged · start at #412" (a stack of one says why it waits, after its number). */
export function rowLine(item: InboxPullItem, link: InboxPullLink | null): string {
  const open = item.stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  if (item.stack.layers.length === 1) return `${inboxPullLabel(item.focus)} · ${reasonWords(item, link).replace(/^./, (c) => c.toLowerCase())}`;
  const merged = item.stack.layers.filter((l) => l.state === 'merged').length;
  const counts = `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`;
  const start = startLayer(item.stack);
  if (item.move === 'on_you' && start) return `${counts} · start at ${inboxPullLabel(start)}`;
  return `${counts} · ${reasonWords(item, link).replace(/^./, (c) => c.toLowerCase())}`;
}

/** Where "Review layer by layer" starts: the next layer to land that is not a draft, else the next to land. */
export function startLayer(stack: InboxPullStack): InboxPull | null {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  return open.find((l) => l.state === 'open') ?? open[0] ?? null;
}

/** A layer's status pill in the stack view, or null for none. */
export function layerPill(pull: InboxPull): { text: string; tone: 'you' | 'ok' | 'quiet' | 'bad' } | null {
  if (pull.state === 'merged' || pull.state === 'closed') return null;
  if (pull.state === 'draft') return { text: 'Draft', tone: 'quiet' };
  if (pull.requested && !pull.mine) return { text: 'Your review', tone: 'you' };
  if (pull.review === 'changes_requested') return { text: 'Changes requested', tone: 'bad' };
  if (pull.review === 'approved') return { text: 'Approved', tone: 'ok' };
  if (pull.mine) return { text: 'Your review', tone: 'you' };
  return { text: 'No reviews yet', tone: 'quiet' };
}

/** The checks in words, or null when none ran. */
export function checksWords(pull: Pick<InboxPull, 'checks'>): string | null {
  return pull.checks === 'success' ? 'Checks passed' : pull.checks === 'failure' ? 'Checks failed' : pull.checks === 'pending' ? 'Checks running' : null;
}

/** "After #412" (on another layer), "Based on main" (the next to land), or null. */
export function layerBaseWords(pull: InboxPull, stack: InboxPullStack): string | null {
  const under = stack.layers.find((l) => l.head === pull.base && l.key !== pull.key);
  if (under && under.state !== 'merged') return `After ${inboxPullLabel(under)}`;
  if (under) return `On ${inboxPullLabel(under)}, merged`;
  return inboxPullLandsNext(stack)?.key === pull.key && stack.layers.length > 1 ? `Based on ${pull.base}` : null;
}

/** The layer after this one in landing order, among the open ones; null at the top. */
export function nextLayer(stack: InboxPullStack, key: string): InboxPull | null {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  const at = open.findIndex((l) => l.key === key);
  return at >= 0 ? (open[at + 1] ?? null) : null;
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
 * The person's verdict on a PR layer (or a stack), as the reply into the
 * agent's thread: the verdict words, the note, then the comments in the
 * review app's export (`guideCommentSections`), under "Feedback on <noun>".
 * DRAFT agent text (REPORT.md): the words reach the agent as the person's reply.
 */
export function pullVerdictReply(
  verdict: 'approved' | 'changes_requested',
  target: PullReviewTarget,
  comments: number,
  sections: string,
  note?: string,
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
  if (comments === 0) return { words };
  const noun = pullNoun(target.pull);
  return {
    words,
    feedback: `# Feedback on ${noun}\n\nThe following comments are on the diff of ${subject}, one section per file. Line numbers are the file's own: (new) the changed file, (old) the original.\n\n${sections}`.trim(),
  };
}

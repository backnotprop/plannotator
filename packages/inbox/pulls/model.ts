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
  const projectsOf = (pull: InboxPull) => answer.projects[`${pull.host}/${pull.repo}`.toLowerCase()] ?? [];
  const pulls = project ? answer.pulls.filter((p) => projectsOf(p).includes(project)) : answer.pulls;
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

/**
 * The stack's name: the thread's subject when the agent opened it there (`url`: the agent named its own work),
 * else its lowest open layer's title. A thread the person handed it to is named by the hand-off, not the work.
 */
export function stackTitle(stack: InboxPullStack, link: InboxPullLink | null): string {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  if (open.length === 1) return open[0]!.title;
  return (link?.via === 'url' && link.thread_subject) || (inboxPullLandsNext(stack) ?? stack.layers[stack.layers.length - 1]!).title;
}

/** The Inbox projects a stack's repository is (two clones of one origin are two). */
export function stackProjects(answer: Pick<InboxPullsAnswer, 'projects'>, stack: Pick<InboxPullStack, 'host' | 'repo'>): readonly string[] {
  return answer.projects[`${stack.host}/${stack.repo}`.toLowerCase()] ?? [];
}

/** The PRs a hand-off gives the agent: the stack's open layers (a merged one is done). */
export function handoffKeys(stack: InboxPullStack): string[] {
  return stack.layers.filter((l) => l.state === 'open' || l.state === 'draft').map((l) => l.key);
}

const firstName = (pull: Pick<InboxPull, 'author'>) => pull.author ?? 'a teammate';

/**
 * The opening message of the thread a PR is handed to (Hand to an agent, Launch an agent): what it is, where,
 * and what the agent may do with it. Only the person's own open layers are the agent's to change; a teammate's
 * is for discussion: never pushed to, commented on or approved. DRAFT agent text (REPORT): the words reach the
 * agent as the person's New message.
 */
export function pullHandoffMessage(stack: InboxPullStack): string {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  const layers = open.length > 0 ? open : [stack.layers[stack.layers.length - 1]!];
  const mine = layers.some((l) => l.mine);
  const where = stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`;
  const cut = (title: string) => {
    const one = title.replace(/\s+/g, ' ').trim();
    return one.length > 100 ? `${one.slice(0, 99)}…` : one;
  };
  if (!mine) {
    const pull = layers[0]!;
    const who = firstName(pull);
    const head =
      layers.length === 1
        ? `Help me review ${pullNoun(pull)}: ${cut(pull.title)}\n\nIt is ${who}'s, in ${where}: ${pull.url}`
        : `Help me review ${who}'s stack, ${inboxPullLabel(layers[0]!)} to ${inboxPullLabel(layers[layers.length - 1]!)}: ${cut(layers[0]!.title)}\n\n${layerLines(layers, stack, where)}`;
    return `${head}\n\nRead the change, then reply here with what it does, what looks risky, and what I might ask ${who}. This thread is for our discussion only: don't push to the branch, comment on the ${stack.platform === 'gitlab' ? 'merge request' : 'pull request'}, or approve it.`;
  }
  const pull = layers[0]!;
  const head =
    layers.length === 1
      ? `Own ${pullNoun(pull)}: ${cut(pull.title)}\n\nIt is mine, in ${where}: ${pull.url} (branch ${pull.head}, into ${pull.base}).`
      : `Own the stack ${inboxPullLabel(layers[0]!)} to ${inboxPullLabel(layers[layers.length - 1]!)}: ${cut(layers[0]!.title)}\n\n${layerLines(layers, stack, where)}`;
  const teammates = layers.filter((l) => !l.mine);
  const theirs = teammates.length > 0 ? ` ${teammates.map(inboxPullLabel).join(', ')} ${teammates.length === 1 ? 'is' : 'are'} a teammate's: read ${teammates.length === 1 ? 'it' : 'them'}, never change ${teammates.length === 1 ? 'it' : 'them'}.` : '';
  return `${head}\n\nRead the change, then reply here with what it does and anything to fix before it lands. I review it in the Plannotator Inbox: my verdicts and replies come to this thread, and you act on them in ${layers.length === 1 ? `that ${stack.platform === 'gitlab' ? 'merge request' : 'pull request'}'s branch` : 'the branch of the layer they name'}.${theirs} Don't merge anything.`;
}

/** The stack's open layers, bottom (lands first) up, one numbered line each. */
function layerLines(layers: readonly InboxPull[], stack: InboxPullStack, where: string): string {
  const lines = layers.map((l, i) => `${i + 1}. ${inboxPullLabel(l)} ${l.title.replace(/\s+/g, ' ').trim()}: ${l.url} (branch ${l.head}${l.mine ? '' : `, ${firstName(l)}'s`})`);
  return `A stack in ${where}, landing from the bottom up into ${stack.open_base}:\n${lines.join('\n')}`;
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
      // `owner`: the person handed it over (the agent did not open it); `url`: the agent's own thread names it.
      return `${linkAgentName(link) ?? 'Your agent'} ${link?.via === 'owner' ? 'has it' : 'opened it'} · your review`;
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
  // Mid-line the reason starts lower case, but never an agent's name ("Claude Code has it").
  const reason = () => (item.reason === 'agent_ready' ? reasonWords(item, link) : reasonWords(item, link).replace(/^./, (c) => c.toLowerCase()));
  if (item.stack.layers.length === 1) return `${inboxPullLabel(item.focus)} · ${reason()}`;
  const merged = item.stack.layers.filter((l) => l.state === 'merged').length;
  const counts = `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`;
  const start = startLayer(item.stack);
  if (item.move === 'on_you' && start) return `${counts} · start at ${inboxPullLabel(start)}`;
  return `${counts} · ${reason()}`;
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

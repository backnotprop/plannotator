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
  inboxPullSafeBranch,
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

/** Control characters (a line break among them) become a space; bidirectional controls are dropped. */
const TITLE_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const TITLE_BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** A title in the hand-off is cut to this many characters. */
export const PULL_HANDOFF_TITLE_MAX = 100;

/**
 * A PR's title as the hand-off quotes it: the author's text, never words of the person's own. One line (control and
 * bidirectional characters out, whitespace collapsed), at most `PULL_HANDOFF_TITLE_MAX` characters, inside an
 * inline code span whose fence is longer than any run of backticks in it, so no markdown in it renders.
 */
export function pullTitleCode(title: string): string {
  let one = title.replace(TITLE_CONTROL, ' ').replace(TITLE_BIDI, '').replace(/\s+/g, ' ').trim();
  const chars = [...one];
  if (chars.length > PULL_HANDOFF_TITLE_MAX) one = `${chars.slice(0, PULL_HANDOFF_TITLE_MAX - 1).join('').trimEnd()}…`;
  if (!one) one = '(no title)';
  const longest = Math.max(0, ...(one.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}

/** A branch name as a code span, or null when it is not one `inboxPullSafeBranch` passes (then it is left out). */
function branchCode(name: string): string | null {
  return inboxPullSafeBranch(name) ? `\`${name}\`` : null;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/;
/** The author's login when it is one (GitHub's or GitLab's letters), else "a teammate". */
const authorOf = (pull: Pick<InboxPull, 'author'>) => (pull.author && LOGIN.test(pull.author) ? pull.author : 'a teammate');
const possessiveOf = (pull: Pick<InboxPull, 'author'>) => (pull.author && LOGIN.test(pull.author) ? `${pull.author}'s` : "a teammate's");
const REPO = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

/** The PR's web page when it is one on the PR's own host (`https://<host>/…`, no spaces or markdown), else null. */
function pullUrl(pull: Pick<InboxPull, 'url' | 'host'>): string | null {
  return pull.url.startsWith(`https://${pull.host}/`) && /^https:\/\/[^\s<>()[\]`"']+$/.test(pull.url) ? pull.url : null;
}

/** What a hand-off asks the agent for first: a guided review (the default), or the person's own curation. */
export type PullHandoffAsk = { kind: 'guide' } | { kind: 'custom'; words: string };

/** The person's own words for a custom curation are kept to this many characters. */
export const PULL_HANDOFF_CUSTOM_MAX = 1000;

/**
 * The ask's line: phase 1's `/review-curate` (its approved instructions go with the message as the skills block),
 * with the guided review's words (a stack: layer by layer, in landing order) or the person's own.
 */
export function pullHandoffAskLine(stack: InboxPullStack, ask: PullHandoffAsk): string {
  if (ask.kind === 'custom') {
    const words = ask.words.trim().slice(0, PULL_HANDOFF_CUSTOM_MAX);
    return words ? `/review-curate ${words}` : '/review-curate';
  }
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  if (open.length > 1) return "/review-curate Walk it layer by layer, in landing order: one chapter per layer, on that layer's own diff, with what to watch in it.";
  return open.every((l) => !l.mine) ? `/review-curate Include what I might ask ${authorOf(open[0] ?? stack.layers[0]!)}.` : '/review-curate';
}

/**
 * The opening message of the thread a PR is handed to (Hand to an agent, Launch an agent): what it is, where,
 * the ask (`pullHandoffAskLine`: first a guided review, sent through phase 1's review path so it opens as Start
 * review), and what the agent may do after. Only the person's own open layers are the agent's to change; a
 * teammate's is for discussion: never pushed to, commented on or approved. Everything from the forge is quoted,
 * never written as the person's words: titles through `pullTitleCode`, branches only when safe, logins and links
 * only when they are what they claim. DRAFT agent text: the words reach the agent as the person's New message.
 */
export function pullHandoffMessage(stack: InboxPullStack, ask: PullHandoffAsk = { kind: 'guide' }): string {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  const layers = open.length > 0 ? open : [stack.layers[stack.layers.length - 1]!];
  const mine = layers.some((l) => l.mine);
  const repo = REPO.test(stack.repo) ? stack.repo : 'its repository';
  const where = stack.host === 'github.com' ? repo : `${stack.host}/${repo}`;
  const noun = stack.platform === 'gitlab' ? 'merge request' : 'pull request';
  const at = (pull: InboxPull) => {
    const url = pullUrl(pull);
    return url ? `: ${url}` : '';
  };
  const what = layers.length > 1 ? "the stack's open layers, each on its own diff" : `this ${noun}'s diff against its base branch`;
  const whose = layers.length > 1 ? `the changes are the stack's, not ones you made` : `the change is the ${noun}'s, not one of yours`;
  const first = `First, send me a guided review of ${what} (${whose}):\n${pullHandoffAskLine(stack, ask)}`;
  if (!mine) {
    const pull = layers[0]!;
    const head =
      layers.length === 1
        ? `Help me review ${pullNoun(pull)}: ${pullTitleCode(pull.title)}\n\nIt is ${possessiveOf(pull)}, in ${where}${at(pull)}`
        : `Help me review ${possessiveOf(pull)} stack, ${inboxPullLabel(layers[0]!)} to ${inboxPullLabel(layers[layers.length - 1]!)}: ${pullTitleCode(layers[0]!.title)}\n\n${layerLines(layers, stack, where)}`;
    return `${head}\n\n${first}\n\nThis thread is for our discussion only: don't push to the branch, comment on the ${noun}, or approve it.`;
  }
  const pull = layers[0]!;
  const branches = [branchCode(pull.head), branchCode(pull.base)];
  const single = branches[0] ? ` (branch ${branches[0]}${branches[1] ? `, into ${branches[1]}` : ''})` : branches[1] ? ` (into ${branches[1]})` : '';
  const head =
    layers.length === 1
      ? `Own ${pullNoun(pull)}: ${pullTitleCode(pull.title)}\n\nIt is mine, in ${where}${at(pull)}${single}.`
      : `Own the stack ${inboxPullLabel(layers[0]!)} to ${inboxPullLabel(layers[layers.length - 1]!)}: ${pullTitleCode(layers[0]!.title)}\n\n${layerLines(layers, stack, where)}`;
  const teammates = layers.filter((l) => !l.mine);
  const theirs = teammates.length > 0 ? ` ${teammates.map(inboxPullLabel).join(', ')} ${teammates.length === 1 ? 'is' : 'are'} a teammate's: read ${teammates.length === 1 ? 'it' : 'them'}, never change ${teammates.length === 1 ? 'it' : 'them'}.` : '';
  return `${head}\n\n${first}\n\nAfter that, my verdicts and replies come to this thread; act on them in ${layers.length === 1 ? `that ${noun}'s branch` : 'the branch of the layer they name'}.${theirs} Don't merge anything.`;
}

/** The stack's open layers, bottom (lands first) up, one numbered line each: each title quoted the same way. */
function layerLines(layers: readonly InboxPull[], stack: InboxPullStack, where: string): string {
  const lines = layers.map((l, i) => {
    const branch = branchCode(l.head);
    const notes = [branch ? `branch ${branch}` : null, l.mine ? null : possessiveOf(l)].filter(Boolean).join(', ');
    const url = pullUrl(l);
    return `${i + 1}. ${inboxPullLabel(l)} ${pullTitleCode(l.title)}${url ? `: ${url}` : ''}${notes ? ` (${notes})` : ''}`;
  });
  const base = branchCode(stack.open_base);
  return `A stack in ${where}, landing from the bottom up${base ? ` into ${base}` : ''}:\n${lines.join('\n')}`;
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

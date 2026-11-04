/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; concept B take 1): the words the list and the stack view say, from
 * the server's answer and core's rules (`@plannotator/core/inbox-pulls`).
 * Pure, so the tests read them without a window.
 */
import {
  INBOX_THREAD_NAME_MAX,
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

/** Open or a draft: a PR still to land. */
export const isOpenPull = (pull: Pick<InboxPull, 'state'>): boolean => pull.state === 'open' || pull.state === 'draft';

/** A stack's layers still to land, bottom first (a merged or closed one is done). */
export function openLayers(stack: Pick<InboxPullStack, 'layers'>): InboxPull[] {
  return stack.layers.filter(isOpenPull);
}

/** The agent's thread behind a stack: the topmost open layer's link, else any layer's. */
export function stackLink(stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>>): InboxPullLink | null {
  for (let i = stack.layers.length - 1; i >= 0; i--) {
    const layer = stack.layers[i]!;
    if (isOpenPull(layer) && links[layer.key]) return links[layer.key]!;
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
    if (other.mine && isOpenPull(other) && links[other.key]) return links[other.key]!;
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
 * else its lowest open layer's title. A thread the person handed it to (`owner`) takes its subject from the
 * hand-off's first line ("You're being asked to help me review…"), never the stack's name; its thread name
 * (`pullHandoffThreadName`) is made from this title.
 */
export function stackTitle(stack: InboxPullStack, link: InboxPullLink | null): string {
  const open = openLayers(stack);
  if (open.length === 1) return open[0]!.title;
  return (link?.via === 'url' && link.thread_subject) || (inboxPullLandsNext(stack) ?? stack.layers[stack.layers.length - 1]!).title;
}

/** The Inbox projects a stack's repository is (two clones of one origin are two). */
export function stackProjects(answer: Pick<InboxPullsAnswer, 'projects'>, stack: Pick<InboxPullStack, 'host' | 'repo'>): readonly string[] {
  return answer.projects[`${stack.host}/${stack.repo}`.toLowerCase()] ?? [];
}

/** The PRs a hand-off gives the agent: the open layers of the stack it is about (`handoffStack`). */
export function handoffKeys(stack: InboxPullStack): string[] {
  return openLayers(stack).map((l) => l.key);
}

/** Control characters (a line break among them) become a space; bidirectional controls are dropped. */
const TITLE_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const TITLE_BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** A title in the hand-off is cut to this many characters. */
export const PULL_HANDOFF_TITLE_MAX = 100;

/**
 * A PR's title as the hand-off writes it: plain text on one line (control and bidirectional characters out,
 * whitespace collapsed, so a title can never start a line of its own), at most `PULL_HANDOFF_TITLE_MAX` characters.
 */
export function pullTitleLine(title: string): string {
  let one = title.replace(TITLE_CONTROL, ' ').replace(TITLE_BIDI, '').replace(/\s+/g, ' ').trim();
  const chars = [...one];
  if (chars.length > PULL_HANDOFF_TITLE_MAX) one = `${chars.slice(0, PULL_HANDOFF_TITLE_MAX - 1).join('').trimEnd()}…`;
  return one || '(no title)';
}

/** A branch name when `inboxPullSafeBranch` passes it, else null (then it is left out). */
function safeBranch(name: string): string | null {
  return inboxPullSafeBranch(name) ? name : null;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/;
/** The author's login when it is one (GitHub's or GitLab's letters), else "a teammate". */
const authorOf = (pull: Pick<InboxPull, 'author'>) => (pull.author && LOGIN.test(pull.author) ? pull.author : 'a teammate');
const REPO = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;

/** The PR's web page when it is one on the PR's own host (`https://<host>/…`, no spaces or markdown), else null. */
function pullUrl(pull: Pick<InboxPull, 'url' | 'host'>): string | null {
  return pull.url.startsWith(`https://${pull.host}/`) && /^https:\/\/[^\s<>()[\]`"']+$/.test(pull.url) ? pull.url : null;
}

/** What a hand-off asks the agent for first: a guided review (the default), or the person's own curation. */
export type PullHandoffAsk = { kind: 'guide' } | { kind: 'custom'; words: string };

/** The person's own words for a custom curation are kept to this many characters. */
export const PULL_HANDOFF_CUSTOM_MAX = 1000;

/** A stack's guided review, after step 1's `/review-curate` (approval "stack-show-me", q-55141171). */
const STACK_WALK = 'Walk it layer by layer, in landing order, with what to watch in each.';

/** The layers a hand-off names: the stack's open ones, else its top one. */
function handoffLayers(stack: InboxPullStack): InboxPull[] {
  const open = openLayers(stack);
  return open.length > 0 ? open : [stack.layers[stack.layers.length - 1]!];
}

/**
 * The stack a hand-off is about. Its open layers in one chain (each based on the one under it): the whole stack. A
 * tree (two open PRs on one branch): only the chain from the bottom up to `target` (the layer the stack view is open
 * on, else the stack's top), the layers whose diff the review's Whole stack reads for that layer, so the list,
 * step 1's "to" branch and "in list order" stay true. The merged layers under it stay.
 */
export function handoffStack(stack: InboxPullStack, target: string | null): InboxPullStack {
  const open = openLayers(stack);
  const parentOf = (pull: InboxPull) => open.find((other) => other.key !== pull.key && other.head === pull.base) ?? null;
  if (open.every((pull, i) => i === 0 || parentOf(pull) === open[i - 1])) return stack;
  const tip = open.find((l) => l.key === target) ?? open.find((l) => l.key === stack.id) ?? open[open.length - 1]!;
  const chain: InboxPull[] = [];
  for (let at: InboxPull | null = tip; at && !chain.includes(at); at = parentOf(at)) chain.unshift(at);
  return { ...stack, layers: [...stack.layers.filter((l) => !isOpenPull(l)), ...chain] };
}

/**
 * Step 1 of the hand-off, one line: the guided review through phase 1's `/review-curate` (its approved instructions
 * go with the message as the skills block). One PR: its diff against its base, the person's words (custom curation)
 * after `/review-curate`, and on a teammate's PR what the person might ask its author. A stack (approval
 * "stack-show-me"): the whole stack's diff, from its base to the top layer's head, walked layer by layer, or the
 * person's words in place of that walk. `pullLaunchAsk` looks for this line.
 */
export function pullHandoffAskLine(stack: InboxPullStack, ask: PullHandoffAsk): string {
  const layers = handoffLayers(stack);
  const custom = ask.kind === 'custom' ? ask.words.trim().slice(0, PULL_HANDOFF_CUSTOM_MAX) : '';
  if (layers.length > 1) {
    const top = layers[layers.length - 1]!;
    const from = safeBranch(stack.open_base) ?? "the stack's base branch";
    const to = safeBranch(top.head) ?? `the top ${pullNounOf(stack)}'s branch`;
    const after = ask.kind === 'custom' ? custom : STACK_WALK;
    return `1. Send me a guided review of the whole stack's diff, from ${from} to ${to}, using /review-curate (its instructions are at the end of this message).${after ? ` ${after}` : ''}`;
  }
  const theirs = ask.kind === 'guide' && !layers[0]!.mine ? ` Include what I might ask ${authorOf(layers[0]!)}.` : '';
  return `1. Send me a guided review of its diff against ${safeBranch(layers[0]!.base) ?? 'its base branch'}, using /review-curate${custom ? ` ${custom}` : ''} (its instructions are at the end of this message).${theirs}`;
}

/** "pull request" / "merge request". */
const pullNounOf = (stack: Pick<InboxPullStack, 'platform'>) => (stack.platform === 'gitlab' ? 'merge request' : 'pull request');

/**
 * The opening message of the thread a PR is handed to (Hand to an agent, Launch an agent), the owner's approved
 * text (`.product/approved/pull-handoff-message/`; a stack's step 1 in `stack-show-me`, the rest of a stack's wording
 * awaits approval): help me review and understand it, and change no code unless I say so; what it is; then the
 * guided review (`pullHandoffAskLine`) and the discussion, with no push, comment, approval or merge. One version for
 * every PR, the person's own or a teammate's. Everything from the forge is its author's: titles through
 * `pullTitleLine`, branches only when safe, logins and links only when they are what they claim. A tree stack is
 * narrowed first (`handoffStack`).
 */
export function pullHandoffMessage(stack: InboxPullStack, ask: PullHandoffAsk = { kind: 'guide' }): string {
  const layers = handoffLayers(stack);
  const many = layers.length > 1;
  const noun = pullNounOf(stack);
  const nouns = many ? `${noun}s` : noun;
  const where = REPO.test(stack.repo) ? (stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`) : null;
  const repository = where ? `- Repository: ${where}` : null;
  const heading = `${noun[0]!.toUpperCase()}${nouns.slice(1)}`;
  const opening = `You're being asked to help me review and understand ${many ? `a stack of ${nouns}` : `a ${noun}`}. Don't change any code unless I explicitly tell you to.`;
  const them = many ? 'them' : 'it';
  const whatToDo = `What to do\n${pullHandoffAskLine(stack, ask)}\n2. After that, we discuss it in this thread. Don't push to the ${many ? 'branches' : 'branch'}, comment on the ${nouns}, approve ${them} or merge ${them}.`;
  if (!many) {
    const pull = layers[0]!;
    const url = pullUrl(pull);
    const head = safeBranch(pull.head);
    const base = safeBranch(pull.base);
    const facts = [
      heading,
      `- Title: ${pullTitleLine(pull.title)}`,
      `- Number: ${inboxPullLabel(pull)}`,
      repository,
      url ? `- Link: ${url}` : null,
      base ? `- Branch: ${head ? `${head}, ` : ''}into ${base}` : null,
      `- Author: ${pull.mine ? 'me' : authorOf(pull)}`,
    ];
    return [opening, facts.filter(Boolean).join('\n'), whatToDo].join('\n\n');
  }
  const list = layers.map((l) => {
    const url = pullUrl(l);
    const branch = safeBranch(l.head);
    return `- ${inboxPullLabel(l)} ${pullTitleLine(l.title)}${url ? ` · ${url}` : ''}${branch ? ` · branch ${branch}` : ''}`;
  });
  const base = safeBranch(stack.open_base);
  const about = ['Stack', repository, base ? `- Lands into: ${base}, in list order` : null, stackAuthors(layers)];
  return [opening, [heading, ...list].join('\n'), about.filter(Boolean).join('\n'), whatToDo].join('\n\n');
}

/**
 * The name of the thread a hand-off starts (owner, q-49bd0699 A): "Review #869: <title>", a stack "Review #412 to
 * #414: <title>" (its bottom and top open layers), the title the Pull requests list shows (`stackTitle`) on one
 * line (`pullTitleLine`), cut so the whole name fits the thread-name limit (`INBOX_THREAD_NAME_MAX`). The same for
 * a custom curation. Sent as the person's own name (`thread_name`), so the list shows it and no agent renames it.
 */
export function pullHandoffThreadName(stack: InboxPullStack, link: InboxPullLink | null): string {
  const layers = handoffLayers(stack);
  const numbers = layers.length > 1 ? `${inboxPullLabel(layers[0]!)} to ${inboxPullLabel(layers[layers.length - 1]!)}` : inboxPullLabel(layers[0]!);
  const head = `Review ${numbers}: `;
  const title = [...pullTitleLine(stackTitle(stack, link))];
  const room = INBOX_THREAD_NAME_MAX - [...head].length;
  return `${head}${title.length > room ? `${title.slice(0, room - 1).join('').trimEnd()}…` : title.join('')}`;
}

/** "- Author: me" when one person wrote every layer, else "- Authors: me (#412, #413), tomas (#414)". */
function stackAuthors(layers: readonly InboxPull[]): string {
  const by = new Map<string, string[]>();
  for (const l of layers) {
    const who = l.mine ? 'me' : authorOf(l);
    by.set(who, [...(by.get(who) ?? []), inboxPullLabel(l)]);
  }
  if (by.size === 1) return `- Author: ${[...by.keys()][0]}`;
  return `- Authors: ${[...by].map(([who, labels]) => `${who} (${labels.join(', ')})`).join(', ')}`;
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
  const open = openLayers(item.stack);
  // Mid-line the reason starts lower case, but never an agent's name ("Claude Code has it").
  const reason = () => (item.reason === 'agent_ready' ? reasonWords(item, link) : reasonWords(item, link).replace(/^./, (c) => c.toLowerCase()));
  if (item.stack.layers.length === 1) return `${inboxPullLabel(item.focus)} · ${reason()}`;
  const merged = item.stack.layers.filter((l) => l.state === 'merged').length;
  const counts = `${open.length} open${merged > 0 ? `, ${merged} merged` : ''}`;
  const start = startLayer(item.stack);
  if (item.move === 'on_you' && start) return `${counts} · start at ${inboxPullLabel(start)}`;
  return `${counts} · ${reason()}`;
}

/** Where "Open the diff" starts (layer by layer): the next layer to land that is not a draft, else the next to land. */
export function startLayer(stack: InboxPullStack): InboxPull | null {
  const open = openLayers(stack);
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
  const open = openLayers(stack);
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

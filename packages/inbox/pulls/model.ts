/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; concept B take 1): the words the list and the stack view say, from
 * the server's answer and core's rules (`@plannotator/core/inbox-pulls`).
 * Pure, so the tests read them without a window.
 */
import {
  INBOX_THREAD_NAME_MAX,
  inboxPullGroups,
  inboxPullIsOpen,
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
import { stackLink, startLayer } from './topology';

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
 * The answer as the page shows it: the rows by whose move it is, only the chosen project's when one is, and only the
 * chosen view's. A stack stays whole: it is built from every PR, then kept when any open layer is in the view.
 */
export function pullGroups(answer: InboxPullsAnswer, project: string | null, filter: PullFilter = 'all'): InboxPullGroups {
  const projectsOf = (pull: InboxPull) => answer.projects[`${pull.host}/${pull.repo}`.toLowerCase()] ?? [];
  const pulls = project ? answer.pulls.filter((p) => projectsOf(p).includes(project)) : answer.pulls;
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

/** A stack's layers still to land, bottom first (a merged or closed one is done). */
export function openLayers(stack: Pick<InboxPullStack, 'layers'>): InboxPull[] {
  return stack.layers.filter(isOpenPull);
}

/** The open layer a layer is based on (its base is that layer's head), or null. */
function parentIn(open: readonly InboxPull[], pull: InboxPull): InboxPull | null {
  return open.find((other) => other.key !== pull.key && other.head === pull.base) ?? null;
}

/** Two open PRs on one branch: the open layers are not one chain (each based on the one under it). */
function isTree(open: readonly InboxPull[]): boolean {
  return !open.every((pull, i) => i === 0 || parentIn(open, pull) === open[i - 1]);
}

/** The open layers from the bottom up to `tip`, each based on the one under it (the layers its Whole stack reads). */
function chainTo(open: readonly InboxPull[], tip: InboxPull): InboxPull[] {
  const chain: InboxPull[] = [];
  for (let at: InboxPull | null = tip; at && !chain.includes(at); at = parentIn(open, at)) chain.unshift(at);
  return chain;
}

/** The agent's name as the Inbox writes it ("Claude Code", "Codex"), or the name it gave itself. */
export function linkAgentName(link: InboxPullLink | null): string | null {
  if (!link?.agent) return null;
  return link.agent.name?.trim() || agentName(link.agent.host);
}

/**
 * The stack's name: the thread's subject when the agent opened the stack there (`url`: the agent named its own work,
 * and that thread links the stack's lowest open layer), else its lowest open layer's title. A thread that linked
 * only a layer higher up names that layer's work, not the stack's. A thread the person handed it to (`owner`) takes
 * its subject from the hand-off's first line ("You're being asked to help me review…"), never the stack's name; its
 * thread name (`pullHandoffThreadName`) is made from this title.
 */
export function stackTitle(stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>>): string {
  const open = openLayers(stack);
  if (open.length === 1) return open[0]!.title;
  const root = inboxPullLandsNext(stack);
  const link = root ? links[root.key] : undefined;
  return (link?.via === 'url' && link.thread_subject) || (root ?? stack.layers[stack.layers.length - 1]!).title;
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
/** What draws nothing: whitespace and the zero-width characters (U+200B, U+FEFF, a joiner, a variation selector…). */
const TITLE_INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;
/** A title in the hand-off is cut to this many characters. */
export const PULL_HANDOFF_TITLE_MAX = 100;

let graphemes: Intl.Segmenter | null = null;
/**
 * `text` within `max` characters (code points, the unit the server and the name chip count), cut with "…" between two
 * graphemes: never inside an emoji sequence (a ZWJ family, a flag's two letters) or between a letter and its marks.
 */
function cutText(text: string, max: number): string {
  if ([...text].length <= max) return text;
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let kept = '';
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (count + size > max - 1) break;
    kept += segment;
    count += size;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * A PR's title as the hand-off writes it: plain text on one line (control and bidirectional characters out,
 * whitespace collapsed, so a title can never start a line of its own), at most `PULL_HANDOFF_TITLE_MAX` characters
 * (`cutText`). A title that draws nothing (only whitespace or zero-width characters) is "(no title)".
 */
export function pullTitleLine(title: string): string {
  const one = title.replace(TITLE_CONTROL, ' ').replace(TITLE_BIDI, '').replace(/\s+/g, ' ').trim();
  if (one.replace(TITLE_INVISIBLE, '') === '') return '(no title)';
  return cutText(one, PULL_HANDOFF_TITLE_MAX);
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
 * The stack a hand-off is about: the open layers no agent's thread has yet (`thread` null: No agent yet), or the ones
 * `thread` has (a new review thread after its agent ended); null when there are none.
 * - A chain (each open layer based on the one under it) is one stack: handed over whole, and once a thread has it
 *   (`stackLink`) nothing of it is left to hand.
 * - A tree (two open PRs on one branch): the topmost open layer that thread has (or no thread has), down its chain
 *   while the layers under it are that thread's too (or no thread's). Those are the layers the review's Whole stack
 *   reads for it, so the list, step 1's "from" and "to" branches and "in list order" stay true. A hand-off covers the
 *   chain to the top first (#412 and #414). Their sibling #413 is what `thread` null answers after that, but the page
 *   offers no hand-off for it (the stack view shows the stack's agent, as for any linked stack).
 * The merged layers under the stack stay when the hand-off starts at its bottom.
 */
export function handoffStack(stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>>, thread: string | null = null): InboxPullStack | null {
  const open = openLayers(stack);
  if (open.length === 0) return null;
  if (!isTree(open)) return thread !== null || !stackLink(stack, links) ? stack : null;
  const whose = (pull: InboxPull) => links[pull.key]?.thread_id ?? null;
  const tip = [...open].reverse().find((l) => whose(l) === thread);
  if (!tip) return null;
  const layers: InboxPull[] = [];
  for (const at of chainTo(open, tip).reverse()) {
    if (whose(at) !== thread) break;
    layers.unshift(at);
  }
  return layers[0]!.base === stack.open_base
    ? { ...stack, layers: [...stack.layers.filter((l) => !isOpenPull(l)), ...layers] }
    : { ...stack, layers, base: layers[0]!.base, open_base: layers[0]!.base };
}

/** " on dana/web-app (a fork)" after a branch whose head is on a fork, so the agent knows where it lives; else nothing. */
function forkWords(pull: Pick<InboxPull, 'repo' | 'head_repo'>): string {
  const fork = pull.head_repo;
  return fork && REPO.test(fork) && fork.toLowerCase() !== pull.repo.toLowerCase() ? ` on ${fork} (a fork)` : '';
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
 * The opening message of the review thread a PR goes to (Review with an agent, a running one or a new one), the owner's approved
 * text (`.product/approved/pull-handoff-pushes/`, over `pull-handoff-message/`; a stack's step 1 in `stack-show-me`, the
 * rest of a stack's wording awaits approval): help me review and understand it; what it is; then the guided review
 * (`pullHandoffAskLine`) and the discussion. On the person's own PRs, feedback is made and pushed where the agent can, and
 * the next round comes in the same thread, as a local review's does (`localReviewMessage`). On a PR with any teammate's
 * layer, no code changes unless the person says so and no push. Never a comment, approval or merge. A head on a fork is
 * named (`forkWords`). Everything from the forge is its author's: titles through
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
  const mine = layers.every((l) => l.mine);
  const opening = `You're being asked to help me review and understand ${many ? `a stack of ${nouns}` : `a ${noun}`}.${mine ? '' : " Don't change any code unless I explicitly tell you to."}`;
  const them = many ? 'them' : 'it';
  const branch = many ? 'branches' : 'branch';
  const feedback = mine
    ? `If I ask for changes, make them, push them to the ${branch} if you can, and send me the updated review here. Don't comment on the ${nouns}, approve ${them} or merge ${them}.`
    : `Don't push to the ${branch}, comment on the ${nouns}, approve ${them} or merge ${them}.`;
  const whatToDo = `What to do\n${pullHandoffAskLine(stack, ask)}\n2. After that, we discuss it in this thread. ${feedback}`;
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
      base ? `- Branch: ${head ? `${head}${forkWords(pull)}, ` : ''}into ${base}` : null,
      `- Author: ${pull.mine ? 'me' : authorOf(pull)}`,
    ];
    return [opening, facts.filter(Boolean).join('\n'), whatToDo].join('\n\n');
  }
  const list = layers.map((l) => {
    const url = pullUrl(l);
    const branch = safeBranch(l.head);
    return `- ${inboxPullLabel(l)} ${pullTitleLine(l.title)}${url ? ` · ${url}` : ''}${branch ? ` · branch ${branch}${forkWords(l)}` : ''}`;
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
 * `stack` is the hand-off's (`handoffStack`), `whole` the stack it is from: "#412 to #414" only for a straight run of
 * `whole`'s open layers; a tree's chain that skips one (#413) lists its numbers instead, "Review #412, #414: <title>".
 */
export function pullHandoffThreadName(stack: InboxPullStack, links: Readonly<Record<string, InboxPullLink>> | null, whole: InboxPullStack = stack): string {
  const layers = handoffLayers(stack);
  const labels = layers.map(inboxPullLabel);
  const all = openLayers(whole);
  const at = all.findIndex((l) => l.key === layers[0]!.key);
  const straight = at >= 0 && layers.every((l, i) => all[at + i]?.key === l.key);
  const numbers = labels.length === 1 ? labels[0]! : straight ? `${labels[0]} to ${labels[labels.length - 1]}` : numberList(labels);
  const head = `Review ${numbers}: `;
  return `${head}${cutText(pullTitleLine(stackTitle(stack, links ?? {})), INBOX_THREAD_NAME_MAX - [...head].length)}`;
}

/** A tree hand-off's numbers in its thread's name stay within this many characters. */
const NAME_NUMBERS_MAX = 60;

/** "#412, #414", cut with ", …" to `NAME_NUMBERS_MAX` characters (the first number always shows). */
function numberList(labels: readonly string[]): string {
  const all = labels.join(', ');
  if (all.length <= NAME_NUMBERS_MAX) return all;
  let kept = labels[0]!;
  for (const label of labels.slice(1)) {
    if (`${kept}, ${label}, …`.length > NAME_NUMBERS_MAX) break;
    kept = `${kept}, ${label}`;
  }
  return `${kept}, …`;
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

const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** Why a PR is where it is, in words ("Tomas asked for your review"). */
export function reasonWords(item: Pick<InboxPullItem, 'reason' | 'focus'>, link: InboxPullLink | null): string {
  const pull = item.focus;
  switch (item.reason) {
    case 'requested':
      return pull.author ? `${pull.author} asked for your review` : 'Your review was asked for';
    case 'assigned':
      return 'Assigned to you';
    case 'agent_ready': {
      // Its review thread (the person's ask, or the agent's own thread that names it); the agent unnamed, only the ask.
      const name = linkAgentName(link);
      return name ? `${agentThreadWords(name, link?.agent?.ended === true)} · your review` : 'Your review';
    }
    case 'running':
      return 'Checks running';
    case 'changes':
      return 'Changes requested';
    case 'failing':
      return 'Checks failed';
    case 'conflicts':
      return 'Has conflicts';
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

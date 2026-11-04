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
 * else its lowest open layer's title. A thread the person handed it to (`owner`) is named by the hand-off's first
 * line ("You're being asked to help me review…"), not the work, so its subject never names the stack.
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

/** The guided review's words for a stack, after `/review-curate`. */
const STACK_ASK_WORDS = "Walk it layer by layer, in landing order: one chapter per layer, on that layer's own diff, with what to watch in it";

/** The layers a hand-off names: the stack's open ones, else its top one. */
function handoffLayers(stack: InboxPullStack): InboxPull[] {
  const open = stack.layers.filter((l) => l.state === 'open' || l.state === 'draft');
  return open.length > 0 ? open : [stack.layers[stack.layers.length - 1]!];
}

/**
 * Step 1 of the hand-off, one line: the guided review through phase 1's `/review-curate` (its approved instructions
 * go with the message as the skills block), with the stack's words or the person's own after it, in place of the
 * default. A teammate's PR adds what the person might ask its author. `pullLaunchAsk` looks for this line.
 */
export function pullHandoffAskLine(stack: InboxPullStack, ask: PullHandoffAsk): string {
  const layers = handoffLayers(stack);
  const what = layers.length > 1 ? 'the stack' : `its diff against ${safeBranch(layers[0]!.base) ?? 'its base branch'}`;
  const words = ask.kind === 'custom' ? ask.words.trim().slice(0, PULL_HANDOFF_CUSTOM_MAX) : layers.length > 1 ? STACK_ASK_WORDS : '';
  const theirs = ask.kind === 'guide' && layers.length === 1 && !layers[0]!.mine ? ` Include what I might ask ${authorOf(layers[0]!)}.` : '';
  return `1. Send me a guided review of ${what}, using /review-curate${words ? ` ${words}` : ''} (its instructions are at the end of this message).${theirs}`;
}

/**
 * The opening message of the thread a PR is handed to (Hand to an agent, Launch an agent), the owner's approved
 * text (`.product/approved/pull-handoff-message/`; the stack's wording awaits approval): help me review and
 * understand it, and change no code unless I say so; what it is; then the guided review (`pullHandoffAskLine`) and
 * the discussion, with no push, comment, approval or merge. One version for every PR, the person's own or a
 * teammate's. Everything from the forge is its author's: titles through `pullTitleLine`, branches only when safe,
 * logins and links only when they are what they claim.
 */
export function pullHandoffMessage(stack: InboxPullStack, ask: PullHandoffAsk = { kind: 'guide' }): string {
  const layers = handoffLayers(stack);
  const gitlab = stack.platform === 'gitlab';
  const where = REPO.test(stack.repo) ? (stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`) : null;
  const repository = where ? `- Repository: ${where}` : null;
  const step1 = pullHandoffAskLine(stack, ask);
  if (layers.length === 1) {
    const pull = layers[0]!;
    const noun = gitlab ? 'merge request' : 'pull request';
    const url = pullUrl(pull);
    const head = safeBranch(pull.head);
    const base = safeBranch(pull.base);
    const facts = [
      gitlab ? 'Merge request' : 'Pull request',
      `- Title: ${pullTitleLine(pull.title)}`,
      `- Number: ${inboxPullLabel(pull)}`,
      repository,
      url ? `- Link: ${url}` : null,
      base ? `- Branch: ${head ? `${head}, ` : ''}into ${base}` : null,
      `- Author: ${pull.mine ? 'me' : authorOf(pull)}`,
    ];
    return [
      `You're being asked to help me review and understand a ${noun}. Don't change any code unless I explicitly tell you to.`,
      facts.filter(Boolean).join('\n'),
      `What to do\n${step1}\n2. After that, we discuss it in this thread. Don't push to the branch, comment on the ${noun}, approve it or merge it.`,
    ].join('\n\n');
  }
  const nouns = gitlab ? 'merge requests' : 'pull requests';
  const list = layers.map((l) => {
    const url = pullUrl(l);
    const branch = safeBranch(l.head);
    return `- ${inboxPullLabel(l)} ${pullTitleLine(l.title)}${url ? ` · ${url}` : ''}${branch ? ` · branch ${branch}` : ''}`;
  });
  const base = safeBranch(stack.open_base);
  return [
    `You're being asked to help me review and understand a stack of ${nouns}. Don't change any code unless I explicitly tell you to.`,
    [gitlab ? 'Merge requests' : 'Pull requests', ...list].join('\n'),
    ['Stack', repository, base ? `- Lands into: ${base}, in list order` : null, stackAuthors(layers)].filter(Boolean).join('\n'),
    `What to do\n${step1}\n2. After that, we discuss it in this thread. Don't push to the branches, comment on the ${nouns}, approve them or merge them.`,
  ].join('\n\n');
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

/** Where "Open the diff" starts (layer by layer): the next layer to land that is not a draft, else the next to land. */
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

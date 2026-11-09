/**
 * Known answers (approval "inbox-feedback-faq", 2026-11-09): a hand-written list of what people write in about,
 * each with a short answer and one action. The Feedback form checks it first, in the window, and shows at most one,
 * as the first line of "These might help" ("Fixed in 0.28.52: the list holds still now · Use Simple list"). The
 * entries with `faq` are also Common questions, in this order (feedbackFaq.ts). Edit the words here.
 *
 * An action runs a setting the Inbox already has (the window wires each kind in App.tsx): `simple-list` is the
 * list's ⋮ menu → View → Simple list (listView.ts); `settings-<section>` opens that Settings section;
 * `settings-experimental` opens Capabilities on its Experimental group. A link opens real release notes or docs.
 *
 * Experimental features held until 0.29 (packages/server/inbox.ts `heldSwitch`: Code review, Shape, System) are
 * not here: their switches are hidden, so nothing may offer them.
 *
 * Matching is whole words and whole phrases, no stems: "moves" never finds "remove". An entry matches on one of its
 * `phrases`, or when every `near` group has a word that is not negated ("doesn't move" is praise) and they sit
 * within 8 words of each other. Text that reports something broken ("doesn't work", "crashes") matches only the
 * entries marked `whenBroken`: a "turn it on" answer to a bug report misleads.
 */
import type { SettingsSection } from './settingsRoute';

export type FeedbackAction = 'simple-list' | `settings-${SettingsSection}` | 'settings-experimental';

export interface KnownAnswer {
  /** Stable id, for tests, the open Common question and the window's list of answers it hides. */
  id: string;
  /** The short answer: the line's words, after "Fixed in 0.28.52: " or "Experimental: ". */
  answer: string;
  /** A complaint fixed in this release (without its "v"): the line starts "Fixed in {fixedIn}:". */
  fixedIn?: string;
  /** A switch in Settings → Capabilities → Experimental: the line starts "Experimental:". */
  experimental?: true;
  action?: { kind: FeedbackAction; label: string };
  /** The answer's words link here; with no action, the link is the action. */
  link?: { label: string; href: string };
  /** Also a Common question, asked and answered this way. */
  faq?: { question: string; answer: string };
  /** The hand-written feature in feedbackSearch.data.json this answer stands for: not listed again under it. */
  feature?: string;
  match: { phrases?: string[]; near?: string[][]; whenBroken?: true };
}

const RELEASE = 'https://github.com/backnotprop/plannotator/releases/tag/';
const DOCS = 'https://plannotator.ai/docs/reference/inbox/';

const AGENTS = ['agent', 'agents', 'claude', 'claude code', 'session', 'sessions'];

export const KNOWN_ANSWERS: readonly KnownAnswer[] = [
  {
    id: 'list-moves',
    answer: 'the list holds still now',
    fixedIn: '0.28.52',
    action: { kind: 'simple-list', label: 'Use Simple list' },
    link: { label: 'What changed in 0.28.52', href: `${RELEASE}v0.28.52` },
    faq: {
      question: 'The list moves while I’m reading it',
      answer:
        'Fixed in 0.28.52. New messages wait behind “N new · Show” at the top of the list, so rows only move when you ask. The row you open stays where it is. Want no groups at all? Use Simple list: one list, newest first.',
    },
    match: {
      phrases: ['list moves', 'list jumps', 'rows jump', 'threads jump', 'keeps reordering'],
      near: [
        ['list', 'row', 'rows', 'thread', 'threads', 'inbox', 'item', 'items', 'order', 'message', 'messages', 'everything', 'stuff'],
        ['move', 'moves', 'moving', 'moved', 'jump', 'jumps', 'jumping', 'jumpy', 'jumped', 'shuffle', 'shuffles', 'shuffling', 'reorder', 'reorders', 'reordering', 'reordered', 'rearrange', 'rearranges', 'rearranging', 'shift', 'shifts', 'shifting', 'bounce', 'bounces', 'bouncing', 'resort', 'resorts', 'resorting', 'vanish', 'vanishes', 'disappear', 'disappears', 'disappearing', 'keeps changing', 'out from under', 'under me', "won't stay", "doesn't stay", 'stay still', 'stay put', 'hold still'],
      ],
    },
  },
  {
    id: 'simple-list',
    answer: 'Simple list: one list, newest first',
    action: { kind: 'simple-list', label: 'Use Simple list' },
    faq: {
      question: 'Can I have one plain list instead of groups?',
      answer: 'Yes. ⋮ above the list → View → Simple list. Same rows and badges, newest first. Smart groups stay one click away.',
    },
    match: {
      phrases: ['simple list', 'plain list', 'flat list', 'chronological', 'sort by date', 'sort by newest', 'newest first', 'sort by time', 'like email', 'like gmail', 'like an email'],
      near: [
        ['group', 'groups', 'grouping', 'section', 'sections', 'bands', 'categories', 'smart'],
        ['confusing', 'confused', 'confuse', 'too many', "don't need", 'do not need', "don't want", 'get rid', 'turn off', 'hide', 'remove', 'simpler', 'plain', 'flat', 'annoying', 'hate'],
      ],
    },
  },
  {
    id: 'rows',
    answer: 'Choose how rows look: Minimal, Balanced or Detailed',
    action: { kind: 'settings-rows', label: 'Open Settings → Rows' },
    faq: {
      question: 'Rows show too much, or too little',
      answer:
        'Settings → Rows has three looks, Minimal, Balanced and Detailed, and you can fine-tune density, the preview and the time. Your choice follows you to every browser.',
    },
    feature: 'Settings, Rows',
    match: {
      phrases: ['row density', 'list density', 'compact rows', 'compact list', 'smaller rows', 'tighter rows', 'denser list', 'preview lines', 'rows look'],
      near: [
        ['row', 'rows', 'list', 'sidebar'],
        ['cluttered', 'clutter', 'busy', 'noisy', 'too big', 'too tall', 'too much info', 'dense', 'denser', 'compact', 'minimal', 'smaller', 'cramped', 'bigger', 'spacing'],
      ],
    },
  },
  {
    id: 'done',
    answer: 'Archive a thread from its ⋯ menu',
    link: { label: 'Inbox docs', href: `${DOCS}#what-you-see` },
    faq: {
      question: 'How do I mark a thread done?',
      answer: 'Archive it from the thread’s ⋯ menu. It comes back by itself if the agent writes again, and Unarchive reopens it.',
    },
    feature: 'Archive',
    match: {
      phrases: ['mark done', 'mark as done', 'mark it done', 'done button', 'archive'],
      near: [
        ['thread', 'threads', 'conversation', 'conversations'],
        ['done', 'finish', 'finished', 'delete', 'remove', 'dismiss', 'close', 'clear', 'trash', 'get rid'],
      ],
    },
  },
  {
    id: 'phone',
    answer: 'Use the Inbox on your phone, over your tailnet',
    action: { kind: 'settings-devices', label: 'Open Settings → Devices' },
    faq: {
      question: 'Can I use the Inbox on my phone?',
      answer: 'Yes, over your tailnet: open the address from Settings → Devices on your phone.',
    },
    feature: 'Over your tailnet',
    match: {
      phrases: ['on my phone', 'from my phone', 'on my iphone', 'from my iphone', 'on my ipad', 'on mobile', 'from mobile', 'mobile app', 'phone app', 'iphone app', 'android app', 'ipad app', 'away from my desk', 'away from my computer', 'on the go', 'tailscale', 'tailnet'],
    },
  },
  {
    id: 'start-agents',
    answer: 'New message can start Claude Code or Pi for you',
    action: { kind: 'settings-agents', label: 'Open Settings → Agents' },
    link: { label: 'What changed in 0.28.52', href: `${RELEASE}v0.28.52` },
    match: {
      whenBroken: true,
      phrases: [
        'start an agent', 'start agents', 'start a new agent', 'start new agents', 'launch an agent', 'launch agents', 'launch a new agent', 'spawn an agent', 'spawn agents',
        'start a session', 'start a new session', 'start sessions', 'start claude', 'launch claude', 'start pi', 'kick off an agent', 'start themselves', 'start by themselves',
      ],
      near: [['start', 'launch', 'spawn', 'kick off'], AGENTS, ['inbox', 'here', 'themselves', 'itself', 'new message', 'compose', 'own']],
    },
  },
  {
    id: 'notifications',
    answer: 'Turn on notifications and a sound, and test them',
    action: { kind: 'settings-general', label: 'Open Settings → General' },
    match: {
      whenBroken: true,
      phrases: ['notification', 'notifications', 'notify me', 'get notified', 'alert me', 'play a sound', 'a sound when', 'ping me', 'desktop alert', 'desktop alerts'],
    },
  },
  {
    id: 'theme',
    answer: 'Choose light or dark, the text size and the colors',
    action: { kind: 'settings-general', label: 'Open Settings → General' },
    feature: 'Settings, Appearance',
    match: {
      phrases: [
        'dark mode', 'light mode', 'dark theme', 'light theme', 'night mode', 'theme', 'themes', 'font size', 'text size', 'bigger text', 'smaller text', 'larger text',
        'bigger font', 'smaller font', 'larger font', 'text is too small', 'font is too small', 'color scheme', 'colour scheme', 'change the colors', 'change the colours', 'too bright',
      ],
    },
  },
  {
    id: 'keys',
    answer: 'Single-key shortcuts can be turned off',
    action: { kind: 'settings-general', label: 'Open Settings → General' },
    match: {
      phrases: ['single key shortcuts', 'single letter shortcuts', 'turn off shortcuts', 'disable shortcuts', 'turn off keyboard shortcuts', 'disable keyboard shortcuts', 'turn off the shortcuts'],
      near: [
        ['key', 'keys', 'keyboard', 'shortcut', 'shortcuts', 'hotkey', 'hotkeys', 'letter', 'letters', 'keystrokes'],
        ['accident', 'accidentally', 'by mistake', 'triggers', 'triggered', 'fires', 'fired', 'while typing', 'when typing', 'turn off', 'disable', 'screen reader', 'dictation'],
      ],
    },
  },
  {
    id: 'bro-mode',
    answer: 'Bro mode has agents write to you in plain words',
    experimental: true,
    action: { kind: 'settings-experimental', label: 'Open Settings → Capabilities' },
    match: {
      phrases: ['bro mode', 'plain english', 'plain language', 'plain words', 'explain like', 'eli5', 'too much jargon', 'less jargon', 'talk like a human'],
      near: [
        ['agent', 'agents', 'claude', 'message', 'messages', 'reply', 'replies', 'answers', 'writes', 'writing', 'text', 'tone'],
        ['jargon', 'technical', 'verbose', 'wordy', 'long winded', 'too long', 'too much text', 'hard to understand', 'hard to follow', 'simpler words'],
      ],
    },
  },
  {
    id: 'voice',
    answer: 'Talk instead of typing: turn on Voice',
    action: { kind: 'settings-voice', label: 'Open Settings → Voice' },
    feature: 'Voice',
    match: {
      phrases: ['voice', 'dictate', 'dictation', 'speech to text', 'microphone', 'mic', 'talk instead of typing', 'speak instead of typing'],
    },
  },
  {
    id: 'machines',
    answer: 'See the agents on your other computers here',
    action: { kind: 'settings-machines', label: 'Open Settings → Machines' },
    match: {
      phrases: [
        'other computer', 'other computers', 'another computer', 'second computer', 'two computers', 'multiple computers', 'other machine', 'other machines', 'another machine',
        'multiple machines', 'two machines', 'remote machine', 'remote machines', 'link machines', 'link my machines', 'link my computers', 'dev box', 'devbox',
      ],
    },
  },
  {
    id: 'snooze',
    answer: 'Snooze a thread from the top bar',
    link: { label: 'What changed in 0.28.46', href: `${RELEASE}v0.28.46` },
    feature: 'Snooze a thread',
    match: {
      phrases: ['snooze', 'snoozed', 'snoozing', 'remind me later', 'remind me tomorrow', 'remind me in', 'postpone', 'hide it until', 'hide until'],
    },
  },
  {
    id: 'star',
    answer: 'Star a thread from its ⋯ menu',
    link: { label: 'What changed in 0.28.51', href: `${RELEASE}v0.28.51` },
    feature: 'Star a thread',
    match: {
      phrases: [
        'star a thread', 'star threads', 'star thread', 'starred threads', 'starred thread', 'pin a thread', 'pin threads', 'pin thread', 'pinned threads', 'favorite a thread', 'favorite threads',
        'favourite a thread', 'favourite threads', 'mark as favorite', 'mark as favourite', 'bookmark a thread', 'bookmark threads',
      ],
    },
  },
  {
    id: 'unread',
    answer: 'Mark a thread unread from its row or its header',
    link: { label: 'What changed in 0.28.43', href: `${RELEASE}v0.28.43` },
    feature: 'Mark unread',
    match: {
      phrases: ['mark unread', 'mark as unread', 'mark it unread', 'mark it as unread', 'keep unread', 'keep it unread', 'unread again', 'back to unread'],
    },
  },
  {
    id: 'checklist',
    answer: 'Agents can keep a checklist of their steps in each thread',
    action: { kind: 'settings-capabilities', label: 'Open Settings → Capabilities' },
    match: {
      phrases: ['checklist', 'check list', 'todo list', 'to do list', 'todos', 'task list', 'list of steps'],
    },
  },
  {
    id: 'board',
    answer: 'The Board shows the work in flight, one card per piece',
    action: { kind: 'settings-capabilities', label: 'Open Settings → Capabilities' },
    match: {
      phrases: ['kanban', 'trello', 'project board', 'task board', 'board view', 'work in flight', 'what all my agents are doing', 'what every agent is doing', 'turn off the board', 'hide the board', 'disable the board'],
    },
  },
  {
    id: 'decision-mode',
    answer: 'Decision mode lets you answer agents one decision at a time',
    experimental: true,
    action: { kind: 'settings-experimental', label: 'Open Settings → Capabilities' },
    match: {
      phrases: ['decision mode', 'too many questions', 'one question at a time'],
      near: [
        ['question', 'questions', 'decision', 'decisions'],
        ['one at a time', 'one by one', 'overwhelming', 'at once', 'step through', 'pile up', 'piling up'],
      ],
    },
  },
  {
    id: 'float-drafts',
    answer: 'Float reply drafts keeps an unsent reply in a corner',
    experimental: true,
    action: { kind: 'settings-experimental', label: 'Open Settings → Capabilities' },
    match: {
      phrases: ['float reply drafts', 'floating draft', 'floating drafts', 'floating reply', 'unsent reply', 'reply in a corner', 'draft in a corner'],
      near: [
        ['reply', 'replies', 'draft', 'drafts', 'what i typed', 'what i wrote'],
        ['lose', 'lost', 'losing', 'gone', 'switch threads', 'other thread', 'another thread', 'leave the thread', 'keep it open', 'while i read'],
      ],
    },
  },
  {
    id: 'plan-review-off',
    answer: 'Plan review in Claude Code can be turned off',
    link: { label: 'How, in 0.28.52', href: `${RELEASE}v0.28.52` },
    match: {
      whenBroken: true,
      phrases: ['turn off plan review', 'disable plan review', 'skip plan review', 'without plan review', 'no plan review', 'plan review off', 'planreview'],
      near: [
        ['plan review', 'plan reviews', 'plan mode', 'plan approval', 'exitplanmode'],
        ['turn off', 'disable', 'skip', 'bypass', 'opt out', 'every time', 'ssh', "don't want", 'do not want', 'annoying'],
      ],
    },
  },
  {
    id: 'updates',
    answer: 'Plannotator can keep itself up to date',
    action: { kind: 'settings-about', label: 'Open Settings → About' },
    match: {
      phrases: ['auto update', 'auto updates', 'autoupdate', 'automatic update', 'automatic updates', 'update automatically', 'updates automatically', 'keep it up to date', 'how do i update', 'how to update', 'how do i upgrade', 'how to upgrade', 'update plannotator', 'upgrade plannotator'],
    },
  },
  {
    id: 'prompts',
    answer: 'Change what Plannotator tells your agents',
    action: { kind: 'settings-prompts', label: 'Open Settings → Prompts' },
    match: {
      phrases: ['custom prompt', 'custom prompts', 'customize the prompt', 'edit the prompt', 'edit prompts', 'change the prompt', 'change the prompts', 'inbox reminder', 'agent instructions', 'custom instructions', 'what the agent is told', 'what agents are told'],
    },
  },
  {
    id: 'tour',
    answer: 'Take the two minute tour again',
    action: { kind: 'settings-general', label: 'Open Settings → General' },
    match: {
      phrases: ['tour', 'onboarding', 'tutorial', 'walkthrough', 'how does this work', 'how does it work', 'how do i use this', 'how do i use it', 'getting started', 'where do i start'],
    },
  },
];

/** Lowercase, accents off, every run of other characters one space, a space at each end; apostrophes kept inside words ("doesn't"). */
function fold(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])'/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${words} `;
}

/** A negation just before a word ("doesn't move", "no longer jumps"): praise, not a complaint. */
const NEGATED = /\b(doesn't|does not|don't|do not|never|no longer|not|stopped|stop)\s+(\S+\s+)?$/;
/** Something reported broken. */
const BROKEN =
  / (broken|broke|breaks|crash|crashes|crashed|crashing|error|errors|fails|failed|failing|bug|buggy|freezes|froze|frozen|hangs|blank)( |$)| (doesn't|does not|don't|do not|won't|will not|can't|cannot|can not|isn't|is not|aren't|are not|wasn't|stopped) (work|works|working|open|opens|load|loads|show|shows|showing|start|starts|run|runs|launch|appear|appears)( |$)/;
/** The subject and the symptom within this many words of each other. */
const WINDOW = 8;

/** Where each whole term starts, as word indexes, skipping negated ones. */
function positions(words: string[], terms: string[]): number[] {
  const found: number[] = [];
  for (const term of terms) {
    const parts = fold(term).trim().split(' ');
    for (let at = 0; at + parts.length <= words.length; at += 1) {
      if (parts.every((part, offset) => words[at + offset] === part) && !NEGATED.test(` ${words.slice(Math.max(0, at - 3), at).join(' ')} `.trimEnd() + ' ')) found.push(at);
    }
  }
  return found;
}

function matches(answer: KnownAnswer, folded: string, words: string[], broken: boolean): boolean {
  if (broken && !answer.match.whenBroken) return false;
  if (answer.match.phrases?.some((phrase) => folded.includes(fold(phrase)))) return true;
  const groups = answer.match.near;
  if (!groups?.length) return false;
  const found = groups.map((group) => positions(words, group));
  return found[0]!.some((start) => found.every((others) => others.some((at) => Math.abs(at - start) <= WINDOW)));
}

/** The one known answer for what is typed, or null. The first that matches wins; `hidden` ids are skipped (an answer this Inbox can't follow). */
export function knownAnswerFor(text: string, hidden: readonly string[] = []): KnownAnswer | null {
  const folded = fold(text.slice(0, 4000));
  if (!folded.trim()) return null;
  const words = folded.trim().split(' ');
  const broken = BROKEN.test(folded);
  return KNOWN_ANSWERS.find((answer) => !hidden.includes(answer.id) && matches(answer, folded, words, broken)) ?? null;
}

/**
 * The answers this Inbox can't follow, from its settings read: starting agents where it is not offered (Windows),
 * and a switch the Inbox does not report (an older Inbox, or a tailnet guest's read). Nothing until settings load.
 */
export function hiddenKnownAnswers(
  settings: { launch?: { unsupported?: boolean }; board?: unknown; steps?: unknown; bro?: unknown; float_drafts?: unknown; experimental?: unknown } | null,
): string[] {
  if (!settings) return [];
  const missing = (value: unknown, id: string) => (value ? [] : [id]);
  return [
    ...(settings.launch?.unsupported ? ['start-agents'] : []),
    ...missing(settings.board, 'board'),
    ...missing(settings.steps, 'checklist'),
    ...missing(settings.bro, 'bro-mode'),
    ...missing(settings.float_drafts, 'float-drafts'),
    ...missing(settings.experimental, 'decision-mode'),
  ];
}

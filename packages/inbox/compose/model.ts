/**
 * Compose (approval record "inbox-compose-to-agent"): the pure rules the
 * dialog, the picker, the Drafts page and the palette's Actions share. No
 * React and no requests here, so each rule is tested alone.
 */

import { derivePersonThreadSubject, suggestPersonThreadName } from '@plannotator/core/inbox-questions';
import { checkInboxThreadName, INBOX_HOST_NAMES, type InboxComposeLaunch, type InboxComposeProject, type InboxComposeSession, type InboxLaunchAgent, type InboxDraft, type InboxDraftTo } from '@plannotator/core/inbox-types';
import { inboxScratchSlug } from '@plannotator/core/inbox-scratch';
import { whenTime } from '../format';

/** One live session with the project it works in: what To names. */
export interface ComposeTarget extends InboxComposeSession {
  project: InboxComposeProject['project'];
}

/** A project's live sessions, and whether it is the current project (the picker draws it first). */
export interface ComposeGroup {
  project: InboxComposeProject['project'];
  current: boolean;
  sessions: ComposeTarget[];
}

export const hostLabel = (host: string): string => INBOX_HOST_NAMES[host] ?? host;

/**
 * A project's name in its two parts: the folder's own name, and the parent
 * folders the Inbox adds when two projects share it ("main · workspaces/worktrees",
 * `inboxProjectLabels`), or null. To keeps the first whole and cuts the parents.
 */
export function splitProjectName(name: string): { folder: string; parents: string | null } {
  const at = name.indexOf(' · ');
  return at > 0 ? { folder: name.slice(0, at), parents: name.slice(at + 3) || null } : { folder: name, parents: null };
}

/** Every live session, in the server's order (the most recently active project first). */
export function composeTargets(projects: readonly InboxComposeProject[]): ComposeTarget[] {
  return projects.flatMap((group) => group.sessions.map((session) => ({ ...session, project: group.project })));
}

export function findTarget(projects: readonly InboxComposeProject[], session: string | null | undefined): ComposeTarget | null {
  if (!session) return null;
  return composeTargets(projects).find((target) => target.session === session) ?? null;
}

/** Whether a project group is the project the person is looking at (the list's filter, or the open thread's). */
const isCurrent = (project: InboxComposeProject['project'], current: { id: string | null; root: string | null } | null): boolean =>
  !!current && ((current.id !== null && project.id === current.id) || (current.root !== null && project.root === current.root));

/**
 * The picker's groups: the session the person last sent to first (while it
 * is live; its project leads, with that session first in it), then the
 * current project, then the others in the server's order. `last` only orders
 * the list: To is never filled from it (`composeOpening`).
 */
export function composeGroups(
  projects: readonly InboxComposeProject[],
  current: { id: string | null; root: string | null } | null,
  last: string | null = null,
): ComposeGroup[] {
  const groups = projects.map((group) => ({
    project: group.project,
    current: isCurrent(group.project, current),
    sessions: group.sessions.map((session) => ({ ...session, project: group.project })),
  }));
  const ordered = [...groups.filter((g) => g.current), ...groups.filter((g) => !g.current)];
  const at = last ? ordered.findIndex((g) => g.sessions.some((s) => s.session === last)) : -1;
  if (at < 0) return ordered;
  const lead = ordered[at]!;
  const sessions = [...lead.sessions.filter((s) => s.session === last), ...lead.sessions.filter((s) => s.session !== last)];
  return [{ ...lead, sessions }, ...ordered.filter((_, i) => i !== at)];
}

/** The groups narrowed by the picker's filter: host, project name or path, and the last thread's subject. */
export function filterGroups(groups: readonly ComposeGroup[], query: string): ComposeGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const matches = (target: ComposeTarget) => {
    const hay = [hostLabel(target.host), target.host, target.project.name, target.project.root, target.last_thread?.subject ?? ''].join(' ').toLowerCase();
    return words.every((word) => hay.includes(word));
  };
  return groups.map((group) => ({ ...group, sessions: group.sessions.filter(matches) })).filter((group) => group.sessions.length > 0);
}

/** One row of the To picker: a live session, and its start time only when its project has another live session. */
export interface PickerRow {
  target: ComposeTarget;
  /** "6:33 PM", to tell two sessions of one project apart; null when the session is its project's only one. */
  started: string | null;
}

/**
 * The picker's rows, one line per live session, in the groups' order (the
 * current project first, then the most recently active). Whether a row shows
 * its start time is decided over `all` (every live session, not the filtered
 * ones), so typing a filter never changes a row's words.
 */
export function pickerRows(shown: readonly ComposeGroup[], all: readonly ComposeGroup[] = shown): PickerRow[] {
  const counts = new Map(all.map((group) => [group.project.root, group.sessions.length]));
  return shown.flatMap((group) =>
    group.sessions.map((target) => ({ target, started: (counts.get(group.project.root) ?? group.sessions.length) > 1 ? whenTime(target.started_at) : null })),
  );
}

/**
 * What To names when compose opens, and where focus starts. A plain New
 * message opens with To empty and focus on To, so the person picks the agent
 * first (the owner: "I keep sending messages to the wrong agent"). To is
 * filled only where the person already chose: a reopened draft keeps its own
 * session (an ended one included), and "Message <host>" (the palette, the
 * first-run screen) names its session; focus then starts in the message.
 * A draft saved with nobody in To opens the same way as a plain one.
 */
export function composeOpening(request: { draft?: Pick<InboxDraft, 'to'> | null; session?: string | null }): { chosen: string | null; focus: 'to' | 'message' } {
  const chosen = request.draft ? (request.draft.to?.session ?? null) : (request.session ?? null);
  return { chosen, focus: chosen ? 'message' : 'to' };
}

/** "started 2:41 PM": when the session started, without its host. */
export function startedLine(target: Pick<ComposeTarget, 'started_at'>): string {
  return `started ${whenTime(target.started_at)}`;
}

/** The status chip: a word, never colour alone. */
export const busyWord = (target: Pick<ComposeTarget, 'busy'>): 'Working' | 'Idle' => (target.busy ? 'Working' : 'Idle');

/** The subject a message starts its thread with: the store's own rule for a thread the person starts (core), so the preview never differs. */
export function subjectPreview(body: string, files: readonly string[] = []): string | null {
  return body.trim() ? derivePersonThreadSubject(body, { files }) : null;
}

/**
 * The thread name the person typed, as the Send would take it: '' for none,
 * else the trimmed name, or an error in the thread-name rules' words.
 */
export function composeThreadName(value: string): { name: string } | { error: string } {
  if (value.trim() === '') return { name: '' };
  const checked = checkInboxThreadName(value);
  return checked.ok ? { name: checked.name } : { error: `Thread name ${checked.message}` };
}

/**
 * The thread chip in compose: one name, which follows the message (compose's
 * suggestion, `suggestPersonThreadName`) until the person types in it. From
 * then on it is theirs (`edited`) and never changes by itself; emptied, it
 * follows the message again. A draft keeps `typed` only while `edited`.
 */
export interface ThreadNameState {
  typed: string;
  edited: boolean;
}

/** The chip as a draft (or a new message) opens: the draft's typed name, else following the message. */
export function threadNameStateOf(draft: Pick<InboxDraft, 'thread_name'> | null | undefined): ThreadNameState {
  const typed = draft?.thread_name ?? '';
  return typed.trim() ? { typed, edited: true } : { typed: '', edited: false };
}

/** The person typed in the chip: theirs, unless they emptied it (then it follows the message again). */
export function typeThreadName(value: string): ThreadNameState {
  return value.trim() ? { typed: value, edited: true } : { typed: '', edited: false };
}

/** The name compose suggests for the message: the core rule, so the chip and the store agree. */
export function suggestThreadName(body: string, files: readonly string[] = []): string {
  return suggestPersonThreadName(body, { files });
}

/** What the chip shows: the typed name, else the suggestion. */
export function shownThreadName(state: ThreadNameState, suggested: string): string {
  return state.edited ? state.typed : suggested;
}

/**
 * What a Send carries for the chip: the typed name (checked by the thread-name
 * rules), else the suggestion marked `thread_name_auto` (best effort: the
 * server drops one it cannot use, and the agent may rename it), else nothing.
 */
export function sendThreadName(state: ThreadNameState, suggested: string): { thread_name?: string; thread_name_auto?: true } | { error: string } {
  if (state.edited) {
    const named = composeThreadName(state.typed);
    if ('error' in named) return named;
    return named.name ? { thread_name: named.name } : {};
  }
  return suggested.trim() ? { thread_name: suggested.trim(), thread_name_auto: true } : {};
}

/** What a draft keeps of the chip: the typed name, or '' while it follows the message. */
export function draftThreadName(state: ThreadNameState): string {
  return state.edited ? state.typed : '';
}

/** A draft's one-line snippet: its words after the subject line, whitespace folded. */
export function draftSnippet(body: string): string {
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  return lines
    .slice(first + 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a draft names as its addressee, for a session that may have ended. */
export function draftTo(target: ComposeTarget): InboxDraftTo {
  return { host: target.host, session: target.session, project_root: target.project.root, project_name: target.project.name, started_at: target.started_at };
}

/** The dialog's state as a draft compares it: words, addressee and files. */
export interface ComposeSnapshot {
  body: string;
  session: string | null;
  files: readonly string[];
  /** The thread name the person typed in the chip (`draftThreadName`); absent counts as none. */
  threadName?: string;
  /** The Board chip is on (approval "inbox-compose-board-chip"); absent counts as off. */
  board?: boolean;
}

export function draftSnapshot(draft: Pick<InboxDraft, 'body' | 'to' | 'files' | 'thread_name' | 'board_request'> | null): ComposeSnapshot {
  return {
    body: draft?.body ?? '',
    session: draft?.to?.session ?? null,
    files: (draft?.files ?? []).map((file) => file.upload_id),
    threadName: draft?.thread_name ?? '',
    board: draft?.board_request === true,
  };
}

/** Where the browser keeps the Board chip's last choice (approval "inbox-compose-board-chip": remembered per browser). */
export const COMPOSE_BOARD_CHOICE_KEY = 'plannotator-inbox-compose-board';

/** The Board chip's last choice in this browser: off unless it was last turned on. */
export function composeBoardChoice(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(COMPOSE_BOARD_CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keep the Board chip's choice for the next compose in this browser. */
export function rememberComposeBoardChoice(on: boolean): void {
  try {
    if (on) localStorage.setItem(COMPOSE_BOARD_CHOICE_KEY, '1');
    else localStorage.removeItem(COMPOSE_BOARD_CHOICE_KEY);
  } catch {
    // Storage refused (private mode, quota): the choice lasts this compose only.
  }
}

/**
 * Whether closing would lose something: the words or files differ from what
 * was saved (nothing, for a new message). An empty new message is never
 * dirty, so opening compose and closing it creates nothing. A change of To
 * alone on an empty message is not worth asking about.
 */
export function isDirty(now: ComposeSnapshot, saved: ComposeSnapshot, savedExists: boolean): boolean {
  const empty = now.body.trim() === '' && now.files.length === 0 && (now.threadName ?? '').trim() === '';
  if (!savedExists) return !empty;
  return (
    now.body !== saved.body ||
    now.session !== saved.session ||
    now.files.join('\n') !== saved.files.join('\n') ||
    (now.threadName ?? '').trim() !== (saved.threadName ?? '').trim() ||
    (now.board === true) !== (saved.board === true)
  );
}

/**
 * The status line beside Send: why nothing can be sent yet. With an agent chosen it is empty (the
 * thread's own delivery line says Queued / Sending / Delivered once it is sent).
 */
export function statusLine(input: {
  target: ComposeTarget | null;
  anyLive: boolean;
  ended: InboxDraftTo | null;
  projectName: string | null;
  /** The live sessions are not read yet. */
  loading?: boolean;
}): string {
  if (input.loading) return 'Looking for live agents…';
  if (input.target) return '';
  if (input.ended) return 'That session has ended.';
  if (input.anyLive) return 'Choose an agent to send it.';
  return input.projectName ? `No agent is running in ${input.projectName}.` : 'No agent is running.';
}

/** What ⌘↵ says when nothing can be sent. */
export const NOTHING_SENT_NO_AGENT = 'Nothing sent: no live agent is chosen. Save it as a draft.';

/** The Drafts page chip's words: "Claude Code is live", "That session ended", "No agent chosen". */
export function draftChip(draft: Pick<InboxDraft, 'to'> & { status: 'live' | 'ended' | 'none' }): string {
  if (draft.status === 'live' && draft.to) return `${hostLabel(draft.to.host)} is live`;
  if (draft.status === 'ended') return 'That session ended';
  return 'No agent chosen';
}

/** The words that open "New message…" from the palette (the brief's list). */
const ACTION_WORDS = ['new', 'message', 'idea', 'ask', 'send'];

/** A typed word that calls an action: the whole word, or 3 letters or more of its start ("mes", not "me"). */
const callsAction = (word: string): boolean => ACTION_WORDS.some((action) => action === word || (word.length >= 3 && action.startsWith(word)));

/**
 * The query names an action word whole ("new", "send"): its actions sit above
 * the search results. Otherwise they sit below any results.
 */
export function namesActionWord(query: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .some((word) => ACTION_WORDS.includes(word));
}

export type ComposeAction = { kind: 'new' } | { kind: 'message'; target: ComposeTarget };

/**
 * The palette's Actions group. An empty query: "New message…" and the session
 * the person last sent to, while it is live. Typed words: "New message…" when
 * a word is one of the action words or 3 letters or more of one's start, and
 * each live session whose host or project matches every word (at most 4).
 */
export function composeActions(query: string, targets: readonly ComposeTarget[], last: string | null): ComposeAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const lastTarget = last ? targets.find((t) => t.session === last) : undefined;
    return [{ kind: 'new' }, ...(lastTarget ? [{ kind: 'message' as const, target: lastTarget }] : [])];
  }
  const out: ComposeAction[] = [];
  if (words.some(callsAction)) out.push({ kind: 'new' });
  const named = targets.filter((target) => {
    const hay = `${hostLabel(target.host)} ${target.host} ${target.project.name}`.toLowerCase();
    return words.every((word) => hay.includes(word) || callsAction(word));
  });
  // Only when a word names the session (not the action words alone).
  const naming = words.filter((word) => !callsAction(word));
  if (naming.length > 0) for (const target of named.slice(0, 4)) out.push({ kind: 'message', target });
  return out;
}

export const actionLabel = (action: ComposeAction): string =>
  action.kind === 'new' ? 'New message…' : `Message ${hostLabel(action.target.host)} in ${action.target.project.name}`;

// ── Launch: start a new session from To (behind `inboxLaunch.enabled`; docs/agent-guides/inbox-launch.md) ──

/** A project the folder menu lists (`InboxComposeLaunch.projects`). */
export type LaunchProject = InboxComposeLaunch['projects'][number];

/** What To names when the person picked "<agent> New session": the agent and the project it starts in. */
export interface ComposeStart {
  agent: InboxLaunchAgent;
  /** "Claude Code". */
  name: string;
  /** A scratch start's is `scratchProject`: the root, not a project of the Inbox's. */
  project: LaunchProject;
  /** A new scratch folder ("New scratch folder" in the folder menu), made when the person sends. */
  scratch?: true;
}

/** The folder menu's "New scratch folder" as the pick (`ComposeStart.project.id`): never a project id (`prj_…`). */
export const SCRATCH_PICK = 'scratch';

/** A scratch start's stand-in project: the root it is made in (the folder itself is named when the person sends). */
export function scratchProject(root: string): LaunchProject {
  return { id: SCRATCH_PICK, name: 'New scratch folder', root, exists: true };
}

/** The scratch folder a Send would make for this thread name (the server adds `-2`, `-3` when it is taken). */
export function scratchFolderOf(root: string, threadName: string): string {
  return `${root.replace(/\/+$/, '')}/${inboxScratchSlug(threadName)}`;
}

/** The folder menu shows "New scratch folder" for no filter, or one its words match. */
export function scratchMatches(query: string): boolean {
  return queryWords(query).every((w) => 'new scratch folder'.includes(w));
}

const queryWords = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The project a new session starts in by default: the one the person is looking at, else the most recently active. */
export function defaultStartProject(launch: InboxComposeLaunch | undefined, current: { id: string | null; root: string | null } | null): LaunchProject | null {
  if (!launch || launch.projects.length === 0) return null;
  return launch.projects.find((p) => isCurrent(p, current)) ?? launch.projects[0]!;
}

/**
 * The picker's "Start a new session in <project>" block for a filter: the
 * project the caption names and the agents to offer. Words naming an agent
 * ("claude") narrow the rows; the other words pick the project ("billing"
 * moves the caption to billing-svc). No match: no block.
 */
export function startBlock(
  launch: InboxComposeLaunch | undefined,
  current: { id: string | null; root: string | null } | null,
  query: string,
): { project: LaunchProject; agents: InboxComposeLaunch['agents'] } | null {
  const fallback = defaultStartProject(launch, current);
  if (!launch || !fallback || launch.agents.length === 0) return null;
  const all = queryWords(query);
  const agentHay = (name: string) => `${name} new session`.toLowerCase();
  const namesAgent = (word: string) => launch.agents.some((a) => agentHay(a.name).includes(word));
  const projectWords = all.filter((word) => !namesAgent(word));
  const project = projectWords.length === 0 ? fallback : launch.projects.find((p) => projectWords.every((w) => `${p.name} ${p.root}`.toLowerCase().includes(w)));
  if (!project) return null;
  const agentWords = all.filter(namesAgent);
  const agents = launch.agents.filter((a) => agentWords.every((w) => agentHay(a.name).includes(w)));
  return agents.length ? { project, agents } : null;
}

/** The folder menu's rows for its filter: name or path. */
export function filterLaunchProjects(projects: readonly LaunchProject[], query: string): LaunchProject[] {
  const all = queryWords(query);
  return projects.filter((p) => all.every((w) => `${p.name} ${p.root}`.toLowerCase().includes(w)));
}

/** The status line beside Send for a start: where it runs, or that the folder is gone (screens 02 and 13). */
export function startStatusLine(start: ComposeStart, folder: string): string {
  return start.project.exists ? `${start.name} starts in ${folder} when you send.` : 'Pick a folder to start in.';
}

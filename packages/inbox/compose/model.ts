/**
 * Compose (approval record "inbox-compose-to-agent"): the pure rules the
 * dialog, the picker, the Drafts page and the palette's Actions share. No
 * React and no requests here, so each rule is tested alone.
 */

import { parseInboxGitUrl } from '@plannotator/core/inbox-git-url';
import { derivePersonThreadSubject, suggestPersonThreadName } from '@plannotator/core/inbox-questions';
import { checkInboxThreadName, INBOX_DRAFT_BODY_MAX, INBOX_HOST_NAMES, type InboxComposeLaunch, type InboxComposeProject, type InboxComposeSession, type InboxLaunchAgent, type InboxDraft, type InboxDraftTo } from '@plannotator/core/inbox-types';
import { INBOX_SCRATCH_PICK, inboxScratchSlug } from '@plannotator/core/inbox-scratch';
import { inboxLaunchNotReadyWords, inboxMachineLaunchWords } from '@plannotator/core/inbox-launch-ready';
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
  // A session in another folder of a combined project shows that folder, under the group's name.
  return projects.flatMap((group) => group.sessions.map((session) => ({ ...session, project: session.root ? { ...group.project, root: session.root } : group.project })));
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
    sessions: composeTargets([group]),
  }));
  const ordered = [...groups.filter((g) => g.current), ...groups.filter((g) => !g.current)];
  const at = last ? ordered.findIndex((g) => g.sessions.some((s) => s.session === last)) : -1;
  if (at < 0) return ordered;
  const lead = ordered[at]!;
  const sessions = [...lead.sessions.filter((s) => s.session === last), ...lead.sessions.filter((s) => s.session !== last)];
  return [{ ...lead, sessions }, ...ordered.filter((_, i) => i !== at)];
}

/** The groups narrowed by the picker's filter: host, label, project name or path, and the last thread's subject. */
export function filterGroups(groups: readonly ComposeGroup[], query: string): ComposeGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const matches = (target: ComposeTarget) => {
    const hay = [hostLabel(target.host), target.host, target.label ?? '', target.project.name, target.project.root, target.last_thread?.subject ?? ''].join(' ').toLowerCase();
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

/** A draft over the Inbox's limit, said plainly (the server's own words name a field). */
export const DRAFT_TOO_LONG = `Too long to save as a draft: a draft holds at most ${INBOX_DRAFT_BODY_MAX.toLocaleString('en-US')} characters.`;

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

/** A typed word that calls "New review…". */
const callsReview = (word: string): boolean => word.length >= 3 && ['review', 'pull'].some((action) => action.startsWith(word) || word === action);

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

export type ComposeAction = { kind: 'new' } | { kind: 'review' } | { kind: 'message'; target: ComposeTarget };

/**
 * The palette's Actions group. An empty query: "New message…" and the session
 * the person last sent to, while it is live. Typed words: "New message…" when
 * a word is one of the action words or 3 letters or more of one's start, and
 * each live session whose host or project matches every word (at most 4).
 */
export function composeActions(query: string, targets: readonly ComposeTarget[], last: string | null, reviews = false): ComposeAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const lastTarget = last ? targets.find((t) => t.session === last) : undefined;
    return [{ kind: 'new' }, ...(reviews ? [{ kind: 'review' as const }] : []), ...(lastTarget ? [{ kind: 'message' as const, target: lastTarget }] : [])];
  }
  const out: ComposeAction[] = [];
  if (words.some(callsAction) && !(reviews && words.some(callsReview))) out.push({ kind: 'new' });
  // "New review…" (Settings → Capabilities → Code review): "review", "pull", and "new" as New message's own.
  if (reviews && words.some((word) => callsReview(word) || word === 'new')) out.push({ kind: 'review' });
  const named = targets.filter((target) => {
    const hay = `${hostLabel(target.host)} ${target.host} ${target.project.name}`.toLowerCase();
    return words.every((word) => hay.includes(word) || callsAction(word));
  });
  // Only when a word names the session (not the action words alone).
  const naming = words.filter((word) => !callsAction(word) && !(reviews && callsReview(word)));
  if (naming.length > 0) for (const target of named.slice(0, 4)) out.push({ kind: 'message', target });
  return out;
}

export const actionLabel = (action: ComposeAction): string =>
  action.kind === 'new' ? 'New message…' : action.kind === 'review' ? 'New review…' : `Message ${hostLabel(action.target.host)} in ${action.target.project.name}`;

// ── Launch: start a new session from To (behind `inboxLaunch.enabled`, on unless false; docs/agent-guides/inbox-launch.md) ──

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
  /**
   * A folder under that machine's home that is not one of its projects ("Another folder on <machine>…"), as the server
   * takes it (`~/code/billing-api`): `project` stands in for it (`folderProject`), and the Send names the folder.
   */
  folder?: string;
  /** With `folder`: Create a folder (approval "launch-create-clone"): the Send makes it. */
  create?: true;
  /** With `folder`: Clone from a git URL (approval "launch-create-clone"): the Send clones the repo into it, then starts. */
  clone?: ComposeClone;
}

/** A clone pick: the URL as pasted (the server reads it again), and what the words name (`acme/billing-api` on github.com). */
export interface ComposeClone {
  url: string;
  host: string;
  slug: string;
  branch?: string;
}

/**
 * A failed clone's Change the URL (E5): the run line asks the window for New message with the URL in the folder
 * menu's filter, To the same agent and machine, and the same words (`ComposeRequest.clone`).
 */
export const COMPOSE_CLONE_EVENT = 'plannotator-inbox:compose-clone';
export interface ComposeCloneRequest {
  url: string;
  agent: string;
  machine: string | null;
  /** The folder the clone was going to (`~/…`). */
  folder: string | null;
  body: string;
}

/** A draft's clone pick as compose holds it, its words read from the URL again (null: the URL is no repo's now). */
export function cloneOfUrl(url: string, branch?: string): ComposeClone | null {
  const repo = parseInboxGitUrl(url);
  if (!repo || repo.kind !== 'repo') return null;
  const pickedBranch = branch ?? repo.branch;
  return { url, host: repo.host, slug: repo.slug, ...(pickedBranch ? { branch: pickedBranch } : {}) };
}

/** A folder start's stand-in project: never a project id, so no project's facts or check marks are taken for it. */
export function folderProject(folder: string, name: string): LaunchProject {
  return { id: `folder:${folder}`, name, root: folder, exists: true };
}

/** A `~/…` path as an absolute one under `home` (as a draft keeps a project's root); as it is without a home. */
export function untildePath(path: string, home: string | null): string {
  if (!home || !(path === '~' || path.startsWith('~/'))) return path;
  return `${home.replace(/\/+$/, '')}${path.slice(1)}`;
}

/** The folder menu's "New scratch folder" as the pick (`ComposeStart.project.id`): never a project id (`prj_…`). */
export const SCRATCH_PICK = INBOX_SCRATCH_PICK;

/** A scratch start's stand-in project: the root it is made in (the folder itself is named when the person sends). */
export function scratchProject(root: string): LaunchProject {
  return { id: SCRATCH_PICK, name: 'New scratch folder', root, exists: true };
}

/** The scratch folder a Send would make for this thread name (the server adds `-2`, `-3` when it is taken). */
export function scratchFolderOf(root: string, threadName: string): string {
  return `${root.replace(/\/+$/, '')}/${inboxScratchSlug(threadName)}`;
}

/** The folder menu shows "Another folder…" for no filter, or one its words match. */
export function otherFolderMatches(query: string): boolean {
  return queryWords(query).every((w) => 'another folder'.includes(w));
}

/** The folder menu shows "New scratch folder" for no filter, or one its words match. */
export function scratchMatches(query: string): boolean {
  return queryWords(query).every((w) => 'new scratch folder'.includes(w));
}

const queryWords = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The project a new session starts in by default: the one the person is looking at, else the most recently active. */
export function defaultStartProject(launch: InboxComposeLaunch | undefined, current: { id: string | null; root: string | null } | null): LaunchProject | null {
  if (!launch || launch.projects.length === 0) return null;
  // The current project by its id first: with linked machines, another machine may have a folder at the same path.
  return (current?.id ? launch.projects.find((p) => p.id === current.id) : undefined) ?? launch.projects.find((p) => isCurrent(p, current)) ?? launch.projects[0]!;
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

/** The status line beside Send for a start: none, as for a message to a live session, unless the folder is gone (screen 13). */
export function startStatusLine(start: ComposeStart): string {
  if (!start.project.exists) return 'Pick a folder to start in.';
  // C13, decision 11a: what the Send does first.
  return start.clone ? `Clones ${start.clone.slug}, then starts ${start.name}.` : '';
}

// ── Remote launch: the folder menu grouped by machine (approval "remote-launch", the picker's A) ──

/** A machine as compose sees it (`GET /api/inbox/machines`). */
export interface LaunchMachine {
  id: string;
  name: string;
  self: boolean;
  state: 'online' | 'connecting' | 'offline' | 'needs_update' | 'revoked';
  since: string;
  /** Agents can start there (true), launch is off there (false), its Inbox is too old to say (null). */
  launch?: boolean | null;
}

/** A linked machine's last good sessions read (its launch block and home), kept while it sleeps. */
export interface MachineLaunchRead {
  launch?: InboxComposeLaunch;
  home: string | null;
}

/** A folder-menu project with the machine it is on: absent for this computer's. */
export type MachineLaunchProject = LaunchProject & { machine?: string; machine_name?: string };

/** One machine's group in the folder menu. */
export interface LaunchGroup {
  /** The machine's id, or null for this computer. */
  machine: string | null;
  name: string;
  self: boolean;
  /** That machine is asleep (offline): what it shows is its last read, and a Send waits for it. */
  asleep: boolean;
  /** The caption's quiet words after the name: "this computer", "asleep", or null. */
  quiet: string | null;
  /** Its home folder, for `~/…` paths (each machine's own). */
  home: string | null;
  projects: MachineLaunchProject[];
  /** The project the person last started an agent in on this machine, when it is listed (drawn first). */
  last: string | null;
  /** "New scratch folder" there. */
  scratch: { root: string } | null;
  /** The agent can't start there: one disabled row in place of its projects. */
  notice: { line: string; command: string | null } | null;
}

/** Where the person last started an agent, per machine id: when, and in which project (from the merged list). */
export type LaunchHistory = ReadonlyMap<string, { at: string; project: string }>;

/**
 * Where the person last started an agent on each machine, from the list's rows: a launched thread's row carries
 * `run` (its key, even when null), and the merged list names its `machine`. Each machine keeps its newest.
 */
export function launchHistory(rows: readonly { machine?: string; project: { id: string }; created_at: string; run?: unknown }[]): Map<string, { at: string; project: string }> {
  const out = new Map<string, { at: string; project: string }>();
  for (const row of rows) {
    if (!row.machine || !('run' in row)) continue;
    const had = out.get(row.machine);
    if (!had || row.created_at > had.at) out.set(row.machine, { at: row.created_at, project: row.project.id });
  }
  return out;
}

/**
 * The folder menu's groups for `agent`. No linked machine (or none with anything to offer): one group, this
 * computer's, and `grouped` false, so the menu is exactly what it was. Otherwise one group per machine with a caption,
 * the machine the person started an agent on last first (this computer first when none says), a project on several
 * machines under each. A machine where the agent can't start shows one disabled line in its words
 * (`inboxLaunchNotReadyWords`, `inboxMachineLaunchWords`). A linked machine never read yet shows nothing.
 */
export function launchGroups(input: {
  agent: InboxLaunchAgent | null;
  /** This computer's launch block and home, and its id and name in the machines list (null before it). */
  self: { launch: InboxComposeLaunch | undefined; home: string | null; id: string | null; name: string | null };
  machines: readonly LaunchMachine[];
  reads: ReadonlyMap<string, MachineLaunchRead>;
  history?: LaunchHistory;
}): { grouped: boolean; groups: LaunchGroup[] } {
  const { agent, self, reads } = input;
  const history = input.history ?? new Map();
  const groupOf = (machine: string | null, name: string, isSelf: boolean, asleep: boolean, block: InboxComposeLaunch | undefined, home: string | null, words: string | null): LaunchGroup | null => {
    const quiet = isSelf ? 'this computer' : asleep ? 'asleep' : null;
    const base = { machine, name, self: isSelf, asleep, quiet, home, projects: [] as MachineLaunchProject[], last: null, scratch: null, notice: null };
    if (words) return { ...base, notice: { line: words, command: null } };
    if (!block || !agent) return null;
    if (block.agents.some((a) => a.agent === agent)) {
      const seen = history.get((isSelf ? self.id : machine) ?? '');
      const listed = block.projects.map((p) => (machine ? { ...p, machine, machine_name: name } : { ...p }));
      const last = seen && listed.some((p) => p.id === seen.project) ? seen.project : null;
      return { ...base, projects: listed, last, scratch: block.scratch ?? null };
    }
    const not = block.not_ready?.find((n) => n.agent === agent);
    if (!not) return null;
    const said = inboxLaunchNotReadyWords({ agent: not.name, code: not.code, machine: isSelf ? null : name, overSsh: not.over_ssh === true });
    return { ...base, notice: { line: said.line, command: said.command } };
  };
  const mine = groupOf(null, self.name ?? 'This computer', true, false, self.launch, self.home, null);
  const linked = input.machines.filter((m) => !m.self && m.state !== 'revoked');
  const theirs = linked.map((m, i) => {
    const asleep = m.state === 'offline';
    const read = reads.get(m.id);
    // Its health says whether launch is on there, but only as of the link's last connect; the machine's own switch
    // (Settings → Agents) is live, so its last sessions read, which carries a launch block only while on, decides.
    const off = m.launch === true || m.launch === false ? (read ? read.launch === undefined : m.launch === false) : false;
    const words = off ? inboxMachineLaunchWords(m.name, 'off') : m.launch === null || m.launch === undefined || m.state === 'needs_update' ? inboxMachineLaunchWords(m.name, 'update') : null;
    return { group: groupOf(m.id, m.name, false, asleep, read?.launch, read?.home ?? null, words), order: i + 1, id: m.id };
  });
  const all = [{ group: mine, order: 0, id: self.id ?? '' }, ...theirs].filter((g): g is { group: LaunchGroup; order: number; id: string } => {
    const group = g.group;
    return !!group && (group.projects.length > 0 || !!group.scratch || !!group.notice);
  });
  const grouped = all.length > 1 || (all.length === 1 && !all[0]!.group.self);
  if (!grouped) return { grouped: false, groups: all.map((g) => ({ ...g.group, last: null })) };
  // The machine the person started an agent on last, first; the rest as they were (this computer, then the linked ones).
  const at = (id: string) => history.get(id)?.at ?? '';
  // In each group, the project the person last started an agent in there leads ("· you started it here last").
  const lead = (g: LaunchGroup): LaunchGroup => (g.last ? { ...g, projects: [...g.projects.filter((p) => p.id === g.last), ...g.projects.filter((p) => p.id !== g.last)] } : g);
  const groups = [...all].sort((a, b) => (at(a.id) === at(b.id) ? a.order - b.order : at(a.id) > at(b.id) ? -1 : 1)).map((g) => lead(g.group));
  return { grouped: true, groups };
}

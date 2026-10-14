/**
 * Compose (approval record "inbox-compose-to-agent"): the pure rules the
 * dialog, the picker, the Drafts page and the palette's Actions share. No
 * React and no requests here, so each rule is tested alone.
 */

import { deriveInboxSubject } from '@plannotator/core/inbox-questions';
import { INBOX_HOST_NAMES, type InboxComposeProject, type InboxComposeSession, type InboxDraft, type InboxDraftTo } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';

/** One live session with the project it works in: what To names. */
export interface ComposeTarget extends InboxComposeSession {
  project: InboxComposeProject['project'];
}

/** A project's sessions as the picker draws them: the current project first, marked. */
export interface ComposeGroup {
  project: InboxComposeProject['project'];
  current: boolean;
  sessions: ComposeTarget[];
}

export const hostLabel = (host: string): string => INBOX_HOST_NAMES[host] ?? host;

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

/** The picker's groups: the current project first (marked "current"), the others in the server's order. */
export function composeGroups(projects: readonly InboxComposeProject[], current: { id: string | null; root: string | null } | null): ComposeGroup[] {
  const groups = projects.map((group) => ({
    project: group.project,
    current: isCurrent(group.project, current),
    sessions: group.sessions.map((session) => ({ ...session, project: group.project })),
  }));
  return [...groups.filter((g) => g.current), ...groups.filter((g) => !g.current)];
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

/**
 * Who To names when compose opens, in order: the session the person last
 * sent to, while it is live; else the most recently active session of the
 * current project; else the most recently active live session anywhere.
 * Nothing when no session is live.
 */
export function preselect(
  projects: readonly InboxComposeProject[],
  options: { last: string | null; current: { id: string | null; root: string | null } | null },
): ComposeTarget | null {
  const last = findTarget(projects, options.last);
  if (last) return last;
  const current = composeGroups(projects, options.current).find((group) => group.current);
  if (current?.sessions[0]) return current.sessions[0];
  return composeTargets(projects)[0] ?? null;
}

/** "Claude Code · started 9:12 AM". */
export function sessionTitle(target: Pick<ComposeTarget, 'host' | 'started_at'>): string {
  return `${hostLabel(target.host)} · started ${whenTime(target.started_at)}`;
}

/** "Last: Inbox search, part 2 · 2:41 PM", or "Hasn't written in the Inbox yet". */
export function lastLine(target: Pick<ComposeTarget, 'last_thread'>): string {
  const last = target.last_thread;
  if (!last) return 'Hasn’t written in the Inbox yet';
  return `Last: ${last.subject ?? '(no subject)'} · ${whenTime(last.at)}`;
}

/** The status chip: a word, never colour alone. */
export const busyWord = (target: Pick<ComposeTarget, 'busy'>): 'Working' | 'Idle' => (target.busy ? 'Working' : 'Idle');

/** The subject a message starts its thread with: the server's own rule (core), so the preview never differs. */
export function subjectPreview(body: string): string | null {
  return body.trim() ? deriveInboxSubject(body, []) : null;
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
}

export function draftSnapshot(draft: Pick<InboxDraft, 'body' | 'to' | 'files'> | null): ComposeSnapshot {
  return { body: draft?.body ?? '', session: draft?.to?.session ?? null, files: (draft?.files ?? []).map((file) => file.upload_id) };
}

/**
 * Whether closing would lose something: the words or files differ from what
 * was saved (nothing, for a new message). An empty new message is never
 * dirty, so opening compose and closing it creates nothing. A change of To
 * alone on an empty message is not worth asking about.
 */
export function isDirty(now: ComposeSnapshot, saved: ComposeSnapshot, savedExists: boolean): boolean {
  const empty = now.body.trim() === '' && now.files.length === 0;
  if (!savedExists) return !empty;
  return now.body !== saved.body || now.session !== saved.session || now.files.join('\n') !== saved.files.join('\n');
}

/** The status line beside Send. */
export function statusLine(input: {
  target: ComposeTarget | null;
  anyLive: boolean;
  ended: InboxDraftTo | null;
  projectName: string | null;
}): string {
  if (input.target) {
    const name = hostLabel(input.target.host);
    return input.target.busy ? `${name} is working; it takes this when its turn ends.` : `${name} takes it as its next turn.`;
  }
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

/** The words that open "New message…" from the palette, and the host and project names that open "Message <host> in <project>". */
const ACTION_WORDS = ['new', 'message', 'idea', 'ask', 'send', 'compose', 'write', 'draft', 'request'];

export type ComposeAction = { kind: 'new' } | { kind: 'message'; target: ComposeTarget };

/**
 * The palette's Actions group. An empty query: "New message…" and the session
 * the person last sent to, while it is live. Typed words: "New message…" when
 * a word starts one of the action words, and each live session whose host or
 * project matches every word (at most 4).
 */
export function composeActions(query: string, targets: readonly ComposeTarget[], last: string | null): ComposeAction[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const lastTarget = last ? targets.find((t) => t.session === last) : undefined;
    return [{ kind: 'new' }, ...(lastTarget ? [{ kind: 'message' as const, target: lastTarget }] : [])];
  }
  const out: ComposeAction[] = [];
  if (words.some((word) => ACTION_WORDS.some((action) => action.startsWith(word) && word.length >= 2))) out.push({ kind: 'new' });
  const named = targets.filter((target) => {
    const hay = `${hostLabel(target.host)} ${target.host} ${target.project.name}`.toLowerCase();
    return words.every((word) => hay.includes(word) || ACTION_WORDS.some((action) => action.startsWith(word)));
  });
  // Only when a word names the session (not the action words alone).
  const naming = words.filter((word) => !ACTION_WORDS.some((action) => action.startsWith(word)));
  if (naming.length > 0) for (const target of named.slice(0, 4)) out.push({ kind: 'message', target });
  return out;
}

export const actionLabel = (action: ComposeAction): string =>
  action.kind === 'new' ? 'New message…' : `Message ${hostLabel(action.target.host)} in ${action.target.project.name}`;

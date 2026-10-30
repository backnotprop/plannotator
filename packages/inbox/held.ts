/**
 * The held list (the approved Workspaces behaviour): while the person reads,
 * the list on screen does not move. New agent activity waits behind the
 * "N new" notice until they press Show, change folder or page. The person's
 * own reads and actions wait too while a thread is open, and settle when it
 * closes (`settleOwn`; when that happens and how it moves: settle.ts). Pure.
 */

import type { InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';

export interface HeldNotice {
  count: number;
  /** "1 new in docs-site", or "3 new" across projects; null when nothing waits. */
  text: string | null;
}

function rowsById(sections: readonly InboxListSection[]): Map<string, InboxListRow> {
  const out = new Map<string, InboxListRow>();
  for (const section of sections) for (const row of section.threads) out.set(row.thread_id, row);
  return out;
}

/**
 * When the row's latest agent message arrived: `last_agent_at`, or, from an
 * Inbox older than that field, `last_at` while the last message is an agent's.
 * The person's replies and the Inbox's own notes (Mark read's set-aside note,
 * a late Undo's reopened note) move `last_at` but are never agent activity,
 * and a note written after an agent message must not hide that message.
 */
function lastAgentAt(row: InboxListRow): string | null {
  if (row.last_agent_at !== undefined) return row.last_agent_at;
  return row.last_author === 'agent' ? row.last_at : null;
}

/**
 * `row` carries agent activity the row on screen (`old`) lacks: a thread an
 * agent started, or a newer agent message (by `lastAgentAt`, so the Inbox's
 * notes never hide one). A row counts only while its last real message is an
 * agent's (`sent` null: `sent` reads past the notes): an agent message the
 * person replied after (in the thread they had open, say) is not news, and
 * neither is a thread unarchived elsewhere whose last word is the person's
 * (Sent, or Quiet after the agent read it). One more exception: a thread not on
 * screen that the person opened in this tab (`openedHere`: a link, a
 * notification, Settings' Unarchive) and whose agent messages they have all
 * seen (`unseen` 0) came in by their own hand (it was archived, say, and they
 * unarchived it). A thread read somewhere else (a phone, another tab) is not
 * exempt: this tab has not shown it, so it stays news here.
 */
function hasNewAgentActivity(old: InboxListRow | undefined, row: InboxListRow, openedHere?: ReadonlySet<string>): boolean {
  const at = lastAgentAt(row);
  // The person's own reply came after the agent's last message (`sent` reads
  // past the notes): whatever the agent wrote before it, they answered, on
  // screen or not. Without notes this is the old `last_author === 'agent'` rule.
  if (at === null || (row.sent ?? null) !== null) return false;
  if (old === undefined) return !(openedHere?.has(row.thread_id) && row.unseen === 0);
  // An older row on screen without the field: compare with its last_at, as before.
  const before = old.last_agent_at !== undefined ? (old.last_agent_at ?? '') : old.last_at;
  return at > before;
}

/**
 * The thread the held list treats as open (design record
 * "inbox-new-in-open-thread", approved 2026-10-12): the thread the person
 * has open, or the one they just closed until the list settles. While it is
 * open, whatever arrives there is its own business (`asOf` absent). Once
 * closed, `asOf` is its list row as it stood at the close (null when the list
 * had none): only what arrived while it was open is exempt, and an agent
 * message after the close is news like any other.
 */
export interface OpenThread {
  threadId: string;
  asOf?: InboxListRow | null;
}

/** `row` is the open thread's, and nothing an agent wrote after the close is in it. */
function isOpenRow(row: InboxListRow, open: OpenThread | null | undefined): boolean {
  if (!open || row.thread_id !== open.threadId) return false;
  if (open.asOf === undefined) return true;
  return open.asOf !== null && !hasNewAgentActivity(open.asOf, row);
}

/**
 * The threads in `latest` with agent activity the list on screen does not
 * show: a thread it lacks, or one whose last message is a newer agent
 * message. The person's own picks, replies and looks never count. `open`:
 * the thread the person has open, or just closed until the list settles
 * (design record "inbox-new-in-open-thread", approved 2026-10-12), which is
 * never counted or named here.
 */
export function heldNotice(
  shown: readonly InboxListSection[],
  latest: readonly InboxListSection[],
  openedHere?: ReadonlySet<string>,
  open?: OpenThread | null,
  /** The window's project names by id (`windowProjectNames`); a project not in it reads its server name. */
  names?: ReadonlyMap<string, string>,
): HeldNotice {
  const before = rowsById(shown);
  // By id: two projects can share a name ("api" at work and at home), and two
  // projects are never "new in api".
  const projects = new Map<string, string>();
  let count = 0;
  for (const row of rowsById(latest).values()) {
    // The thread the person has open (or just closed, until the list settles)
    // is never news here: its own row and its pill say what arrived there.
    if (isOpenRow(row, open)) continue;
    if (!hasNewAgentActivity(before.get(row.thread_id), row, openedHere)) continue;
    count += 1;
    projects.set(row.project.id, names?.get(row.project.id) ?? row.project.name);
  }
  if (count === 0) return { count, text: null };
  return { count, text: projects.size === 1 ? `${count} new in ${[...projects.values()][0]}` : `${count} new` };
}

/**
 * The rows Show brings in (design record "inbox-polish", item 6): each row of
 * `latest` the list on screen lacks, or that carries agent activity the row on
 * screen does not show (so it moved or changed). A row that stays as it was,
 * or that changed only by the person's own hand (already shown in place), is
 * not one of them.
 */
export function showBroughtIn(shown: readonly InboxListSection[], latest: readonly InboxListSection[]): Set<string> {
  const before = rowsById(shown);
  const out = new Set<string>();
  for (const row of rowsById(latest).values()) {
    const old = before.get(row.thread_id);
    if (old === undefined || hasNewAgentActivity(old, row)) out.add(row.thread_id);
  }
  return out;
}

/**
 * The held list with each row's own state brought up to date in place. The
 * rows keep their sections and their order, which wait for an action; but a
 * row whose thread changed without new agent activity (the reply was
 * delivered, an agent read it, the thread was resolved) shows its state as it
 * now is, so a Sent row stops saying "Saved for" once the agent has the
 * reply. A row with new agent activity keeps what was on screen: that change
 * waits behind "N new". A row whose thread is gone stays as it was.
 */
export function refreshHeldRows(shown: readonly InboxListSection[], latest: readonly InboxListSection[], open?: OpenThread | null): InboxListSection[] {
  const fresh = rowsById(latest);
  return shown.map((section) => ({
    ...section,
    threads: section.threads.map((row) => {
      const next = fresh.get(row.thread_id);
      // The open thread's row always tells its state, in place: bold when an
      // agent message arrives, not bold once it is seen (it never moves).
      return next && (isOpenRow(next, open) || !hasNewAgentActivity(row, next)) ? next : row;
    }),
  }));
}

/** The list's own order within a section (packages/shared/inbox/list.ts): newest first, ties on the thread id. */
function newestFirst(left: InboxListRow, right: InboxListRow): number {
  return right.last_at.localeCompare(left.last_at) || left.thread_id.localeCompare(right.thread_id);
}

/**
 * The list settled for the person's own reads and actions only (design
 * record "inbox-open-stays-put", approved 2026-10-12): every row takes the
 * section and the place `latest` gives it, except what an agent did since the
 * list on screen was drawn, which still waits behind "N new · Show". A thread
 * the list on screen lacks and an agent started stays out; a row with a newer
 * agent message keeps the state it had on screen and the place that state
 * gives it. A thread gone from `latest` leaves (an archived one, archived while
 * it was open). Show adopts `latest` whole. `open`: the thread just closed,
 * which settles as it now is whatever arrived while it was open (design
 * record "inbox-new-in-open-thread", decision 2: an arrival the person did
 * not see brings it back unread).
 */
export function settleOwn(
  shown: readonly InboxListSection[],
  latest: readonly InboxListSection[],
  openedHere?: ReadonlySet<string>,
  open?: OpenThread | null,
): InboxListSection[] {
  const before = rowsById(shown);
  const known = new Set(latest.map((section) => section.id));
  const buckets = new Map<string, InboxListRow[]>();
  const put = (sectionId: string, row: InboxListRow) => {
    const bucket = buckets.get(sectionId);
    if (bucket) bucket.push(row);
    else buckets.set(sectionId, [row]);
  };
  for (const section of latest) {
    for (const row of section.threads) {
      const old = before.get(row.thread_id);
      // The thread just closed settles where its state puts it, an agent
      // message that arrived while it was open included: seen, by its state
      // (often Quiet); not yet seen, back as unread (New, or Waiting when it asks).
      if (isOpenRow(row, open) || !hasNewAgentActivity(old, row, openedHere)) put(section.id, row);
      // Archived by the person while it was open (markHeldRowArchived), and an agent wrote in it after
      // the close (an agent message before the close made it the open row, settled above by its state:
      // back unread when not seen): the archive settles (the row leaves) and that message waits behind
      // "N new", like any agent activity.
      else if (old && (old.resolved_at ?? null) !== null && old.back_from_archive !== true) continue;
      // Held: the state on screen, in the section that state sits in.
      else if (old) put(known.has(old.section) ? old.section : section.id, old);
    }
  }
  return latest.map((section) => ({ ...section, threads: (buckets.get(section.id) ?? []).sort(newestFirst) }));
}

/**
 * One row settled, the rest of the list held: where the thread covers the
 * list (a phone, a stacked window) the list is shown on Back exactly as the
 * person left it (settle.ts), except the thread they just closed when an
 * agent message arrived there that they did not see: it comes back unread, in
 * the section its state now gives it (New, or Waiting when it asks), at its
 * place there, instead of staying where it was (folded Quiet, say). Nothing
 * else moves. Without a row for it in `latest` the list stays as it is.
 */
export function settleThread(shown: readonly InboxListSection[], latest: readonly InboxListSection[], threadId: string): InboxListSection[] {
  const next = rowsById(latest).get(threadId);
  if (!next) return shown.map((section) => ({ ...section }));
  return shown.map((section) => {
    const threads = section.threads.filter((row) => row.thread_id !== threadId);
    if (section.id !== next.section) return { ...section, threads };
    const at = threads.findIndex((row) => newestFirst(next, row) < 0);
    threads.splice(at < 0 ? threads.length : at, 0, next);
    return { ...section, threads };
  });
}

/**
 * Where the thread covers the list, does Back move the thread just closed
 * (`settleThread`) instead of showing it as left? Yes when an agent message
 * there is still unseen (it comes back unread), and when the thread now waits
 * on the person (Stopped, Holding, Waiting: an agent asked while it was open,
 * seen or not) and is drawn in another group, so it is never left folded in
 * Quiet with questions open. A thread only read stays where it was left.
 */
export function settlesOnBack(shown: readonly InboxListSection[], row: InboxListRow): boolean {
  if (row.unseen > 0) return true;
  if (row.section !== 'stopped' && row.section !== 'holding' && row.section !== 'waiting') return false;
  const drawn = shown.find((section) => section.threads.some((other) => other.thread_id === row.thread_id));
  return drawn?.id !== row.section;
}

/**
 * The held list with threads the person just started (compose's Send) put in
 * (the owner, 2026-10-16: "When I create a new thread and hit send, why
 * doesn't it show up in the Sent list?"). A thread the person started is
 * their own action, like a pick or a Send in the open thread, which the held
 * list shows at once; it is not agent activity, so nothing about it waits
 * behind "N new". Each row `latest` has for `threadIds` and the list on
 * screen lacks goes into its section at its place there (newest first: the
 * top of Sent); every other row keeps its section and its order. A thread
 * already on screen, or not in `latest`, changes nothing.
 */
export function addOwnThreads(shown: readonly InboxListSection[], latest: readonly InboxListSection[], threadIds: readonly string[]): InboxListSection[] {
  const fresh = rowsById(latest);
  const onScreen = rowsById(shown);
  const adding = threadIds.map((id) => fresh.get(id)).filter((row): row is InboxListRow => row !== undefined && !onScreen.has(row.thread_id));
  // The list always carries all six sections (empty ones included), so the row's section is on screen.
  return shown.map((section) => {
    const threads = [...section.threads];
    for (const row of adding) {
      if (row.section !== section.id) continue;
      const at = threads.findIndex((other) => newestFirst(row, other) < 0);
      threads.splice(at < 0 ? threads.length : at, 0, row);
    }
    return { ...section, threads };
  });
}

/**
 * Everything `latest` says (Show's adopt), except the thread the person has
 * open: its row stays in the group it is drawn in and at its place there
 * (between the same neighbours, never re-sorted by its time), so a refresh
 * beside an open thread (click Inbox to refresh, the list's title) never
 * takes the selected row out of view. Its state is the read's, or, when the
 * read has no row for it (the window reads without archived threads, and the
 * person archived it while it is open), the row as drawn (shown Archived by
 * markHeldRowArchived). It takes its own place when the thread closes. A
 * thread not on screen is the read.
 */
export function adoptKeepingOpen(shown: readonly InboxListSection[], latest: readonly InboxListSection[], threadId: string): InboxListSection[] {
  // The group it is drawn in (a held row's own `section` may already say where it will go).
  const drawn = shown.find((section) => section.threads.some((row) => row.thread_id === threadId));
  if (!drawn) return latest.map((section) => ({ ...section }));
  const at = drawn.threads.findIndex((row) => row.thread_id === threadId);
  const row = rowsById(latest).get(threadId) ?? drawn.threads[at]!;
  return latest.map((section) => {
    const threads = section.threads.filter((other) => other.thread_id !== threadId);
    if (section.id !== drawn.id) return { ...section, threads };
    // Before the nearest row that followed it on screen and is still in this group, else after the nearest that preceded it.
    const here = new Set(threads.map((other) => other.thread_id));
    const after = drawn.threads.slice(at + 1).find((other) => here.has(other.thread_id));
    const before = [...drawn.threads.slice(0, at)].reverse().find((other) => here.has(other.thread_id));
    const index = after
      ? threads.findIndex((other) => other.thread_id === after.thread_id)
      : before
        ? threads.findIndex((other) => other.thread_id === before.thread_id) + 1
        : 0;
    threads.splice(index, 0, row);
    return { ...section, threads };
  });
}

/**
 * The group a thread's row sits in on screen, or null when the list on screen
 * has none for it. While the list holds still this can differ from the row's
 * own `section`, which says where it will settle.
 */
export function drawnSection(shown: readonly InboxListSection[] | null, threadId: string): InboxSectionId | null {
  return shown?.find((section) => section.threads.some((row) => row.thread_id === threadId))?.id ?? null;
}

/**
 * Undo of a row moved on screen only (Mark read on a seen update held in New,
 * markRead.ts `seenHeldInNew`): the row goes back into the group it was drawn
 * in `before`, between the same neighbours, in its state as it is now; every
 * other row stays as it is on screen. A row no longer on screen stays out.
 */
export function putRowBack(shown: readonly InboxListSection[], before: readonly InboxListSection[], threadId: string): InboxListSection[] {
  if (drawnSection(shown, threadId) === null) return shown.map((section) => ({ ...section }));
  return adoptKeepingOpen(before, shown, threadId);
}

/**
 * The person archived a thread while its row is on screen (the thread is
 * open). The list the window reads leaves archived threads out, so
 * refreshHeldRows would keep the row as it was; this shows it archived in
 * place instead ("Archived", not bold), where it stays until the person
 * leaves the thread and the list catches up without it.
 */
export function markHeldRowArchived(shown: readonly InboxListSection[], threadId: string, at: string): InboxListSection[] {
  return shown.map((section) => ({
    ...section,
    threads: section.threads.map((row) =>
      row.thread_id === threadId ? { ...row, resolved_at: row.resolved_at ?? at, section: 'quiet' as const, unread: false } : row,
    ),
  }));
}

/** One project's rows only; the sections stay, empty ones included. */
export function filterSections(sections: readonly InboxListSection[], projectId: string | null): InboxListSection[] {
  if (!projectId) return sections.map((s) => ({ ...s }));
  return sections.map((s) => ({ ...s, threads: s.threads.filter((row) => row.project.id === projectId) }));
}

/** The rows that wait on the person (Stopped, Holding, Waiting): the sidebar counts. */
export function waitingCount(sections: readonly InboxListSection[], projectId?: string): number {
  let n = 0;
  for (const section of sections) {
    if (section.id !== 'stopped' && section.id !== 'holding' && section.id !== 'waiting') continue;
    for (const row of section.threads) if (!projectId || row.project.id === projectId) n += 1;
  }
  return n;
}

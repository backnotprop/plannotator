import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { HueDot, LetterMark, ProjectMark, showsProjects, showsThreads, useRowMarks } from '../letterMarks';
import { inboxListShortcuts } from '../shortcuts/list.shortcuts';
import { ShortcutHint, shortcutAria, useShortcutAria, withShortcut } from '../shortcuts/hint';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { agentName, formatCount, fullTime, shortTime, waitCount, whenTime } from '../format';
import { reaskRowLine, sentRowLine, undeliveredLabel } from '../deliveryLine';
import { sentRecipientsWords } from '../tags';
import { TagStack } from './TagPicker';
import { RowAgents, RowAgentTiles } from './RowAgents';
import { isTextCut, ProjectTipText, Tip } from './Tip';
import { LazyRowTips, opensTips, RowTip } from './RowTip';
import { AuthorMark, Icon } from '../icons';
import { StepGlyph } from '../steps/StepsMarks';
import { starPopping } from '../starPop';
import { notePressPointer, pressRow } from '../starPress';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { canMarkUnread, offersRowMarkRead } from '../markRead';
import { useNarrowerThan } from '../narrower';
import { inboxHasUnsent, inboxRowArchived } from '@plannotator/core/inbox-types';
import { DraftLabel, rowUnsent, unsentWords } from './DraftLabel';
import { ThreadRowMenu } from './RowMenu';
import type { RowMenuAction } from '../rowMenu';
import { rowTimeIso, rowWait } from '../rowDelivery';
import { UndeliveredBadge, useMinuteClock } from './Undelivered';
import { TimeWithTick } from './DeliveryTick';
import { ActionBadge, RowBadge, WaitCard, badgeDescription, rowActionCount, rowHasBadge, shownCount } from './RowBadge';
import { StatusMark, rowStatus } from './RowStatus';
import { attachPullToRefresh } from '../pullRefresh';
import { TidyMenu, type TidyController } from './Tidy';
import { awayLine, type MachinesModel } from '../machines';
import { listLookClasses, useListLook } from '../listLook';
import { flatRows, useListView, type ListPlaces, type ListSort } from '../listView';
import { useListGroups } from '../listGroups';
import { useInboxTextSize } from '../textSize';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { relativeTime, relativeWords, useRelativeClock } from '../relativeTime';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { bareKeyAllowed, isComposingKey, keyboardFocused, keyTarget, modalOpen } from '../shortcuts/guards';
import { listKeyTarget, LIST_STOPS, type ListMove } from '../listKeys';

export interface InboxListProps {
  title: string;
  /** The project's folder, `~/src/billing-svc`, when one project is shown: in the title's tooltip, never drawn in the header. */
  path: string | null;
  sections: readonly InboxListSection[];
  /** One project is shown: its rows drop the project label. */
  filtered: boolean;
  /**
   * The window's name for each project (`windowProjectNames`): its folder, the parent added only when two
   * projects on screen share it. Absent, or a project not in it: the server's name.
   */
  projectNames?: ReadonlyMap<string, string>;
  /**
   * A pane is beside the list, a thread's or the empty thread panel's: a
   * column of its own width (380px, or wider where the person dragged its
   * edge), three-line rows until it is wide enough for the wide ones.
   */
  narrow: boolean;
  selectedThreadId: string | null;
  /**
   * The held list's "N new" (held.ts `heldNotice`): how many, and the one project they are in when all are in
   * one. Always one line: a long project name is cut with "…", the whole line then in a tooltip.
   */
  notice: { count: number; project?: string | null } | null;
  /**
   * When the list on screen was last sorted whole (listView.ts `ListSort`): List keeps each row's place between
   * sorts, as the groups do. Absent: every render is a sort (a list that never holds, the tour).
   */
  sort?: ListSort;
  /** This page is older than the Inbox (StalePageNotice, stalePage.ts): at the list's top, above the notifications line. */
  stale?: ReactNode;
  /** The one-time notifications line (record 6.1), above everything else. */
  ask?: ReactNode;
  onShowNew: () => void;
  /**
   * The title, pressed, refreshes the list it names (click Inbox to refresh):
   * ↻ beside it on hover with the tooltip, one turn on a click. Absent: a plain heading.
   */
  onRefresh?: () => void;
  /**
   * Pull down to refresh, on a phone only (pullRefresh.ts): the same refresh as the title, its promise
   * settling when the read lands (the ↻ spins until then). Absent: no gesture.
   */
  onPullRefresh?: () => Promise<unknown>;
  /** A refresh of this list just ran: the title's icon turns once (the key restarts the turn). */
  refreshSpin?: number | null;
  onOpen: (row: InboxListRow) => void;
  /** The row's hover action (a row that waits on the person): Mark read, without opening it. Absent: no action. */
  onMarkRead?: (row: InboxListRow) => void;
  /** The row's hover action on a read row (markRead.ts `canMarkUnread`): Mark unread, in Mark read's place. Absent: none. */
  onMarkUnread?: (row: InboxListRow) => void;
  /** The row's hover action on a reply waiting on a busy agent that can take it now: Send now. Absent: no action. */
  onSendNow?: (row: InboxListRow) => void;
  /** A phone (phone.ts): the list fills the window and its rows are a mail app's. */
  phone?: boolean;
  /** The column's id: the Inbox's own list is `ib-list`, the skip link's target (App.tsx). */
  columnId?: string;
  /**
   * The live stream is dead (liveStream.ts): one quiet muted line under the list, "Reconnecting…", gone with the
   * stream's next frame. The live region says it (App.tsx), so the line itself is not live.
   */
  reconnecting?: boolean;
  /** The project shown (null: every project). A phone opens another project's list at its top, as a mail app opens another mailbox. */
  scope?: string | null;
  /** Opens search: on a phone, the list header's search icon (inbox.css shows it there only). */
  onSearch?: (opener: HTMLElement) => void;
  /**
   * Opens compose: the list header's compose icon, on a phone beside search, and on a wider window at the
   * header's far right while the main sidebar (which has its own) is closed.
   */
  onCompose?: (opener: HTMLElement) => void;
  /** What an empty list says (one project whose threads are all archived). Drawn only while no row shows. */
  empty?: ReactNode;
  /**
   * The rows Show just brought in (new to the list, or moved or changed by an
   * agent): each lights up briefly where it landed (`data-lit`, inbox.css).
   */
  lit?: ReadonlySet<string>;
  /**
   * The row's right-click menu (Copy link, Copy thread ID, Mark read or
   * Move back, Archive). Absent: no menu, the browser's own.
   */
  onRowAction?: (row: InboxListRow, action: RowMenuAction) => void;
  /** A press on a starred row's star. Absent (an older Inbox keeps no pins): the star is only a mark. */
  onUnstar?: (row: InboxListRow) => void;
  /** Snooze a row until a moment, from its menu (approval "inbox-snooze"). Absent (an older Inbox keeps no snoozes): no Snooze. */
  onSnooze?: (row: InboxListRow, until: string) => void;
  /** Whether a row can be snoozed (a linked machine on an older Inbox keeps no snoozes). Absent: every row can. */
  snoozesOf?: (row: InboxListRow) => boolean;
  /**
   * The threads pinned to the sidebar (approval "inbox-pinned-threads"): their
   * rows carry a small pin, and the row menu offers Pin or Unpin. Absent (an
   * older Inbox keeps no pins): neither.
   */
  pinned?: ReadonlySet<string>;
  /**
   * Tidy (2026-10-28): the header's ⋮ menu (Tidy, Refresh) and the run's line
   * at the top of the list. Absent: no menu.
   */
  tidy?: TidyController;
  /**
   * Linked machines (machines.ts): rows of a machine that is away are greyed, a line says since when ("MacBook
   * asleep since 10:42 AM"), and the ⋯ menu offers "Hide offline machines". No machine linked: none of it.
   */
  machines?: MachinesModel;
  /** The machine the list shows (the sidebar's filter): only its own line, if it is away. */
  machineScope?: string | null;
  hideAway?: boolean;
  onHideAway?: (hide: boolean) => void;
  /** The ⋮ menu's thread panel item (threadPanel.ts). Absent (a phone, the tour): no item. */
  threadPanel?: { on: boolean; onChange: (on: boolean) => void };
  /**
   * The person's look options (listLook.ts) and closed groups (listGroups.ts) from this browser. False (the
   * onboarding tour): today's list, every option off and every group at its default, whatever this browser chose,
   * as the tour's sidebar ignores its closed sections.
   */
  rememberLook?: boolean;
  /** The ⋮ menu's "Customize rows…": Settings → Rows. Absent (the tour): no item. */
  onCustomizeRows?: () => void;
}

/**
 * Whom a row is about: the agent that wrote the thread, or, for a thread the
 * person started (compose), the agent it is addressed to (`addressee`), so the
 * row draws that agent's mark and name, never the person's.
 */
export function rowAgent(row: InboxListRow): InboxListRow['author'] {
  return row.addressee ? { kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } : row.author;
}

/**
 * The badge card's footer mark: the agent's, or, when several agents are in the thread, their marks overlapping
 * (Lines). The row itself draws its agents before the project, on tiles: `RowAgents` on a wide row, `RowAgentTiles`
 * on a three-line or phone row.
 */
function RowMark({ row }: { row: InboxListRow }) {
  // Agent icons off (Settings → Rows) takes the agent's mark off the card too; its name stays in words beside it.
  const { hideAgents } = useRowMarks();
  if (hideAgents) return null;
  if ((row.participants?.length ?? 0) > 1) return <TagStack participants={row.participants!} />;
  return <AuthorMark author={rowAgent(row)} />;
}

/**
 * The row has keyboard focus (`:focus-visible`): its badge's card shows, as it
 * does on hover (approval "inbox-row-badges"). A click's focus does not count.
 * Escape closes the card and keeps focus on the row; that Escape is used up
 * (default prevented), so the window's Escape does not also close the thread.
 * The card comes back the next time the row takes keyboard focus.
 */
function useKeyboardFocus(enabled: boolean): [
  boolean,
  { onFocus: (e: FocusEvent<HTMLElement>) => void; onBlur: () => void; onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void },
] {
  const [on, setOn] = useState(false);
  return [
    on,
    {
      onKeyDown: (e) => {
        if (!on || e.key !== 'Escape' || e.target !== e.currentTarget || e.defaultPrevented) return;
        e.preventDefault();
        setOn(false);
      },
      onFocus: (e) => {
        if (!enabled || e.target !== e.currentTarget) return;
        let visible = false;
        try {
          visible = e.currentTarget.matches(':focus-visible');
        } catch {
          visible = false;
        }
        setOn(visible);
      },
      onBlur: () => setOn(false),
    },
  ];
}

/** The row's badge with its hover card (wide and three-line rows), or null. `words`: the triangle and its words (a wide row). */
function badgeOf(row: InboxListRow, kbd: boolean, words = false): ReactNode {
  if (!rowHasBadge(row)) return null;
  const card = <WaitCard row={row} agent={agentName(rowAgent(row))} mark={<RowMark row={row} />} time={shortTime(rowTimeIso(row))} />;
  return <RowBadge row={row} card={card} open={kbd} words={words} />;
}

/** A snoozed row's return time, with the clock: where the row's words go (approval "inbox-snooze"). */
function SnoozedUntil({ row }: { row: InboxListRow }) {
  if (!row.snoozed) return null;
  return (
    <span className="ib-zwhen" data-snoozed-until={row.snoozed.until} title={fullTime(row.snoozed.until)}>
      <Icon name="clock" size={13} />
      <span className="ib-sr">Snoozed until </span>
      {inboxSnoozeWhen(row.snoozed.until)}
    </span>
  );
}

/** The row's time. A thread back from a snooze shows a small clock before it until the person reads it. */
function RowTime({ row, relative = false }: { row: InboxListRow; relative?: boolean }) {
  // A relative time moves on by itself: the shared minute clock renders it again (only while it is on).
  const now = useRelativeClock(relative);
  const iso = rowTimeIso(row);
  // Relative: a screen reader hears "4 minutes ago" (never "4m"), and the pointer's tooltip gives the clock time.
  const time = relative ? (
    <span className="ib-trel" data-relative-time="" title={whenTime(iso)}>
      <span aria-hidden="true">{relativeTime(iso, now)}</span>
      <span className="ib-sr">{relativeWords(iso, now)}</span>
    </span>
  ) : (
    shortTime(iso)
  );
  return (
    <>
      {row.snooze_back && (
        <span className="ib-zback" data-snooze-back-mark="" role="img" aria-label="Back from snooze">
          <Icon name="clock" size={13} />
        </span>
      )}
      <TimeWithTick delivery={row.delivery} time={time} />
    </>
  );
}

/** The badge card's words for a screen reader, beside the row (the row names it in `aria-describedby`). */
function BadgeWords({ row, id }: { row: InboxListRow; id: string }) {
  if (!rowHasBadge(row)) return null;
  return (
    <span hidden id={id}>
      {badgeDescription(row)}
    </span>
  );
}

/**
 * The subject cell's words. A row keeps its own subject: the delivery glyph
 * by its time says where the person's reply is (approval "inbox-row-delivery").
 * An older Inbox sends no `delivery`: its Sent row says it in words instead.
 */
function subjectOf(row: InboxListRow): string {
  // A thread the person started keeps its own subject in Sent; its count cell says whom it went to.
  // A reply that tags agents (approval "inbox-tag-agents", Lines): how many have it, and who waits.
  if (row.section === 'sent' && !row.addressee && row.sent?.recipients?.length) return sentRecipientsWords(row.sent.recipients);
  // A Re-ask note waits on the agent to ask again (approval "inbox-reask"): its own words, beside the delivery tick.
  if (row.section === 'sent' && row.reask_pending) return reaskRowLine(agentName(rowAgent(row)), row.sent?.checked_at ?? null, row.sent?.wakes);
  if (row.section === 'sent' && !row.addressee && !row.delivery) return sentRowLine(agentName(rowAgent(row)), row.sent?.wakes);
  return row.subject ?? '(no subject)';
}

/** The row's title (approval "list-rows-mail-icons", 2026-10-30): the thread's name, or its subject when it has none. */
function titleOf(row: InboxListRow): string {
  return row.thread_name?.trim() ? row.thread_name : subjectOf(row);
}

/**
 * A row's title (`titleOf`), plain, or with "Highlight thread subject" on (approval
 * "inbox-list-options") in the thread chip's pill (`.ib-key`, the open thread's pill), at the title's own size and
 * cut to one line. `className` is the shape's title class (`ib-title`, `ib-m2`). `tip`: a title that can be cut
 * (a wide row's, one in its pill, or one on a compact row's line 1) shows its whole text in a tooltip while it is
 * cut (`ClipText`).
 */
function RowTitle({ row, className, pill, tip = false }: { row: InboxListRow; className: string; pill: boolean; tip?: boolean }) {
  const cls = pill ? `ib-keyt ${className}` : className;
  const title = tip ? (
    <ClipText className={cls} text={titleOf(row)} />
  ) : (
    <span className={cls} dir="auto">
      {titleOf(row)}
    </span>
  );
  const out = pill ? <span className="ib-key ib-rowkey">{title}</span> : title;
  return <TitleMark row={row}>{out}</TitleMark>;
}

/** Letter marks (letterMarks.tsx), style "Inline": a 20 px tile before the title; style "Dot": the thread's hue alone. */
function TitleMark({ row, children }: { row: InboxListRow; children: ReactNode }) {
  const { marks } = useRowMarks();
  if (marks.style === 'avatar' || !showsThreads(marks.what)) return <>{children}</>;
  return (
    <span className="ib-lm-tt" data-take={marks.style}>
      {marks.style === 'inline' ? <LetterMark name={titleOf(row)} seed={row.thread_id} size={20} /> : <HueDot seed={row.thread_id} />}
      {children}
    </span>
  );
}

/** Letter marks, style "Avatar": one mark per row in a column of its own, the thread's with the project's on its corner. */
function RowAvatar({ row, size }: { row: InboxListRow; size: 24 | 30 }) {
  const { marks } = useRowMarks();
  if (marks.style !== 'avatar' || marks.what === 'off') return null;
  const project = row.project?.name ?? '';
  const threads = showsThreads(marks.what);
  const projects = showsProjects(marks.what);
  return (
    <span className="ib-lm-av" data-size={size} aria-hidden="true">
      {threads ? <LetterMark name={titleOf(row)} seed={row.thread_id} size={size} solid /> : <ProjectMark projectId={row.project_id} name={project} size={size} solid />}
      {threads && projects && project && <ProjectMark projectId={row.project_id} name={project} size={size === 30 ? 14 : 12} solid className="ib-lm-badge" />}
    </span>
  );
}

/** Letter marks, style "Inline": the project's mark before its name in a row. */
function RowProjectMark({ row }: { row: InboxListRow }) {
  const { marks } = useRowMarks();
  if (marks.style !== 'inline' || !showsProjects(marks.what) || !row.project?.name) return null;
  return <ProjectMark projectId={row.project_id} name={row.project.name} size={16} className="ib-lm-rowp" />;
}

/** Whether the row leads with an avatar (style "Avatar", some marks on): three-line and phone rows make room for it. */
function useAvatarRow(): boolean {
  const { marks } = useRowMarks();
  return marks.style === 'avatar' && marks.what !== 'off';
}

/**
 * The grey preview under or after the title: the subject of a named thread (`subjectOf`, so a Sent row's words
 * too), nothing under an unnamed one, whose subject is its title, or when the subject only repeats the name.
 */
function previewOf(row: InboxListRow): string | null {
  if (!row.thread_name?.trim()) return null;
  const subject = subjectOf(row);
  return subject.trim() === row.thread_name.trim() ? null : subject;
}

/**
 * A wide row's first cell (approval "list-rows-mail-icons"; the owner, 2026-10-31: the marks first, the project
 * hugging them): the agents' marks, a 6 px gap, then the project, as on a three-line row. The project is left out in
 * one project's list, which leaves the marks alone, and the title follows them 6 px later. The cell is one line: the
 * project gives way with "…" (its tooltip shows it whole), the marks never do.
 *
 * The project comes first in the DOM, so a screen reader reads where, then who, as on a three-line row
 * (`LeadLine`); CSS (`order`) draws the marks first.
 */
function FromLine({ row, project, filtered }: { row: InboxListRow; project: string; filtered: boolean }) {
  return (
    <span className="ib-from">
      <RowAvatar row={row} size={24} />
      {!filtered && <RowProjectMark row={row} />}
      {!filtered && <ClipText className="ib-p" text={project} />}
      <RowAgents participants={row.participants} agent={rowAgent(row)} />
      <StepsWaitMark row={row} />
    </span>
  );
}

/**
 * The checklist on a row (approval "inbox-checklist-spinners-2026-11-07", the calm row): the row never moves. Nothing
 * while an agent works on a step; only the still amber pause, after the project, while a step waits on the person.
 */
function StepsWaitMark({ row }: { row: InboxListRow }) {
  if (!row.steps_waiting) return null;
  return (
    <span className="ib-strow" role="img" aria-label="Checklist: waiting on you" title="Checklist: waiting on you" data-row-steps-waiting="">
      <StepGlyph status="waiting" size={12} />
    </span>
  );
}

/**
 * Line 1's start in a three-line or phone row (approval "inbox-list-row-v2", 2026-10-30): the agents' tiles, then
 * the project hugging them, as a sidebar row's icon hugs its name. The tiles are a bounded run, so the project always
 * keeps the rest of the line: it never wraps, it ends in "…" (its tooltip shows it whole; not on a phone, where a
 * hover is a first tap). The project is left out in one project's list, which leaves the tiles alone.
 *
 * The project comes first in the DOM and the tiles after it, so a screen reader reads where, then who, as on a wide
 * row (`FromLine`), not every agent's name first; CSS (`.ib-lead > .ib-atiles`, `order: -1`) draws the tiles first.
 */
function LeadLine({ row, project, filtered, tip = true }: { row: InboxListRow; project: string; filtered: boolean; tip?: boolean }) {
  // What it draws is `leadParts`: anything new drawn here goes there too, or a row could fold it away (`leadEmpty`).
  const { project: withProject } = leadParts(filtered, false);
  return (
    <span className="ib-from ib-lead">
      {withProject && <RowProjectMark row={row} />}
      {withProject &&
        (tip ? (
          <ClipText className="ib-p" text={project} />
        ) : (
          <span className="ib-p" dir="auto">
            {project}
          </span>
        ))}
      <RowAgentTiles participants={row.participants} agent={rowAgent(row)} tip={tip} />
      <StepsWaitMark row={row} />
    </span>
  );
}

/**
 * What the count says in words (approval "inbox-row-byline"), or null: the open counts (`OpenCounts`) or nothing. A
 * three-line or phone row draws `short` in its 124 px slot (option A, 2026-10-29) and says `full` in the tooltip and its
 * name; a wide row draws `long`, the full words (the owner, 2026-10-29: full words in full-width mode). Open action
 * items are no longer words here (approval "inbox-row-action-icon", 2026-10-29): they are the action pill beside `?N`.
 */
function countWords(row: InboxListRow, now: number, tickAlone = false): { short: ReactNode; long: ReactNode; full: string } | null {
  const same = (words: string) => ({ short: words, long: words, full: words });
  // A reply waiting on a busy agent (approval "inbox-busy-agent-reply"): how long, in place of the count.
  const wait = rowWait(row.delivery);
  if (wait) return { short: <UndeliveredBadge wait={wait} now={now} />, long: <UndeliveredBadge wait={wait} now={now} full />, full: undeliveredLabel(wait.since, now) };
  // Settings → Rows' Status mark on a done row (the owner, 2026-11-07, q-8e0e9490): the tick alone says it, so none of
  // the words saying why a row is Quiet (Archived, Read, 👍 Looks good). Any other words stay.
  const why = !(tickAlone && rowStatus(row) === 'done');
  // A Quiet row says why it is there: archived (resolved), or marked read.
  if (why && inboxRowArchived(row)) return same('Archived');
  // What the person has not sent (approval "inbox-reply-drafts"): "Draft", and "Draft · Your reply, 2 picks" in full.
  if (row.unsent && inboxHasUnsent(row.unsent)) return { short: <DraftLabel unsent={row.unsent} short />, long: <DraftLabel unsent={row.unsent} />, full: `Draft · ${unsentWords(rowUnsent(row.unsent))}` };
  // Marked read with 👍 Looks good: the row says so in place of "Read".
  if (why && row.section === 'quiet' && (row.read_at ?? null) !== null && row.ack) return same(`👍 ${row.ack.label}`);
  if (why && row.section === 'quiet' && (row.read_at ?? null) !== null) return same('Read');
  // An older Inbox (no `unsent`): its own words.
  if (row.answered_not_sent) return { short: 'Answered', long: 'Answered, not sent', full: 'Answered, not sent' };
  // An agent the person started from New message (launch): one muted word while it starts or works.
  if (row.run) return same(row.run === 'starting' ? 'Starting' : row.run === 'cloning' ? 'Cloning' : 'Working');
  if (row.section === 'sent' && row.addressee) return same(`To ${agentName(rowAgent(row))}`);
  return null;
}

/** A group's count: its rows but those archived and waiting for the list to settle without them, as the sidebar counts. */
function liveCount(rows: readonly InboxListRow[]): number {
  let n = 0;
  for (const row of rows) if (!inboxRowArchived(row)) n += 1;
  return n;
}

/**
 * The held list's "N new" line: one line at every width (the owner, 2026-11-02: "1 new in appnotes · Users/ramos/…"
 * wrapped onto two). "N new in" and Show never shrink; the project's name takes the rest and is cut with "…", and
 * while it is cut the whole line is the tooltip.
 */
function HeldNoticeLine({ count, project, onShow }: { count: number; project: string | null; onShow: () => void }) {
  const full = project ? `${count} new in ${project}` : `${count} new`;
  return (
    <Tip content={full} when={(button) => isTextCut(button.querySelector('.ib-notice-proj'))}>
      <button type="button" className="ib-notice" onClick={onShow} data-inbox-notice="">
        <Icon name="inbox" size={15} />
        <span className="ib-notice-text">
          <span className="ib-notice-n">{project ? `${count} new in` : `${count} new`}</span>
          {/* A space for the line's text and accessible name; the flex gap draws it. */}
          {project && ' '}
          {project && (
            <bdi className="ib-notice-proj" data-notice-project={project}>
              {project}
            </bdi>
          )}
        </span>
        <b>Show</b>
      </button>
    </Tip>
  );
}

/**
 * The count in words (`countWords`), nothing when the count is `?N` or there is none. A three-line or phone row draws
 * the short form, its full words for a screen reader and, with `tip`, in the tooltip. A wide row (`wide`) draws the
 * full words in its words column; cut there, they are the tooltip too.
 */
function CountWords({ row, tip = false, wide = false, status = false }: { row: InboxListRow; tip?: boolean; wide?: boolean; status?: boolean }) {
  const now = useMinuteClock(rowWait(row.delivery) !== null);
  const words = countWords(row, now, status);
  if (!words) return null;
  const quiet = row.section === 'quiet' ? ' ib-qlabel' : '';
  if (wide) {
    return (
      <RowTip content={words.full} when={(cell) => cell.scrollWidth > cell.clientWidth + 0.5 || [...cell.querySelectorAll('.ib-cst, .ib-draft-l')].some((t) => t.scrollWidth > t.clientWidth + 0.5)}>
        <span className={`ib-c ib-cwords ib-cfull${quiet}`} data-count-words={words.full}>
          <span className="ib-cs">{typeof words.long === 'string' ? <span className="ib-cst">{words.long}</span> : words.long}</span>
        </span>
      </RowTip>
    );
  }
  const cell = (
    <span className={`ib-c ib-cwords${quiet}`} data-count-words={words.full}>
      <span className="ib-cs" aria-hidden="true">
        {typeof words.short === 'string' ? <span className="ib-cst">{words.short}</span> : words.short}
      </span>
      <span className="ib-sr">{words.full}</span>
    </span>
  );
  return tip ? <RowTip content={words.full}>{cell}</RowTip> : cell;
}

/** "Session ended": the session this row's thread would reach has ended (the server's `session_ended`; only a host that can tell). */
function EndedMark({ row }: { row: InboxListRow }) {
  if (!row.session_ended) return null;
  return (
    <span className="ib-gone ib-rended" data-row-ended="">
      Session ended
    </span>
  );
}

/**
 * The row's count (approval "inbox-row-byline", 2026-10-29): at the right end of a three-line or phone row's line 3.
 * What waits on the person is the action pill and `?N` (`OpenCounts`); anything else in words (`CountWords`).
 */
function LineCount({ row, tip = false, status = false }: { row: InboxListRow; tip?: boolean; status?: boolean }) {
  return (
    <>
      <EndedMark row={row} />
      <CountWords row={row} tip={tip} status={status} />
      {/* Settings → Rows' Status mark: one mark in place of the open counts, their words its name and tooltip. */}
      {status ? <StatusMark row={row} tip={tip} /> : <OpenCounts row={row} tip={tip} />}
    </>
  );
}

/**
 * What a row's open counts (`OpenCounts`) draw, as a key: its open action items and questions, or '' when it draws
 * none. Two rows with the same key draw the same counts.
 */
function openCountsKey(row: InboxListRow): string {
  if (row.questions.open < 1 || countWords(row, 0) !== null) return '';
  return `${rowActionCount(row)}/${row.questions.open}`;
}

/**
 * What waits on the person, when the row has no words (approval "inbox-row-action-icon", 2026-10-29): the open
 * action items' pill (`ActionBadge`, A2), then the open questions' `?N` (Q3). Under the alert badge in emphasis.
 */
function OpenCounts({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  if (!openCountsKey(row)) return null;
  return (
    <>
      <ActionBadge row={row} tip={tip} />
      <QuestionCount row={row} tip={tip} />
    </>
  );
}

/**
 * `?N`, the open questions (action items left out, `ActionBadge` counts those): a speech bubble with a "?" (approval
 * "inbox-row-action-icon", Q3) and the number, from one question on, in quiet text with no pill; its words for a
 * screen reader and in the tooltip. Otherwise nothing.
 */
function QuestionCount({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  const open = row.questions.open - rowActionCount(row);
  if (open < 1) return null;
  const words = waitCount(open, 0) || '1 question';
  const cell = (
    <span className="ib-c ib-qn" data-open-count={open}>
      <Icon name="questionBubble" size={14} className="ib-qbub" />
      <span aria-hidden="true">{shownCount(open)}</span>
      <span className="ib-sr">{words}</span>
    </span>
  );
  return tip ? <RowTip content={words}>{cell}</RowTip> : cell;
}

/**
 * One line of text the row may cut with "…": ui's tooltip shows it whole on
 * hover (`Tip`; the window's provider sets the delays), only while it is cut. Never a
 * focus stop, and nothing for a screen reader to add: the row's name already
 * holds the whole text.
 */
function ClipText({ className, text }: { className: string; text: string }) {
  return (
    <RowTip content={text} cut>
      <span className={className} dir="auto">
        {text}
      </span>
    </RowTip>
  );
}

/**
 * The thread's name as a soft pill, cut with "…" (its tooltip shows it whole), or nothing.
 * `name` is what `threadChipName` gave. The open thread (Thread.tsx) draws it first in its
 * meta line. The list's
 * rows no longer draw it: their title is the name (approval "list-rows-mail-icons").
 */
export function ThreadChip({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span className="ib-key">
      <ClipText className="ib-keyt" text={name} />
    </span>
  );
}

/** A three-line row's grey preview (`previewOf`), cut with "…" (its tooltip shows it whole), or nothing. */
function Preview({ row }: { row: InboxListRow }) {
  const preview = previewOf(row);
  return preview ? <ClipText className="ib-pv" text={preview} /> : null;
}

/** The record's 1.1: a thread that carries a guided review says so after its subject. */
function GuideMark({ row }: { row: InboxListRow }) {
  if (!row.guide || row.section === 'sent') return null;
  return (
    <RowTip content="Guided review" when={guideLabelHidden}>
      <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review">
        <Icon name="book" size={13} />
        <span className="ib-att-l">Guided review</span>
      </span>
    </RowTip>
  );
}

/**
 * The wide row's title cell (approval "list-rows-mail-icons"): the title, the grey preview and the guided review
 * mark. Short of room the preview gives way first, all the way, then the title; each cut ends in "…" with its
 * tooltip. The mark drops its label to its icon.
 */
function TitleCell({ row, pill = false, noPreview = false }: { row: InboxListRow; pill?: boolean; noPreview?: boolean }) {
  const preview = noPreview ? null : previewOf(row);
  return (
    <>
      <RowTitle row={row} className="ib-title" pill={pill} tip />
      {preview && <ClipText className="ib-pv" text={preview} />}
      <GuideMark row={row} />
    </>
  );
}

/**
 * A pinned thread's small pin in its list row (approval "inbox-pinned-threads"): always on the right, beside the
 * counts (the owner, 2026-10-31: "just like the questions, just like the action items"), never right after a short
 * preview. A three-line or phone row has it on line 3 before the badge and the counts; a wide row in a column of its
 * own just left of the open counts' column. For the eye only: the row's name ends with ", pinned" (`PinnedWords`).
 */
function PinMark({ threadId, press = false }: { threadId: string; press?: boolean }) {
  return (
    <span className="ib-pinmark" data-pin-mark="" data-star-press={press ? '' : undefined} data-pop={starPopping(threadId) ? '' : undefined} aria-hidden="true">
      <Icon name="star" size={13} />
    </span>
  );
}

/** The end of a pinned row's accessible name. */
function PinnedWords() {
  return <span className="ib-sr">, starred</span>;
}

/**
 * Below this list width the wide row of every project leaves its title cell
 * too little room (the project and agents, words, badge, open counts and time
 * columns are fixed at 220px, 124px, 52px, 84px and 76px), so the list draws
 * the three-line rows instead.
 */
export const WIDE_ROWS_MIN_LIST_WIDTH = 900;

/**
 * One project's list has no project column, so it keeps the wide row down to this list width: what the row can't
 * give up with the pin's column (303px: its padding, gaps, badge, pin, open counts and time), three tiles and "+99"
 * (73px), the words' floor (62px) and that row's title floor (56px). The default sidebar leaves a 500px list at the
 * narrowest desktop window, so only a wider sidebar reaches this; the list then draws the three-line rows.
 */
export const ONE_PROJECT_WIDE_ROWS_MIN_LIST_WIDTH = 496;

/**
 * From this list width a wide row draws the full words and the badge's words (the owner, 2026-10-29: full words in
 * full-width mode; a 1440px window with the sidebar gives a 1192px list). Narrower wide rows keep approval
 * "inbox-row-byline", option A (the short forms, the bare triangle), so the subject keeps its room.
 */
export const FULL_WORDS_MIN_LIST_WIDTH = 1150;

/** The wide rows' open counts column, as inbox.css draws it (`.ib-row`'s grid). */
const COUNTS_COLUMN_PX = 84;

/**
 * In a list with the pin's column (`.ib-pincol`), widen the open counts' column for the whole list to the widest
 * counts drawn ("[□ 12] ?12", "[□ 99+] ?99+" pass its 84px), so every pin stays in one column 8px before its row's
 * counts and none runs under a pin. The counts sit at their column's right edge, so their width is the column's right
 * edge less their leftmost part, whatever the column's width: a second pass gives the same answer. Without pins, or
 * with counts that fit, the column keeps its 84px (`--ib-cq-w` unset).
 *
 * Cells with the same parts and text draw the same counts at the same width (no row state restyles them), so only
 * one cell of each is read. A read lays out its row (rows are `content-visibility: auto`), and a list has far fewer
 * different counts than rows: reading every row cost about 25 ms at 700 rows, on every open of a thread and every
 * return to the list. False when the list is not drawn (nothing in it has a box), so the caller fits it again later.
 */
function fitCountsColumn(list: HTMLElement, pinColumn: boolean): boolean {
  let widest = 0;
  let drawn = true;
  if (pinColumn) {
    const alike = new Map<string, HTMLElement[]>();
    for (const cell of list.querySelectorAll<HTMLElement>('.ib-row > .ib-cq')) {
      if (!cell.firstElementChild) continue;
      // What the cell draws: each part's classes and text (its tooltip's id differs on every row).
      const key = [...cell.children].map((part) => `${part.getAttribute('class')}\t${part.textContent}`).join('\n');
      const cells = alike.get(key);
      if (cells) cells.push(cell);
      else alike.set(key, [cell]);
    }
    groups: for (const cells of alike.values()) {
      for (const cell of cells) {
        const lefts = [...cell.children].map((part) => part.getBoundingClientRect()).filter((box) => box.width > 1).map((box) => box.left);
        if (lefts.length) {
          widest = Math.max(widest, cell.getBoundingClientRect().right - Math.min(...lefts));
          break;
        }
        // Nothing of this cell drawn: try the next alike cell, unless the whole list is undrawn (then none is).
        if (list.getClientRects().length === 0) {
          drawn = false;
          widest = 0;
          break groups;
        }
      }
    }
  }
  const width = widest > COUNTS_COLUMN_PX ? `${Math.ceil(widest)}px` : '';
  if (list.style.getPropertyValue('--ib-cq-w') !== width) {
    if (width) list.style.setProperty('--ib-cq-w', width);
    else list.style.removeProperty('--ib-cq-w');
  }
  return drawn;
}

/** The page's zoom (device pixels per CSS pixel), read again on each resize: a zoom changes it, and text widths with it. */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio));
  useEffect(() => {
    const read = () => setRatio(window.devicePixelRatio);
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return ratio;
}

/**
 * One row of the wide list, on one line (approval "inbox-row-byline", the
 * one-line row; its cells as approval "list-rows-mail-icons", 2026-10-30, lays
 * them out). Six columns: the agents' marks and the project after them, the
 * title cell (the thread's name in bold when unread, then the grey subject),
 * then right-aligned the words, the badge, the open counts (the action pill,
 * `?N`) and the time, each in a column of its own so they line up down the
 * list. In one project's list (`filtered`) the first column holds the marks alone.
 * A list with a pinned row adds the pin's column just left of the open counts.
 */
/**
 * What a row's lead (`LeadLine`: the agents and the project) draws: the project and its mark unless the list leaves
 * the project out (Project off, or one project's list), and the agents' tiles unless Agent icons is off (the list
 * column's class hides them, their names stay for a screen reader).
 */
function leadParts(filtered: boolean, noAgents: boolean): { project: boolean; agents: boolean } {
  return { project: !filtered, agents: !noAgents };
}

/** A name-first row's second line draws nothing (`leadParts`): only then is it folded away; otherwise the row is as it always was. */
function leadEmpty(filtered: boolean, noAgents: boolean): boolean {
  const parts = leadParts(filtered, noAgents);
  return !parts.project && !parts.agents;
}

/** Settings → Rows' choices a row reads beyond the list column's classes (listLook.ts). */
interface RowLook {
  noPreview: boolean;
  relative: boolean;
  titleFirst: boolean;
  /** Time position "Under the preview" (listLook.ts `timeBelow`): three-line and phone rows. */
  timeBelow: boolean;
  /** Show → Status mark (listLook.ts `statusMark`): one mark in place of the open counts, on every shape. */
  statusMark: boolean;
  /** Show → Agent icons off (listLook.ts `hideAgents`): with no project either, a name-first row's second line is empty. */
  noAgents: boolean;
}

function WideRow({ row, project, away, selected, filtered, lit, pinned, pinColumn, keys, full, pill, noPreview, relative, statusMark, onOpen, onUnstar }: { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; pinColumn: boolean; keys?: string; full: boolean; pill: boolean; onOpen: () => void } & Omit<RowLook, 'titleFirst' | 'timeBelow' | 'noAgents'>) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId();
  const badgeEl = badgeOf(row, kbd, full);
  const sent = row.section === 'sent';
  return (
    <>
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onPointerDown={notePressPointer}
      onClick={(event) => pressRow(event, row.thread_id, onOpen, onUnstar)}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-section={row.section}
      data-away={away ? '' : undefined}
      data-lit={lit ? '' : undefined}
      aria-describedby={rowHasBadge(row) ? wordsId : undefined}
      {...focus}
    >
      <FromLine row={row} project={project} filtered={filtered} />
      <span className="ib-subj">
        <TitleCell row={row} pill={pill} noPreview={noPreview} />
      </span>
      {/* Every column right of the words has a fixed width, so each lines up down the list. The words (a draft,
          Undelivered, Read …) take the width they need, between the title cell and the badge. */}
      <span className="ib-cw">
        <EndedMark row={row} />
        {row.snoozed ? <SnoozedUntil row={row} /> : <CountWords row={row} wide={full} tip={!full} status={statusMark} />}
      </span>
      <span className="ib-bcol">{badgeEl}</span>
      {/* The pin's column, in a list with a pinned row only (`pinColumn`), so a list without pins keeps its columns. */}
      {pinColumn && <span className="ib-cpin">{pinned && <PinMark threadId={row.thread_id} press={!!onUnstar} />}</span>}
      <span className="ib-cq">{statusMark ? <StatusMark row={row} tip /> : <OpenCounts row={row} tip />}</span>
      <span className="ib-t">
        <RowTime row={row} relative={relative} />
      </span>
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}

/**
 * A row and its quiet hover action: Mark read on a row that waits on the
 * person, Mark unread on a read row (markRead.ts `canMarkUnread`), shown on
 * hover or keyboard focus where the count and time are. It
 * never opens the thread. The action is the row's sibling (a button cannot
 * hold a button).
 */
function RowWithAction({
  row,
  drawn,
  menu,
  onMarkRead,
  onMarkUnread,
  onSendNow,
  children,
}: {
  row: InboxListRow;
  /** The group the row sits in on screen (markRead.ts `seenHeldInNew`). */
  drawn: InboxListGroupId;
  menu: boolean;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  children: ReactNode;
}) {
  // The action toggles (owner, 2026-10-31): on a read row (the row menu's rule, `canMarkUnread`) it is Mark unread.
  // That includes a row the person read that the list still holds in New (the thread open, or the one just left;
  // markRead.ts `seenHeldInNew`): the owner, 2026-11-02, "I opened it. I still want the ability to mark it unread."
  // Its Mark read (move it to Quiet now) stays in the row menu and the header.
  const unread = onMarkUnread && canMarkUnread(row);
  const offer = !unread && onMarkRead && offersRowMarkRead(row, drawn);
  // A reply waiting on a busy agent that can take it now: Send now, on hover and keyboard focus as Mark read.
  const sendNow = onSendNow && !offer && !unread && row.delivery?.send_now === true && rowWait(row.delivery) !== null;
  // The action's tooltip mounts when the pointer or focus first comes into the row (RowTip.tsx), before the action
  // shows: a Tab moves focus onto it, and focus must never land on a trigger that is about to be drawn again.
  const [actionTip, setActionTip] = useState(false);
  return (
    <div
      className="ib-rw"
      data-row={row.thread_id}
      // Archived, waiting for the list to settle without it (approval "inbox-list-view", R7): faded in place.
      data-archived={inboxRowArchived(row) ? '' : undefined}
      data-menu={menu ? '' : undefined}
      onPointerEnter={(event) => {
        if (!actionTip && opensTips(event)) setActionTip(true);
      }}
      onFocus={() => {
        if (!actionTip) setActionTip(true);
      }}
      onKeyDown={(event) => {
        // Tab from the row onto its action (focus fix 1): the action shows only while the row has keyboard focus,
        // and focus leaves the row before it reaches the action, so the browser's own Tab finds it gone and drops
        // focus on the page. The wrapper holds it shown (`data-action-focus`) while focus moves; Shift+Tab back is
        // the browser's.
        if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-thread-id]')) return;
        const wrapper = event.currentTarget;
        const action = wrapper.querySelector<HTMLElement>(':scope > .ib-ract');
        if (!action) return;
        event.preventDefault();
        wrapper.setAttribute('data-action-focus', '');
        action.addEventListener('blur', () => wrapper.removeAttribute('data-action-focus'), { once: true });
        action.focus();
        if (document.activeElement !== action) wrapper.removeAttribute('data-action-focus');
      }}
    >
      {children}
      {sendNow && (
        <RowTip armed={actionTip} content={`Send now: put your reply into ${agentName(rowAgent(row))}'s running turn without waiting for it to end`}>
          <button
            type="button"
            className="ib-ract"
            data-row-send-now=""
            aria-label={`Send now: ${titleOf(row)}`}
            onClick={(event) => {
              event.stopPropagation();
              onSendNow(row);
            }}
          >
            <Icon name="send" size={15} />
            Send now
          </button>
        </RowTip>
      )}
      {offer && (
        <RowTip armed={actionTip} content={withShortcut(`Mark read / quiet: out of the top until ${agentName(rowAgent(row))} writes again`, { scope: inboxThreadShortcuts, action: 'markRead' })}>
          <button
            type="button"
            className="ib-ract"
            data-row-mark-read=""
            aria-label={`Mark read: ${titleOf(row)}`}
            onClick={(event) => {
              event.stopPropagation();
              onMarkRead(row);
            }}
          >
            <Icon name="checkCircle" size={15} />
            Mark read
          </button>
        </RowTip>
      )}
      {unread && (
        <RowTip armed={actionTip} content="Mark unread: back to New, bold. Nothing is sent.">
          <button
            type="button"
            className="ib-ract"
            data-row-mark-unread=""
            aria-label={`Mark unread: ${titleOf(row)}`}
            onClick={(event) => {
              event.stopPropagation();
              onMarkUnread(row);
            }}
          >
            <Icon name="envelope" size={15} />
            Mark unread
          </button>
        </RowTip>
      )}
    </div>
  );
}

function NarrowRow({ row, project, away, selected, filtered, lit, pinned, keys, pill, compact, noPreview, relative, titleFirst, timeBelow, statusMark, noAgents, onOpen, onUnstar }: { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void } & RowLook) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId();
  const badge = badgeOf(row, kbd);
  const lead = <LeadLine row={row} project={project} filtered={filtered} />;
  const avatarRow = useAvatarRow();
  const time = (
    <span className="ib-t">
      <RowTime row={row} relative={relative} />
    </span>
  );
  // The row's end: the pin, the badge, a snooze's return, then the count (or the status mark). At the right of line 3,
  // or with the time under the preview (`timeBelow`) at the right of the time's own line, so the preview has its width.
  const end = (
    <>
      {pinned && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
      {badge}
      <SnoozedUntil row={row} />
      <LineCount row={row} tip status={statusMark} />
    </>
  );
  return (
    <>
    <button
      type="button"
      className={`ib-nrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      data-lm-av={avatarRow ? '' : undefined}
      onPointerDown={notePressPointer}
      onClick={(event) => pressRow(event, row.thread_id, onOpen, onUnstar)}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-section={row.section}
      data-away={away ? '' : undefined}
      data-lit={lit ? '' : undefined}
      aria-describedby={rowHasBadge(row) ? wordsId : undefined}
      {...focus}
    >
      <RowAvatar row={row} size={30} />
      {/* Three lines (approval "inbox-list-row-v2", 2026-10-30). Line 1: the agents' tiles and the project after
          them, on one line, then the ✓ and the time at the right. Compact rows (approval "inbox-list-options"): the
          title joins line 1, before the time, cut with "…", and line 2 goes. */}
      {titleFirst ? (
        // Settings → Rows' First line "Thread name": the name (one line, cut with "…") and the time on line 1, the
        // agents and the project on line 2; compact rows keep one line, the name before the project.
        <>
          <div className="ib-l1">
            <RowTitle row={row} className="ib-title" pill={pill} tip />
            {compact && lead}
            {!timeBelow && time}
          </div>
          {/* Nothing shows on it with Agent icons and Project both off (`leadEmpty`): it stays for a screen reader (the
              agents' names), but takes no room, so the preview sits under the name (the owner, 2026-11-07, q-dbe4dc80). */}
          {!compact && (
            <div className="ib-l2 ib-l2-lead" data-lead-empty={leadEmpty(filtered, noAgents) ? '' : undefined}>
              {lead}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="ib-l1">
            {lead}
            {compact && <RowTitle row={row} className="ib-title" pill={pill} tip />}
            {!timeBelow && time}
          </div>
          {/* Line 2: the title, never cut: a long one wraps (in its pill, one line cut with "…"). */}
          {!compact && (
            <div className="ib-l2">
              <RowTitle row={row} className="ib-title" pill={pill} tip={pill} />
            </div>
          )}
        </>
      )}
      {/* Line 3: the grey preview, cut first, then the guided review mark, and at the right end the pin, the badge
          and the count (inbox-row-byline's line 2 without the marks). Nothing to show: no line. */}
      <div className="ib-l3">
        {!noPreview && <Preview row={row} />}
        <GuideMark row={row} />
        {!timeBelow && end}
      </div>
      {/* Time position "Under the preview": the time on a line of its own at the left, the row's end at its right. */}
      {timeBelow && (
        <div className="ib-l4" data-time-below="">
          {time}
          {/* One box (display: contents) so the hover action can hide the row's end under it by class. */}
          <span className="ib-l4-end">{end}</span>
        </div>
      )}
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}

/**
 * A row on a phone, read like a mail app's, in the three-line row's order
 * (approval "inbox-list-row-v2", 2026-10-30): the agents' tiles and the
 * project and the time on line 1; the title on line 2, never cut; the grey
 * preview with the guided review book, then the pin, the badge and the count
 * at the right end of line 3. A pin with nothing else for line 3 stays at the
 * right end of line 1, before the time.
 */
function PhoneRow({ row, project, away, filtered, lit, menu, pinned, keys, pill, compact, noPreview, relative, titleFirst, timeBelow, statusMark, noAgents, onOpen, onUnstar }: { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; filtered: boolean; lit: boolean; menu: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void } & RowLook) {
  const wordsId = useId();
  // A phone: the icons only, no card (the thread shows the details).
  const badge = rowHasBadge(row) ? <RowBadge row={row} /> : null;
  const guide = row.guide && row.section !== 'sent';
  const preview = noPreview ? null : previewOf(row);
  // A pin with nothing else for line 3 (no preview, book, badge or count) stays on line 1, before the time, so the
  // row never grows a line for the pin alone.
  const avatarRow = useAvatarRow();
  // With the time under the preview the pin goes with the row's end, on the time's line.
  const pinOnLine1 = !timeBelow && pinned && !preview && !guide && !badge && !row.snoozed && countWords(row, 0, statusMark) === null && row.questions.open < 1 && !(statusMark && rowStatus(row));
  const time = (
    <span className="ib-t">
      <RowTime row={row} relative={relative} />
    </span>
  );
  const end = (
    <>
      {pinned && !pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
      {badge}
      <SnoozedUntil row={row} />
      <LineCount row={row} status={statusMark} />
    </>
  );
  return (
    <>
    <button
      type="button"
      className={`ib-mrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}`}
      data-lm-av={avatarRow ? '' : undefined}
      onPointerDown={notePressPointer}
      onClick={(event) => pressRow(event, row.thread_id, onOpen, onUnstar)}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-menu={menu ? '' : undefined}
      data-section={row.section}
      data-away={away ? '' : undefined}
      data-lit={lit ? '' : undefined}
      aria-describedby={rowHasBadge(row) ? wordsId : undefined}
    >
      <RowAvatar row={row} size={30} />
      {titleFirst ? (
        // Settings → Rows' First line "Thread name", as on a three-line row.
        <>
          <span className="ib-m1">
            <RowTitle row={row} className="ib-m2" pill={pill} />
            {compact && <LeadLine row={row} project={project} filtered={filtered} tip={false} />}
            {pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
            {!timeBelow && time}
          </span>
          {!compact && (
            <span className="ib-m1 ib-m1-lead" data-lead-empty={leadEmpty(filtered, noAgents) ? '' : undefined}>
              <LeadLine row={row} project={project} filtered={filtered} tip={false} />
            </span>
          )}
        </>
      ) : (
        <>
          <span className="ib-m1">
            <LeadLine row={row} project={project} filtered={filtered} tip={false} />
            {compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
            {pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
            {!timeBelow && time}
          </span>
          {/* Line 2: the title, never cut (in its pill, one line cut with "…"); compact rows have it on line 1. */}
          {!compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
        </>
      )}
      {/* Line 3: the preview (cut first), then the book, the pin, the badge and the count. */}
      <span className="ib-m3">
        {preview && (
          <span className="ib-pv" dir="auto">
            {preview}
          </span>
        )}
        {guide && (
          <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review">
            <Icon name="book" size={13} />
          </span>
        )}
        {!timeBelow && end}
      </span>
      {/* Time position "Under the preview", as on a three-line row. */}
      {timeBelow && (
        <span className="ib-m4" data-time-below="">
          {time}
          {end}
        </span>
      )}
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}

/**
 * A closed group with an agent stopped or held up inside (Stopped on you, Holding up work, the Snoozed band): the
 * triangle, so a blocker never hides behind the fold.
 */
function FoldedBlocker({ rows, group }: { rows: readonly InboxListRow[]; group: InboxListGroupId }) {
  const stopped = rows.some((row) => row.section === 'stopped');
  if (!stopped && !rows.some((row) => row.section === 'holding')) return null;
  const snoozed = group === 'snoozed';
  const words = snoozed
    ? stopped
      ? 'A snoozed thread is stopped on you'
      : 'A snoozed thread is holding up work'
    : stopped
      ? 'A closed thread is stopped on you'
      : 'A closed thread is holding up work';
  return (
    <span className="ib-zband-tri" data-stopped={stopped ? '' : undefined} data-snooze-blocker={snoozed ? '' : undefined} data-folded-blocker="" role="img" aria-label={words}>
      <Icon name="warn" size={14} />
    </span>
  );
}

/** Something new came into a closed group since it was closed: an unread row whose latest agent message came after. */
function newSince(rows: readonly InboxListRow[], since: number): boolean {
  return rows.some((row) => row.unread && Date.parse(row.last_agent_at ?? row.last_at) > since);
}

export function InboxList(props: InboxListProps) {
  // Every group closes by a click on its header, this browser's choice (listGroups.ts). Quiet and the Snoozed band
  // under it start closed (approval "inbox-snooze"), every other group open.
  const groups = useListGroups(props.rememberLook !== false);
  // Each linked machine that is away, in the list it shows (every machine, or the one the filter shows).
  const awayLines = (props.machines?.linked ?? []).flatMap((machine) => {
    const text = props.machineScope && props.machineScope !== machine.id ? null : awayLine(machine);
    return text ? [{ id: machine.id, text }] : [];
  });
  // The list's look options in its ⋮ menu (listLook.ts): smaller thread names on by default, the others off.
  const [look, setLook] = useListLook(props.rememberLook !== false);
  // Grouped (the default) or List (listView.ts), this browser's choice in the same ⋮ menu.
  const [view, setView] = useListView(props.rememberLook !== false);
  const asList = view === 'list';
  // Settings → Rows' "Project" off: every row drawn as one project's list draws it (no project, its columns).
  const noProject = props.filtered || look.hideProject;
  // Another project on a phone: the list starts at its top. The list itself stays mounted (its Quiet fold and,
  // across a resize past the phone width, its scroll are kept).
  const bodyRef = useRef<HTMLDivElement>(null);
  // ↑ ↓ Home End move focus between the rows (listKeys.ts), only while a row or the Quiet band has it.
  const listKey = (move: ListMove) => ({
    when: (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || modalOpen()) return false;
      const target = keyTarget(event);
      const body = bodyRef.current;
      return !!(target && body?.contains(target) && target.matches(LIST_STOPS));
    },
    handle: (event: KeyboardEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      // ↓ ↑ stop on the groups' headers too; Home End go to the first or last thread (listKeys.ts).
      const key = move === 'next' ? 'down' : move === 'previous' ? 'up' : move;
      const next = listKeyTarget(body, keyTarget(event), key);
      if (!next) return;
      next.focus({ preventScroll: true });
      next.scrollIntoView?.({ block: 'nearest' });
    },
  });
  useShortcutScope({
    scope: inboxListShortcuts,
    handlers: { next: listKey('next'), previous: listKey('previous'), first: listKey('first'), last: listKey('last') },
  });
  const shownScope = useRef(props.scope ?? null);
  useLayoutEffect(() => {
    const scope = props.scope ?? null;
    if (scope === shownScope.current) return;
    shownScope.current = scope;
    if (props.phone && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [props.scope, props.phone]);
  // Pull down to refresh: a phone's list, while it is the screen on top (no thread over it).
  const pullRef = useRef<HTMLDivElement>(null);
  const pulls = props.phone === true && props.onPullRefresh !== undefined;
  const pullOn = pulls && props.selectedThreadId === null;
  useEffect(() => {
    const body = bodyRef.current;
    const indicator = pullRef.current;
    if (!pullOn || !body || !indicator) return;
    return attachPullToRefresh(body, indicator, {
      onRefresh: () => latest.current.onPullRefresh?.(),
      reduced: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
  }, [pullOn]);
  const [listRef, narrowList] = useNarrowerThan(WIDE_ROWS_MIN_LIST_WIDTH, props.narrow);
  const [fullRef, shortWords] = useNarrowerThan(FULL_WORDS_MIN_LIST_WIDTH, props.narrow);
  const [thinRef, thinList] = useNarrowerThan(ONE_PROJECT_WIDE_ROWS_MIN_LIST_WIDTH, props.narrow);
  const listEl = useCallback(
    (el: HTMLElement | null) => {
      listRef.current = el;
      fullRef.current = el;
      thinRef.current = el;
    },
    [listRef, fullRef, thinRef],
  );
  // Two-line rows in a list too narrow for the wide row's columns: beside an
  // open thread for every list (the column is 380px unless its edge was
  // dragged past the wide rows' width), and in the full list for every
  // project. One project's list keeps the wide row in a narrower list, down to
  // ONE_PROJECT_WIDE_ROWS_MIN_LIST_WIDTH: its words column gives way first
  // (inbox.css), so its title and columns hold at the window's narrowest
  // desktop widths. Past that, which only a wide sidebar reaches, it too draws
  // two-line rows, so no column runs off the row. On the commit that closes a
  // thread `thinList` still holds the 380px column's answer: trusting it would
  // swap every row twice, at the moment the close hands a row its focus.
  const [besideThread, setBesideThread] = useState(props.narrow);
  useLayoutEffect(() => setBesideThread(props.narrow), [props.narrow]);
  const twoLine = (narrowList && (props.narrow || !noProject)) || (thinList && (props.narrow || !besideThread));
  // The full words on a wide row need a list of at least 1150px (FULL_WORDS_MIN_LIST_WIDTH); a narrower wide row
  // keeps the short forms and the bare triangles (option A).
  const fullWords = !twoLine && !shortWords;
  // The column beside a pane gets the sidebar's resize edge, except on a phone.
  const { isMobile, open: sidebarDocked } = useSidebar();
  // New message in the header: a phone always has it (its CSS draws it); a wider window only while the
  // main sidebar, which holds its own New message, is closed (the peek does not count as open).
  const headerCompose = isMobile || !sidebarDocked;
  const searchKeys = useShortcutAria({ scope: inboxSearchShortcuts, action: 'openSearch' });
  const generatedColumnId = useId();
  const columnId = props.columnId ?? generatedColumnId;
  const refreshHintId = useId();
  /** Shift+R's name on the ↻ (approval "inbox-refresh-key"), gone with single keys off. */
  const refreshKeys = useShortcutAria({ scope: inboxAppShortcuts, action: 'refresh' });
  const resizable = props.narrow && !isMobile;
  const visible = props.sections.filter((s) => s.threads.length > 0);
  // List's rows (listView.ts): every group's but the Snoozed band's, newest first, each keeping its place until the
  // list is sorted whole (`props.sort`), as the groups keep theirs. Only while List shows: a switch to List is a
  // sort of the whole list (the held list's rows, so nothing behind "N new" comes in).
  const places = useRef<ListPlaces | null>(null);
  const sortEpoch = props.sort?.epoch;
  const sortKeep = props.sort?.keep ?? null;
  const flat = useMemo(
    () => (asList ? flatRows(props.sections, sortEpoch === undefined ? null : places.current, { epoch: sortEpoch ?? 0, keep: sortKeep }) : null),
    [asList, props.sections, sortEpoch, sortKeep],
  );
  useLayoutEffect(() => {
    places.current = flat?.places ?? null;
  }, [flat]);
  // List draws the Snoozed band as the groups do: folded, under the rows.
  const listBand = asList ? (visible.find((s) => s.id === 'snoozed') ?? null) : null;
  // The band comes back folded: it shows only while something is snoozed, and each time it is new.
  const bandShown = visible.some((s) => s.id === 'snoozed');
  const resetGroup = groups.reset;
  useEffect(() => {
    if (!bandShown) resetGroup('snoozed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandShown]);
  // The wide rows' pin column (the owner, 2026-10-31: the pin beside the counts): only in a list with a pinned row,
  // Quiet's folded rows included, so a list without pins keeps its columns and opening Quiet moves none.
  const pinColumn = !props.phone && !twoLine && !!props.pinned && visible.some((s) => s.threads.some((row) => props.pinned!.has(row.thread_id)));
  // With the pin's column, the counts' column holds the widest counts (`fitCountsColumn`), so no count runs under a
  // pin: fitted again when what it depends on changes (the pin's column, the counts drawn, the columns the list's
  // width and look draw, the text size, the palette on screen and its mode, whose `--font-sans` differ, and the
  // zoom), and once the fonts are in. Not on the commit that opens or closes a thread: it still draws the other
  // column's rows, and the layout effects draw the new ones before the browser paints.
  // The rule this rests on: one `openCountsKey` always draws the same parts in `.ib-cq`, with the same classes, text
  // and width, whatever the row's state (hovered, its tooltip open or not yet mounted). A change inside `.ib-cq` that
  // breaks it must add what it depends on to `fitKey`, or the column keeps a stale width.
  const settled = besideThread === props.narrow;
  const closedKey = props.sections.map((section) => (groups.state(section.id).open ? '' : section.id)).join(',');
  const countsKey = useMemo(() => {
    if (!pinColumn || !settled) return '';
    const keys = new Set<string>();
    for (const section of props.sections) {
      // List draws every row but the Snoozed band's (no groups to close); the band folds in both views.
      if (asList ? section.id === 'snoozed' && !groups.state(section.id).open : !groups.state(section.id).open) continue;
      for (const row of section.threads) {
        const key = openCountsKey(row);
        if (key) keys.add(key);
      }
    }
    return [...keys].sort().join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinColumn, settled, props.sections, closedKey, asList]);
  const textSize = useInboxTextSize();
  // ThemeProvider puts the palette's classes on <html> while it renders, before this list's layout effects run.
  const { colorTheme, resolvedMode } = useTheme();
  const zoom = useDevicePixelRatio();
  const fitKey = `${pinColumn}|${fullWords}|${noProject}|${listLookClasses(look)}|${textSize}|${colorTheme}|${resolvedMode}|${zoom}|${countsKey}`;
  const fitted = useRef<string | null>(null);
  const pinColumnRef = useRef(pinColumn);
  pinColumnRef.current = pinColumn;
  useLayoutEffect(() => {
    if (!settled || fitted.current === fitKey || !listRef.current) return;
    fitted.current = fitCountsColumn(listRef.current, pinColumn) ? fitKey : null;
  });
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts?.addEventListener) return;
    const refit = () => {
      if (listRef.current) fitCountsColumn(listRef.current, pinColumnRef.current);
    };
    fonts.addEventListener('loadingdone', refit);
    return () => fonts.removeEventListener('loadingdone', refit);
  }, [listRef]);
  const lit = (row: InboxListRow) => props.lit?.has(row.thread_id) === true;
  // The row whose right-click menu is open: a muted background, as the project row's.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const rowOf = (threadId: string) => {
    for (const section of props.sections) {
      const row = section.threads.find((r) => r.thread_id === threadId);
      if (row) return row;
    }
    return null;
  };
  const sectionOf = (threadId: string) => props.sections.find((section) => section.threads.some((r) => r.thread_id === threadId))?.id ?? null;
  const onRowAction = props.onRowAction;
  // H on a row the keyboard is on (approval "inbox-keyboard-keys-2026-11-07", item 3): its menu opens at the Snooze
  // times, as Shift+F10 then Snooze would; nothing is snoozed until a time is picked. The open thread's own H is Thread.tsx's.
  const [snoozeRequest, setSnoozeRequest] = useState<{ id: string; n: number } | null>(null);
  useShortcutScope({
    scope: inboxThreadShortcuts,
    handlers: {
      snooze: {
        when: (event) => {
          if (!onRowAction || !props.onSnooze || !bareKeyAllowed(event)) return false;
          const target = keyTarget(event);
          if (!target || !bodyRef.current?.contains(target) || !target.matches('[data-thread-id]') || !keyboardFocused(target)) return false;
          const row = rowOf(target.getAttribute('data-thread-id') ?? '');
          return !!row && !inboxRowArchived(row) && (props.snoozesOf?.(row) ?? true);
        },
        handle: (event) => {
          const id = keyTarget(event)?.getAttribute('data-thread-id');
          if (id) setSnoozeRequest((was) => ({ id, n: (was?.n ?? 0) + 1 }));
        },
      },
    },
  });
  // Shift+F10 opens a row's menu (the context-menu key too), named on each row for assistive technology.
  const rowKeys = onRowAction ? shortcutAria({ scope: inboxListShortcuts, action: 'rowMenu' }) : undefined;
  // The row callbacks keep one identity for the list's life (they call the latest props), so a row whose
  // data did not change is not rendered again when the list is (ListRow is memoized on its row's content).
  const latest = useRef(props);
  // Written after commit, never during render: a render React throws away (concurrent rendering) must not leave
  // its props behind. The callbacks run only from events, which come after a commit.
  useLayoutEffect(() => {
    latest.current = props;
  });
  const openRow = useCallback((row: InboxListRow) => latest.current.onOpen(row), []);
  const markRead = useCallback((row: InboxListRow) => latest.current.onMarkRead?.(row), []);
  const markUnread = useCallback((row: InboxListRow) => latest.current.onMarkUnread?.(row), []);
  const sendNow = useCallback((row: InboxListRow) => latest.current.onSendNow?.(row), []);
  const unstar = useCallback((row: InboxListRow) => latest.current.onUnstar?.(row), []);
  // A row's time reads "8:22 PM" today and "Oct 19" after midnight: a new day renders every row again.
  const day = new Date().toDateString();
  /** One row, the same in both views; `drawn` is the group the held list draws it in. */
  const renderRow = (row: InboxListRow, drawn: InboxListGroupId) => (
    <ListRow
      key={row.thread_id}
      row={row}
      project={props.projectNames?.get(row.project.id) ?? row.project.name}
      away={!!row.machine && (props.machines?.away.has(row.machine) ?? false)}
      drawn={drawn}
      // A phone's row has no hover action (a hover on a touch screen is a first tap): Mark read is in the thread's header there.
      shape={props.phone ? 'phone' : twoLine ? 'narrow' : 'wide'}
      full={fullWords}
      filtered={noProject}
      selected={row.thread_id === props.selectedThreadId}
      lit={lit(row)}
      onOpen={openRow}
      onMarkRead={props.onMarkRead ? markRead : undefined}
      onMarkUnread={props.onMarkUnread ? markUnread : undefined}
      onSendNow={props.onSendNow ? sendNow : undefined}
      // Pins are this Inbox's own: another machine's thread has no star to press here.
      onUnstar={props.onUnstar && !(row.machine && props.machines?.names.has(row.machine)) ? unstar : undefined}
      day={day}
      menu={menuRow === row.thread_id}
      pinned={props.pinned?.has(row.thread_id) === true}
      pinColumn={pinColumn}
      keys={rowKeys}
      pill={look.highlight}
      compact={look.compact}
      noPreview={look.hidePreview}
      relative={look.relativeTime}
      titleFirst={look.titleFirst}
      timeBelow={look.timeBelow}
      statusMark={look.statusMark}
      noAgents={look.hideAgents}
    />
  );
  return (
    <section
      ref={listEl}
      id={columnId}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${resizable ? ' ib-resizable' : ''}${noProject ? ' ib-noproj' : ''}${fullWords ? ' ib-fullw' : ''}${pinColumn ? ' ib-pincol' : ''}${listLookClasses(look)}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <SidebarTrigger />
        {props.onRefresh ? (
          <h1 dir="auto" className="ib-lhead-h">
            {/* No tooltip (the owner, on #2911: words over the ↻ are too heavy): on hover or keyboard focus, only Shift+R's
                keycap pops out beside the ↻, over the header (inbox.css `.ib-hover-kbd`). Its words stay for screen
                readers: the description below and `aria-keyshortcuts`. */}
            <button
              type="button"
              className="ib-lhead-title"
              onClick={props.onRefresh}
              aria-describedby={refreshHintId}
              aria-keyshortcuts={refreshKeys}
              data-list-refresh=""
              data-refreshing={props.refreshSpin != null ? '' : undefined}
            >
              <span className="ib-lhead-tt">{props.title}</span>
              <Icon key={props.refreshSpin ?? 'rest'} name="refresh" size={16} className="ib-ic-refresh" />
              <ShortcutHint scope={inboxAppShortcuts} action="refresh" className="ib-kbd ib-hover-kbd" />
            </button>
          </h1>
        ) : (
          <Tip content={props.path ? <ProjectTipText name={props.title} root={props.path} /> : props.title} cut={!props.path}>
            <h1 dir="auto">{props.title}</h1>
          </Tip>
        )}
        {/* The button's description, outside the h1 so the heading reads only the name. */}
        {props.onRefresh && (
          <span id={refreshHintId} hidden>
            Refresh the list
          </span>
        )}
        {/* Search shows where New message does: a phone always, a wider window only while the main sidebar (which holds its own Search) is closed. */}
        {props.onSearch && headerCompose && (
          <Tip content={withShortcut('Search', { scope: inboxSearchShortcuts, action: 'openSearch' })}>
            <button
              type="button"
              className="ib-lhead-search"
              data-open-search=""
              data-sidebar-closed={isMobile ? undefined : ''}
              aria-label="Search"
              aria-haspopup="dialog"
              aria-keyshortcuts={searchKeys}
              onClick={(event) => props.onSearch?.(event.currentTarget)}
            >
              <Icon name="search" size={isMobile ? 20 : 16} />
            </button>
          </Tip>
        )}
        {props.onCompose && headerCompose && (
          <Tip content={withShortcut('New message', { scope: inboxAppShortcuts, action: 'compose' })}>
            <button
              type="button"
              className="ib-lhead-compose"
              data-open-compose=""
              // A wider window with the sidebar closed: the list header's own New message, at its far right.
              data-sidebar-closed={isMobile ? undefined : ''}
              aria-label="New message"
              aria-keyshortcuts={shortcutAria({ scope: inboxAppShortcuts, action: 'compose' })}
              aria-haspopup="dialog"
              onClick={(event) => props.onCompose?.(event.currentTarget)}
            >
              <Icon name="compose" size={isMobile ? 20 : 16} />
            </button>
          </Tip>
        )}
        {/* Tidy's ⋮: the header's far right, after Search and New message (the approved frames). */}
        {props.tidy && (
          <TidyMenu
            tidy={props.tidy}
            phone={isMobile}
            className="ib-lhead-more"
            onRefresh={() => props.onRefresh?.()}
            hideAway={(props.machines?.linked.length ?? 0) > 0 && props.onHideAway ? { on: props.hideAway === true, onChange: props.onHideAway } : undefined}
            look={look}
            onLook={(key, on) => setLook({ [key]: on })}
            threadPanel={props.threadPanel}
            onCustomize={props.onCustomizeRows}
            view={props.rememberLook !== false ? { value: view, onChange: setView } : undefined}
          />
        )}
      </div>
      {pulls && (
        // The ↻ a pull reveals under the header, behind the list (pullRefresh.ts moves it). Not for a screen reader:
        // the title is the accessible way, and the live region says the refresh.
        <div ref={pullRef} className="ib-pull" aria-hidden="true" data-pull-indicator="">
          <span className="ib-pull-dot">
            <Icon name="refresh" size={18} />
          </span>
        </div>
      )}
        <ThreadRowMenu
          ref={bodyRef}
          className="ib-lbody"
          rowOf={rowOf}
          sectionOf={sectionOf}
          canMarkRead={props.onMarkRead !== undefined}
          onSnooze={props.onSnooze}
          snoozesOf={props.snoozesOf}
          snoozeRequest={snoozeRequest}
          pinnedOf={props.pinned ? (threadId) => props.pinned!.has(threadId) : undefined}
          onTarget={setMenuRow}
          onAction={(row, action) => onRowAction?.(row, action)}
          disabled={!onRowAction}
          held={props.selectedThreadId !== null}
        >
          {props.stale}
          {props.ask}
          {awayLines.map((line) => (
            // A linked machine that is away: one quiet line, as a thread's meta line reads (its rows are greyed below).
            <p key={line.id} className="ib-away" data-machine-away={line.id}>
              <Icon name="clock" size={14} />
              {line.text}
            </p>
          ))}
          {props.notice && <HeldNoticeLine count={props.notice.count} project={props.notice.project ?? null} onShow={props.onShowNew} />}
          {/* The band alone is an empty list with a band under it: nothing else says the list is clear. */}
          {/* So is a list whose rows are all archived, waiting for the list to settle without them (Archive all). */}
          {visible.every((section) => section.id === 'snoozed' || section.threads.every(inboxRowArchived)) && props.empty}
          {/* The rows' tooltips mount on first use (RowTip.tsx): drawing every row's at once is most of a redraw. */}
          <LazyRowTips.Provider value={true}>
          {flat && flat.rows.length > 0 && (
            // List: one run of rows, newest first, no bands; each row keeps the group it is drawn in for its actions.
            <div className="ib-group" data-section-id="list" data-flat-list="">
              {flat.rows.map(({ row, drawn }) => renderRow(row, drawn))}
            </div>
          )}
          {/* List draws only the Snoozed band, folded under the rows as the groups draw it. */}
          {(asList ? (listBand ? [listBand] : []) : visible).map((section) => {
            const state = groups.state(section.id);
            const open = state.open;
            // Closed, with something new inside since: the count goes bold. The group never opens by itself.
            const fresh = !state.open && newSince(section.threads, state.since);
            return (
              <div key={section.id} className="ib-group" data-section-id={section.id} role="group" aria-label={section.label}>
                {/* The whole header is the toggle, no chevron (approval "inbox-list-groups-close"). */}
                <button
                  type="button"
                  className="ib-band"
                  aria-expanded={open}
                  onClick={(event) => {
                    // Focus in a row of the group that closes goes to its header, not to the page.
                    const band = event.currentTarget;
                    const active = document.activeElement;
                    if (open && active !== band && band.parentElement?.contains(active)) band.focus({ preventScroll: true });
                    groups.toggle(section.id);
                  }}
                >
                  {section.label}{' '}
                  <span className="ib-n" data-new={fresh ? '' : undefined}>
                    {formatCount(liveCount(section.threads))}
                    {fresh && <span className="ib-sr">, new since closed</span>}
                  </span>
                  {!open && <FoldedBlocker rows={section.threads} group={section.id} />}
                </button>
                {open && section.threads.map((row) => renderRow(row, section.id))}
              </div>
            );
          })}
          </LazyRowTips.Provider>
        </ThreadRowMenu>
      {props.reconnecting && (
        <p className="ib-relink" data-inbox-reconnecting="">
          Reconnecting…
        </p>
      )}
      {resizable && <ListColumnEdge controls={columnId} />}
    </section>
  );
}

interface ListRowProps {
  row: InboxListRow;
  /** The row's project as the window names it (`windowProjectNames`; another machine's carries that machine's name). */
  project: string;
  /** Its machine is away (asleep, or needing an update): the row is greyed, its thread opens when the machine is back. */
  away: boolean;
  /** The group the row sits in on screen. */
  drawn: InboxListGroupId;
  shape: 'wide' | 'narrow' | 'phone';
  /** A wide row in a list at least FULL_WORDS_MIN_LIST_WIDTH wide: the full words and the badge's words. */
  full: boolean;
  filtered: boolean;
  selected: boolean;
  lit: boolean;
  onOpen: (row: InboxListRow) => void;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  onUnstar?: (row: InboxListRow) => void;
  /** Today's date: the row's time is written against it (shortTime). */
  day: string;
  /** Its right-click menu is open (RowMenu.tsx): the muted background. */
  menu: boolean;
  /** Pinned to the sidebar: a small pin on the row's right (`PinMark`). */
  pinned: boolean;
  /** A wide row in a list that has a pinned row: every row draws the pin's column, so the columns line up. */
  pinColumn: boolean;
  /** `aria-keyshortcuts` for the row's menu (Shift+F10), when the list has one. */
  keys?: string;
  /** "Highlight thread subject" (listLook.ts): the title in its pill. */
  pill: boolean;
  /** "Compact rows" (listLook.ts): a three-line or phone row's title on line 1. */
  compact: boolean;
  /** Settings → Rows' "Subject line" off (listLook.ts `hidePreview`): no grey subject under a named thread. */
  noPreview?: boolean;
  /** Settings → Rows' Time "Relative" (listLook.ts `relativeTime`). */
  relative?: boolean;
  /** Settings → Rows' First line "Thread name" (listLook.ts `titleFirst`): three-line and phone rows. */
  titleFirst?: boolean;
  /** Settings → Rows' Time position "Under the preview" (listLook.ts `timeBelow`): three-line and phone rows. */
  timeBelow?: boolean;
  /** Settings → Rows' Show → Status mark (listLook.ts `statusMark`): every shape. */
  statusMark?: boolean;
  /** Settings → Rows' Show → Agent icons off (listLook.ts `hideAgents`); the list column's class hides the tiles. */
  noAgents?: boolean;
}

/**
 * One row of the list, in the shape the list draws. Every list read brings new
 * row objects, so it is memoized on the row's content, not its identity: a
 * list update renders only the rows that changed.
 */
export const ListRow = memo(
  function ListRow({ row, project, away, drawn, shape, full, filtered, selected, lit, onOpen, onMarkRead, onMarkUnread, onSendNow, onUnstar, menu, pinned, pinColumn, keys, pill, compact, noPreview = false, relative = false, titleFirst = false, timeBelow = false, statusMark = false, noAgents = false }: ListRowProps) {
    const open = () => onOpen(row);
    const unstarRow = onUnstar && pinned ? () => onUnstar(row) : undefined;
    const rowLook: RowLook = { noPreview, relative, titleFirst, timeBelow, statusMark, noAgents };
    if (shape === 'phone') return <PhoneRow row={row} project={project} away={away} filtered={filtered} lit={lit} menu={menu} pinned={pinned} keys={keys} pill={pill} compact={compact} {...rowLook} onOpen={open} onUnstar={unstarRow} />;
    return (
      <RowWithAction row={row} drawn={drawn} menu={menu} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} onSendNow={onSendNow}>
        {shape === 'narrow' ? (
          <NarrowRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} pill={pill} compact={compact} {...rowLook} onOpen={open} onUnstar={unstarRow} />
        ) : (
          <WideRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} pinColumn={pinColumn} keys={keys} selected={selected} full={full} pill={pill} noPreview={noPreview} relative={relative} statusMark={statusMark} onOpen={open} onUnstar={unstarRow} />
        )}
      </RowWithAction>
    );
  },
  (a, b) =>
    a.shape === b.shape &&
    a.project === b.project &&
    a.away === b.away &&
    a.full === b.full &&
    a.drawn === b.drawn &&
    a.filtered === b.filtered &&
    a.selected === b.selected &&
    a.lit === b.lit &&
    a.day === b.day &&
    a.menu === b.menu &&
    a.pinned === b.pinned &&
    a.pinColumn === b.pinColumn &&
    a.keys === b.keys &&
    a.pill === b.pill &&
    a.compact === b.compact &&
    a.noPreview === b.noPreview &&
    a.relative === b.relative &&
    a.titleFirst === b.titleFirst &&
    a.timeBelow === b.timeBelow &&
    a.statusMark === b.statusMark &&
    a.noAgents === b.noAgents &&
    a.onOpen === b.onOpen &&
    a.onMarkRead === b.onMarkRead &&
    a.onMarkUnread === b.onMarkUnread &&
    a.onSendNow === b.onSendNow &&
    a.onUnstar === b.onUnstar &&
    sameValue(a.row, b.row),
);

/** Deep equality over JSON-shaped values (a list row). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** The guided review mark drops its label to its icon when the row is short of room: only then does it need a tooltip. */
function guideLabelHidden(trigger: Element): boolean {
  const label = trigger.querySelector<HTMLElement>('.ib-att-l');
  return !label || label.offsetWidth === 0 || getComputedStyle(label).display === 'none';
}

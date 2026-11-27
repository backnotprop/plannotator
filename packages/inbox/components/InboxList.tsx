import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LetterMark, ProjectMark, showsProjects, showsThreads, useRowMarks } from '../letterMarks';
import { inboxListShortcuts } from '../shortcuts/list.shortcuts';
import { shortcutAria, useShortcutAria, withShortcut } from '../shortcuts/hint';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { RowTagName, rowTintOf, tintProps, type ListTagColours, type RowTintProps } from '../parts/RowTint';
import { RowAgents, RowAgentTiles, rowScriptOf } from './RowAgents';
import { RowPullsMark } from '../threadPulls/ThreadPulls';
import { isTextCut, ProjectTipText, Tip } from './Tip';
import { RowTip } from './RowTip';
import { Icon } from '../icons';
import { PinMark, PinnedWords } from '../parts/RowPin';
import { notePressPointer, pressRow } from '../starPress';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { useNarrowerThan } from '../narrower';
import { inboxRowArchived } from '@plannotator/core/inbox-types';
import { rowLabel, scheduledLook, scheduledOf, ScheduledTile, useScheduled } from '../scheduled/rowLook';
import { HeldNoticeLine, HeldNoticeSaid, HoldViewOnBar, noticeLines, type ListNotice } from './HeldNoticeLine';
import { listBarShows } from '../listNewState';
import { useShowHold } from '../holdView';
import { ThreadRowMenu, bandMenuId, useRowDragA11y } from './RowMenu';
import type { RowMenuAction } from '../rowMenu';
import { WIDE_ROW_WAIT_WORDS, WaitWords, rowHasBadge } from './RowBadge';
import { rowStatus } from './RowStatus';
import { attachPullToRefresh } from '../pullRefresh';
import { RowSwipeLayer, useRowSwipe } from './RowSwipeLayer';
import { leadEmpty, leadParts } from './rowLead';
import { TidyMenu, type TidyController } from './Tidy';
import { ListFilterButton, RecentViewBar, RecentViewSaid, useTitleFilterList, type ListFilterSource } from './ListFilter';
import { awayLine, machineTakes, type MachinesModel } from '../machines';
import { listLookClasses, useListLook } from '../listLook';
import { flatRows, useListView, type ListPlaces, type ListSort } from '../listView';
import { useStarredAbove } from '../starredPills';
import { StarredPills } from './StarredPills';
import type { PinnedAction } from './PinnedRow';
import { useListGroups } from '../listGroups';
import type { ListEdge, UnseenRow } from '../showLight';
import { ListNewPill } from './ListNewPill';
import { useInboxTextSize } from '../textSize';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { RowSlot } from './RowSlot';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { bareKeyAllowed, isComposingKey, keyboardFocused, keyTarget, modalOpen } from '../shortcuts/guards';
import { listKeyTarget, LIST_STOPS, type ListMove } from '../listKeys';
import { fitCountsColumn, useDevicePixelRatio } from './listFit';
import { useKeyboardFocus } from './useKeyboardFocus';
import { sameListRow, type ListRowProps } from './listRowProps';
import { useListPicks } from './useListPicks';
import { PickBox, PickMark } from './PickBar';
import type { BulkWrites } from '../bulkWrites';
import { FoldedBlocker, GroupBand, newSince } from './GroupBand';
import { bandOnScreen, useBandTip, type BandTipHost } from '../bandTip';
import { bandMenuOf, listMarkAllRows } from '../markAllRead';
import { AgentsList } from '../agentsView/AgentsList';
import { LineRow } from '../agentsView/LineRow';
import { rowAgent, slotSession, cardOf, SnoozedUntil, RowTime, ListRows, BadgeWords, subjectOf, sentWordsOf, titleOf, RowTitle, countWords, liveCount, CountWords, EndedMark, LineCount, openCountsKey, OpenCounts, ClipText, RowWithAction } from './rowParts';
import { ArchivedGroup } from './ArchivedGroup';
import type { ArchivedGroupHost } from '../data/actions/archivedGroup';
import { useShowArchived } from '../showArchived';

export { rowAgent, titleOf } from './rowParts';

export interface InboxListProps {
  /** Beside an open thread, a click on the list's edge hides the list (the thread in full screen); drag still resizes. Absent: the edge only resizes. */
  onHide?: () => void;
  title: string;
  /**
   * A tag's list (approval "inbox-thread-tags"): the tag's `#` before the title, and "5 threads · 2 projects" after it,
   * quiet. Absent: neither.
   */
  titleMark?: ReactNode;
  titleNote?: string | null;
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
   * The held list's line (HeldNoticeLine.tsx `ListNotice`): how many (held.ts `heldNotice`) and what came (newsWords.ts),
   * one line each, a long name cut with "…", the whole line then in a tooltip. `lands`: the
   * groups its rows land in (held.ts `showLandsIn`); Show opens each one closed, as a click on its header does, so
   * the rows it brings in are on screen (List has no groups to open). The line sticks to the list's top while
   * it shows (listNewState.ts): held news has no other sign, and no pill.
   */
  notice: ListNotice | null;
  /** The line for news outside a project or filter view: Show all goes to the whole Inbox (newsWords.ts). */
  onShowAll?: () => void;
  /** The list is drawn but out of sight (a thread covers it: a phone, a stacked window, full screen): its pill waits. */
  covered?: boolean;
  /**
   * When the list on screen was last sorted whole (listView.ts `ListSort`): List keeps each row's place between
   * sorts, as the groups do. Absent: every render is a sort (a list that never holds, the tour).
   */
  sort?: ListSort;
  /** This page is older than the Inbox (StalePageNotice, stalePage.ts): at the list's top, above the notifications line. */
  stale?: ReactNode;
  /** The one-time notifications line (record 6.1), above everything else. */
  ask?: ReactNode;
  /** Show. It never scrolls the list. */
  onShowNew: () => void;
  /** The rows Show brought in that are not in view yet (showLight.ts): the pill counts them, and its press is `onGoNew`. */
  unseenNew?: readonly UnseenRow[];
  onGoNew?: (edge: ListEdge) => void;
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
  onRowAction?: (row: InboxListRow, action: RowMenuAction) => unknown;
  /** The picks' actions (bulkWrites.ts): rows can be picked, from the row menu, the ⋮ or ⌘ / Shift and a click. Absent: no picking. */
  bulk?: BulkWrites;
  /** The Group tip (bandTip.ts): a band's one-time tooltip about its menu. Absent: none. */
  bandTip?: BandTipHost;
  /** A press on a starred row's star. Absent (an older Inbox keeps no pins): the star is only a mark. */
  onUnstar?: (row: InboxListRow) => void;
  /** Snooze a row until a moment, from its menu (approval "inbox-snooze"). Absent (an older Inbox keeps no snoozes): no Snooze. */
  onSnooze?: (row: InboxListRow, until: string) => void;
  /** Whether a row can be snoozed (a linked machine on an older Inbox keeps no snoozes). Absent: every row can. */
  snoozesOf?: (row: InboxListRow) => boolean;
  /** The machine that must update before this row can be snoozed: Snooze stays, and says so. */
  snoozeBlockedOf?: (row: InboxListRow) => { name: string } | null;
  onSnoozeBlocked?: (row: InboxListRow) => void;
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
  /**
   * The starred threads, in star order (the list model's `pins`), for "Keep starred above the list"
   * (starredPills.ts): with the choice on they are pills above the first section. Absent (an Inbox that keeps no
   * stars, the tour): no pills and no menu item.
   */
  starred?: { rows: readonly InboxListRow[]; onOpen: (row: InboxListRow) => void; onAction: (row: InboxListRow, action: PinnedAction) => void };
  /**
   * The list's filter (listFilter.ts): the funnel in the header, left of Search, New message and ⋮. App filters the
   * sections it hands the list; this is the menu's source. Absent (the tour): no funnel.
   */
  listFilter?: ListFilterSource;
  /** The ⋮ menu's "Customize rows…": Settings → Rows. Absent (the tour): no item. */
  onCustomizeRows?: () => void;
  /** The Archived group under the list and its ⋮ switch (approval "inbox-archived-group"). Absent (the tour): neither. */
  archived?: ArchivedGroupHost;
  /** Tag row colours (parts/RowTint.tsx) and "Show tag colors" in the ⋮. Absent (an older Inbox, the tour): neither. */
  tagColours?: ListTagColours;
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
 * The grey preview under or after the title (approval "inbox-row-latest-preview"): the thread's latest message as
 * the server words it (`latest_preview`: the newest unread agent message, else the newest one, "You: …" for the
 * person's own), under a named and an unnamed thread alike. A named Sent row keeps its own words (who has the reply,
 * a re-ask that waits), as before. Nothing when it only repeats the title. An older Inbox sends no `latest_preview`:
 * a named thread's subject then, as before, and nothing under an unnamed one, whose subject is its title.
 */
export function previewOf(row: InboxListRow): string | null {
  const named = !!row.thread_name?.trim();
  const sentWords = named ? sentWordsOf(row) : null;
  const text = sentWords ?? (row.latest_preview !== undefined ? row.latest_preview : named ? subjectOf(row) : null);
  if (!text?.trim()) return null;
  return text.trim() === titleOf(row).trim() ? null : text;
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
      {(!filtered || !!scheduledOf(row)) && <RowSlot row={row} session={slotSession(row)} project={project} />}
      {scheduledOf(row) ? <ScheduledTile /> : <RowAgents participants={row.participants} agent={rowAgent(row)} script={rowScriptOf(row, rowAgent(row), project)} />}
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
      {(withProject || !!scheduledOf(row)) && <RowSlot row={row} session={slotSession(row)} project={project} tip={tip} />}
      {scheduledOf(row) ? <ScheduledTile /> : <RowAgentTiles participants={row.participants} agent={rowAgent(row)} tip={tip} script={rowScriptOf(row, rowAgent(row), project)} />}
    </span>
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

const guideWord = (row: InboxListRow) => (row.guide_walkthrough ? 'Walkthrough' : 'Guided review');

/** The record's 1.1: a thread that carries a guided review says so after its subject. */
function GuideMark({ row }: { row: InboxListRow }) {
  if (!row.guide || row.section === 'sent') return null;
  const word = guideWord(row);
  return (
    <RowTip content={word} when={guideLabelHidden}>
      <span className="ib-att" data-guide-mark="" role="img" aria-label={word}>
        <Icon name="book" size={13} />
        <span className="ib-att-l">{word}</span>
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
 * From this list width a wide row draws the full words and a blocked row's words (the owner, 2026-10-29: full words
 * in full-width mode; a 1440px window with the sidebar gives a 1192px list; `WIDE_ROW_WAIT_WORDS`). Narrower wide rows
 * keep approval "inbox-row-byline", option A (the short forms, the marks alone), so the subject keeps its room.
 */
export const FULL_WORDS_MIN_LIST_WIDTH = 1150;

/**
 * One row of the wide list, on one line (approval "inbox-row-byline", the
 * one-line row; its cells as approval "list-rows-mail-icons", 2026-10-30, lays
 * them out). Six columns: the agents' marks and the project after them, the
 * title cell (the thread's name in bold when unread, then the grey preview),
 * then right-aligned the words, the badge, the open counts (the action pill,
 * `?N`) and the time, each in a column of its own so they line up down the
 * list. In one project's list (`filtered`) the first column holds the marks alone.
 * A list with a pinned row adds the pin's column just left of the open counts.
 */
/** Settings → Rows' choices a row reads beyond the list column's classes (listLook.ts). */
/** The list is picking rows (rowPicks.ts): the row is a toggle, filled while picked. */
type PickState = { picking: boolean; picked: boolean };

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
  /** Pull requests off (listLook.ts `hidePulls`): no PR mark at the row's end, on every shape. */
  noPulls: boolean;
}

function WideRow({ row, project, away, selected, filtered, lit, pinned, pinColumn, keys, full, pill, noPreview, relative, statusMark, noPulls, picking, picked, onOpen, onUnstar, tint, tagName }: PickState & RowTintProps & { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; pinColumn: boolean; keys?: string; full: boolean; pill: boolean; onOpen: () => void } & Omit<RowLook, 'titleFirst' | 'timeBelow' | 'noAgents'>) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId(), dragA11y = useRowDragA11y(rowHasBadge(row) ? wordsId : undefined);
  const card = cardOf(row);
  // A wide row in full-width mode says a blocked row's state in words too (`WIDE_ROW_WAIT_WORDS`), in the badge's
  // column; they open the card on keyboard focus, so the marks do not.
  const words = full && WIDE_ROW_WAIT_WORDS && rowHasBadge(row) ? <WaitWords row={row} card={card} open={kbd} /> : null;
  const sent = row.section === 'sent';
  return (
    <>
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}${picked ? ' ib-picked' : ''}`}
      aria-pressed={picking ? picked : undefined}
      onPointerDown={notePressPointer}
      onClick={(event) => pressRow(event, row.thread_id, onOpen, onUnstar)}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-section={row.section}
      data-away={away ? '' : undefined}
      data-lit={lit ? '' : undefined}
      {...dragA11y}
      {...tintProps(tint)}
      {...focus}
    >
      <FromLine row={row} project={project} filtered={filtered} />
      <span className="ib-subj">
        <TitleCell row={row} pill={pill} noPreview={noPreview} />
      </span>
      {/* Every column right of the words has a fixed width, so each lines up down the list. The words (a draft,
          Undelivered, Read …) take the width they need, between the title cell and the badge (a tag's name first). */}
      <span className="ib-cw">
        {tagName}
        <EndedMark row={row} />
        {row.snoozed ? <SnoozedUntil row={row} /> : <CountWords row={row} wide={full} tip={!full} status={statusMark} />}
        {/* The thread's PRs (approval "inbox-pr-binding"): the state of the one in play, the count over its corner. */}
        <RowPullsMark threadId={row.thread_id} summary={noPulls ? undefined : row.pulls} />
      </span>
      <span className="ib-bcol">{words}</span>
      {/* The pin's column, in a list with a pinned row only (`pinColumn`), so a list without pins keeps its columns. */}
      {pinColumn && <span className="ib-cpin">{pinned && <PinMark threadId={row.thread_id} press={!!onUnstar} />}</span>}
      <span className="ib-cq">
        <OpenCounts row={row} tip status={statusMark} card={card} open={kbd && !words} />
      </span>
      <span className="ib-t">
        <RowTime row={row} relative={relative} />
      </span>
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}


function NarrowRow({ row, project, away, selected, filtered, lit, pinned, keys, pill, compact, noPreview, relative, titleFirst, timeBelow, statusMark, noAgents, noPulls, picking, picked, onOpen, onUnstar, tint, tagName }: PickState & RowTintProps & { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void } & RowLook) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId(), dragA11y = useRowDragA11y(rowHasBadge(row) ? wordsId : undefined);
  const lead = <LeadLine row={row} project={project} filtered={filtered} />;
  const avatarRow = useAvatarRow();
  const time = (
    <span className="ib-t">
      <RowTime row={row} relative={relative} />
    </span>
  );
  // The row's end: the pin, a snooze's return, then the count (or the status mark). At the right of line 3,
  // or with the time under the preview (`timeBelow`) at the right of the time's own line, so the preview has its width.
  const end = (
    <>
      {pinned && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
      <RowPullsMark threadId={row.thread_id} summary={noPulls ? undefined : row.pulls} />
      <SnoozedUntil row={row} />
      <LineCount row={row} tip status={statusMark} card={cardOf(row)} open={kbd} />
    </>
  );
  // First line "Thread name" with Preview off too (approval "inbox-customize-rows"): two lines, the guided
  // review mark and the row's end at line 2's right end. With the time under the preview the end has its own line.
  const twoLines = titleFirst && noPreview && !compact && !timeBelow;
  return (
    <>
    <button
      type="button"
      className={`ib-nrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}${picked ? ' ib-picked' : ''}`}
      aria-pressed={picking ? picked : undefined}
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
      {...dragA11y}
      {...tintProps(tint)}
      {...focus}
    >
      <RowAvatar row={row} size={30} />
      {/* Three lines (approval "inbox-list-row-v2", 2026-10-30). Line 1: the agents' tiles and the project after
          them, on one line, then the ✓ and the time at the right. Compact rows (approval "inbox-list-options"): the
          title joins line 1, before the time, cut with "…", and line 2 goes. A tag's name sits before the time. */}
      {titleFirst ? (
        // Settings → Rows' First line "Thread name": the name (one line, cut with "…") and the time on line 1, the
        // agents and the project on line 2; compact rows keep one line, the name before the project.
        <>
          <div className="ib-l1">
            <RowTitle row={row} className="ib-title" pill={pill} tip />
            {compact && lead}
            {tagName}
            {!timeBelow && time}
          </div>
          {/* Nothing shows on it with Agent icons and Project both off (`leadEmpty`): it stays for a screen reader (the
              agents' names), but takes no room, so the preview sits under the name (the owner, 2026-11-07, q-dbe4dc80).
              Preview off too (`twoLines`): line 3's marks and counts at line 2's right end, and no line 3, so the
              line draws them and never folds. */}
          {twoLines ? (
            <div className="ib-l2 ib-l2-lead">
              {lead}
              <span className="ib-lend">
                <GuideMark row={row} />
                {end}
              </span>
            </div>
          ) : (
            !compact && (
              <div className="ib-l2 ib-l2-lead" data-lead-empty={leadEmpty(filtered, noAgents) ? '' : undefined}>
                {lead}
              </div>
            )
          )}
        </>
      ) : (
        <>
          <div className="ib-l1">
            {lead}
            {compact && <RowTitle row={row} className="ib-title" pill={pill} tip />}
            {tagName}
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
      {!twoLines && (
        <div className="ib-l3">
          {!noPreview && <Preview row={row} />}
          <GuideMark row={row} />
          {!timeBelow && end}
        </div>
      )}
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
function PhoneRow({ row, project, away, filtered, lit, menu, pinned, keys, pill, compact, noPreview, relative, titleFirst, timeBelow, statusMark, noAgents, noPulls, picking, picked, onOpen, onUnstar, tint, tagName }: PickState & RowTintProps & { onUnstar?: () => void; row: InboxListRow; project: string; away: boolean; filtered: boolean; lit: boolean; menu: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void } & RowLook) {
  const wordsId = useId();
  // A phone: the marks only, no card (the thread shows the details).
  const guide = row.guide && row.section !== 'sent';
  const preview = noPreview ? null : previewOf(row);
  // A pin with nothing else for line 3 (no preview, book, badge or count) stays on line 1, before the time, so the
  // row never grows a line for the pin alone.
  const avatarRow = useAvatarRow();
  // With the time under the preview the pin goes with the row's end, on the time's line.
  // First line "Thread name" with Preview off: two lines, line 3's book, pin, badge and count at line 2's end.
  const twoLines = titleFirst && noPreview && !compact && !timeBelow;
  const pinOnLine1 = !timeBelow && !twoLines && pinned && !preview && !guide && !rowHasBadge(row) && !row.snoozed && countWords(row, 0, statusMark) === null && row.questions.open < 1 && !(statusMark && rowStatus(row));
  const time = (
    <span className="ib-t">
      <RowTime row={row} relative={relative} />
    </span>
  );
  const end = (
    <>
      {pinned && !pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
      <RowPullsMark threadId={row.thread_id} summary={noPulls ? undefined : row.pulls} />
      <SnoozedUntil row={row} />
      <LineCount row={row} status={statusMark} />
    </>
  );
  return (
    <>
    <button
      type="button"
      className={`ib-mrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${picked ? ' ib-picked' : ''}`}
      aria-pressed={picking ? picked : undefined}
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
      {...tintProps(tint)}
    >
      {picking && <PickMark on={picked} />}
      <RowAvatar row={row} size={30} />
      {titleFirst ? (
        // Settings → Rows' First line "Thread name", as on a three-line row.
        <>
          <span className="ib-m1">
            <RowTitle row={row} className="ib-m2" pill={pill} />
            {compact && <LeadLine row={row} project={project} filtered={filtered} tip={false} />}
            {pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
            {tagName}
            {!timeBelow && time}
          </span>
          {!compact && (
            <span className="ib-m1 ib-m1-lead" data-lead-empty={!twoLines && leadEmpty(filtered, noAgents) ? '' : undefined}>
              <LeadLine row={row} project={project} filtered={filtered} tip={false} />
              {twoLines && (
                <span className="ib-lend">
                  {guide && (
                    <span className="ib-att" data-guide-mark="" role="img" aria-label={guideWord(row)}>
                      <Icon name="book" size={13} />
                    </span>
                  )}
                  {end}
                </span>
              )}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="ib-m1">
            <LeadLine row={row} project={project} filtered={filtered} tip={false} />
            {compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
            {pinOnLine1 && <PinMark threadId={row.thread_id} press={!!onUnstar} />}
            {tagName}
            {!timeBelow && time}
          </span>
          {/* Line 2: the title, never cut (in its pill, one line cut with "…"); compact rows have it on line 1. */}
          {!compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
        </>
      )}
      {/* Line 3: the preview (cut first), then the book, the pin, the badge and the count. None on a two-line row. */}
      {!twoLines && (
        <span className="ib-m3">
          {preview && (
            <span className="ib-pv" dir="auto">
              {preview}
            </span>
          )}
          {guide && (
            <span className="ib-att" data-guide-mark="" role="img" aria-label={guideWord(row)}>
              <Icon name="book" size={13} />
            </span>
          )}
          {!timeBelow && end}
        </span>
      )}
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

const NO_UNSEEN: readonly UnseenRow[] = [];

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
  // Grouped (the default) or List (listView.ts), this browser's choice in the same ⋮ menu; Recent activity (`sort.by`) draws List's one list whatever it is.
  const [view, setView] = useListView(props.rememberLook !== false);
  const asList = view === 'list' || props.sort?.by !== undefined;
  // Agents (agentsView/): its drawn rows (Select all picks only those), its Shows (each opens the agents rows land under).
  const asAgents = view === 'agents' && !asList, [agentRows, setAgentRows] = useState<readonly string[] | null>(null), [shows, setShows] = useState(0);
  // The starred threads as pills above the list, or (off, the default) the sidebar's Starred section (starredPills.ts).
  const [starredAbove, setStarredAbove] = useStarredAbove(props.rememberLook !== false);
  const showArchived = useShowArchived();
  const [archivedRows, setArchivedRows] = useState<readonly InboxListRow[]>([]);
  // Settings → Rows' "Project" off: every row drawn as one project's list draws it (no project, its columns).
  const noProject = props.filtered || look.hideProject;
  // Another project on a phone: the list starts at its top. The list itself stays mounted (its Quiet fold and,
  // across a resize past the phone width, its scroll are kept).
  const bodyRef = useRef<HTMLDivElement>(null);
  // Filter by typing (TitleFilter.tsx): the rows narrowed by the typed words, the menu's picks already applied (App).
  // Typing redraws this list, never the window; the field sits under the header, "No threads match" in the body.
  const { sections, archived, field: titleField, empty: titleEmpty } = useTitleFilterList(props.sections, props.archived, props.listFilter !== undefined, props.listFilter?.place ?? '', showArchived ? archivedRows.length : 0);
  const pick = useListPicks({ sections: sections, isOpen: (id) => (asList && id !== 'snoozed') || ((!asAgents || id === 'snoozed') && groups.state(id).open), drawn: asAgents ? agentRows : null, body: bodyRef, bulk: props.bulk, phone: props.phone === true, narrow: props.narrow === true, scope: props.scope ?? null, machines: props.machines, pinned: props.pinned, snoozes: props.onSnooze !== undefined, snoozesOf: props.snoozesOf, sectionOf: (id) => sections.find((section) => section.threads.some((r) => r.thread_id === id))?.id ?? null, archived: archivedRows });
  // ↑ ↓ Home End move focus between the rows (listKeys.ts), only while a row or the Quiet band has it.
  const listKey = (move: ListMove) => ({
    when: (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      const target = keyTarget(event);
      const body = bodyRef.current;
      return !!(target && body?.contains(target) && target.matches(LIST_STOPS)) && !modalOpen();
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
  // keeps the short forms and the marks alone (option A).
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
  const refreshTip = withShortcut('Refresh', { scope: inboxAppShortcuts, action: 'refresh' });
  /** The name's tooltip without a project: the name while the header cuts it, else the ↻'s own "Refresh ⇧R". */
  const [titleCut, setTitleCut] = useState(false);
  const titleTipWhen = useCallback((trigger: Element) => {
    setTitleCut(isTextCut(trigger));
    return true;
  }, []);
  const resizable = props.narrow && !isMobile;
  const visible = sections.filter((s) => s.threads.length > 0);
  /** Mark all as read (the ⋮'s, a band's menu): these drawn rows, each written as its thread is now (bulkWrites.ts `markAllRead`). */
  const markAllRead = props.bulk ? (rows: readonly InboxListRow[]) => (rows.length > 0 ? props.bulk!.markAllRead(rows) : undefined) : undefined;
  // List's rows (listView.ts): every group's but the Snoozed band's, newest first, each keeping its place until the
  // list is sorted whole (`props.sort`), as the groups keep theirs. Only while List shows: a switch to List is a
  // sort of the whole list (the held list's rows, so nothing behind "N new" comes in).
  const places = useRef<ListPlaces | null>(null);
  const sortEpoch = props.sort?.epoch;
  const sortKeep = props.sort?.keep ?? null;
  const flat = useMemo(
    () => (asList ? flatRows(sections, sortEpoch === undefined ? null : places.current, { epoch: sortEpoch ?? 0, keep: sortKeep, by: props.sort?.by }) : null),
    [asList, sections, sortEpoch, sortKeep, props.sort?.by],
  );
  useLayoutEffect(() => {
    places.current = flat?.places ?? null;
  }, [flat]);
  // List draws the Snoozed band as the groups do: folded, under the rows.
  const listBand = asList || asAgents ? (visible.find((s) => s.id === 'snoozed') ?? null) : null;
  // The band comes back folded: it shows only while something is snoozed, and each time it is new.
  const bandShown = visible.some((s) => s.id === 'snoozed');
  const resetGroup = groups.reset;
  useEffect(() => {
    if (!bandShown) resetGroup('snoozed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandShown]);
  // The wide rows' pin column (the owner, 2026-10-31: the pin beside the counts): only in a list with a pinned row,
  // Quiet's folded rows included, so a list without pins keeps its columns and opening Quiet moves none.
  const pinColumn = !asAgents && !props.phone && !twoLine && !!props.pinned && visible.some((s) => s.threads.some((row) => props.pinned!.has(row.thread_id)));
  // With the pin's column, the counts' column holds the widest counts (`fitCountsColumn`), so no count runs under a
  // pin: fitted again when what it depends on changes (the pin's column, the counts drawn, the columns the list's
  // width and look draw, the text size, the palette on screen and its mode, whose `--font-sans` differ, and the
  // zoom), and once the fonts are in. Not on the commit that opens or closes a thread: it still draws the other
  // column's rows, and the layout effects draw the new ones before the browser paints.
  // The rule this rests on: one `openCountsKey` always draws the same parts in `.ib-cq`, with the same classes, text
  // and width, whatever the row's state (hovered, its tooltip open or not yet mounted). A change inside `.ib-cq` that
  // breaks it must add what it depends on to `fitKey`, or the column keeps a stale width.
  const settled = besideThread === props.narrow;
  const closedKey = sections.map((section) => (groups.state(section.id).open ? '' : section.id)).join(',');
  const countsKey = useMemo(() => {
    if (!pinColumn || !settled) return '';
    const keys = new Set<string>();
    for (const section of sections) {
      // List draws every row but the Snoozed band's (no groups to close); the band folds in both views.
      if (asList ? section.id === 'snoozed' && !groups.state(section.id).open : !groups.state(section.id).open) continue;
      for (const row of section.threads) {
        const key = openCountsKey(row);
        if (key) keys.add(key);
      }
    }
    return [...keys].sort().join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinColumn, settled, sections, closedKey, asList]);
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
  const heldBar = listBarShows(props.notice?.count ?? 0);
  const bar = noticeLines(props.notice, heldBar, props.onShowAll !== undefined);
  const holdShow = useShowHold(bodyRef); // Show never moves the reader (holdView.ts).
  const showNew = () => {
    holdShow();
    // The groups the rows land in open with the press (the owner, 2026-11-08), in the same render as the
    // rows: closed, they would come in out of sight and Show would seem to do nothing.
    const lands = props.notice?.lands;
    if (lands && !asList && !asAgents) groups.open(lands); else if (asAgents) setShows((n) => n + 1);
    props.onShowNew();
  };
  // The row whose right-click menu is open: a muted background, as the project row's.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const rowOf = (threadId: string) => {
    for (const section of sections) {
      const row = section.threads.find((r) => r.thread_id === threadId);
      if (row) return row;
    }
    return props.archived?.rowOf(threadId) ?? null;
  };
  const sectionOf = (threadId: string) => sections.find((section) => section.threads.some((r) => r.thread_id === threadId))?.id ?? (props.archived?.rowOf(threadId) ? 'archived' : null);
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
  // A group band's menu (markAllRead.ts `bandMenuOf`). Not while picking: the band's box is the picks' then.
  const bands = props.bulk && !pick.on ? bandMenuOf(sections, props.bulk, () => bandTip.menuOpened()) : undefined;
  // The bands drawn that have a menu now, for the Group tip: none while picking, none while a thread covers the list.
  const menuBands =
    bands && props.covered !== true ? (asList || asAgents ? (listBand ? [listBand] : []) : visible).filter((section) => bands.actionsOf(section.id).length > 0).map((section) => section.id) : [];
  const bandTip = useBandTip(props.bandTip, props.phone === true, menuBands, (id) => bandOnScreen(bodyRef.current, id));
  // The row callbacks keep one identity for the list's life (they call the latest props), so a row whose
  // data did not change is not rendered again when the list is (ListRow is memoized on its row's content).
  const latest = useRef(props);
  // Written after commit, never during render: a render React throws away (concurrent rendering) must not leave
  // its props behind. The callbacks run only from events, which come after a commit.
  useLayoutEffect(() => {
    latest.current = props;
  });
  const swipeLayerRef = useRowSwipe(bodyRef, latest, onRowAction !== undefined, titleOf);
  const openRow = useCallback((row: InboxListRow) => latest.current.onOpen(row), []);
  const markRead = useCallback((row: InboxListRow) => latest.current.onMarkRead?.(row), []);
  const markUnread = useCallback((row: InboxListRow) => latest.current.onMarkUnread?.(row), []);
  const sendNow = useCallback((row: InboxListRow) => latest.current.onSendNow?.(row), []);
  const unstar = useCallback((row: InboxListRow) => latest.current.onUnstar?.(row), []);
  const unarchive = useCallback((row: InboxListRow) => latest.current.archived?.unarchive(row), []);
  // A row's time reads "8:22 PM" today and "Oct 19" after midnight: a new day renders every row again.
  const day = new Date().toDateString();
  const scheduledRows = useScheduled().rows;
  /** One row, the same in both views; `drawn` is the group the held list draws it in. */
  const renderRow = (row: InboxListRow, drawn: InboxListGroupId) => (
    <ListRow
      {...rowTintOf(props.tagColours, row)}
      key={row.thread_id}
      row={scheduledLook(row, scheduledRows)}
      project={props.projectNames?.get(row.project.id) ?? row.project.name}
      away={!!row.machine && (props.machines?.away.has(row.machine) ?? false)}
      drawn={drawn}
      // A phone's row has no hover action (a hover on a touch screen is a first tap): Mark read is in the thread's header there.
      shape={asAgents && drawn !== 'archived' ? (props.phone ? 'phone-line' : 'line') : props.phone ? 'phone' : twoLine ? 'narrow' : 'wide'}
      full={fullWords}
      filtered={noProject}
      selected={row.thread_id === props.selectedThreadId}
      lit={lit(row)}
      onOpen={openRow}
      onMarkRead={props.onMarkRead ? markRead : undefined}
      onMarkUnread={props.onMarkUnread ? markUnread : undefined}
      onSendNow={props.onSendNow ? sendNow : undefined}
      onUnstar={props.onUnstar ? unstar : undefined}
      onUnarchive={drawn === 'archived' ? unarchive : undefined}
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
      noPulls={look.hidePulls}
      picking={pick.on}
      picked={pick.on && pick.has(row.thread_id)}
      onPick={pick.onRowBox}
    />
  );
  return (
    <section
      ref={listEl}
      id={columnId}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${resizable ? ' ib-resizable' : ''}${noProject ? ' ib-noproj' : ''}${fullWords ? ' ib-fullw' : ''}${pinColumn ? ' ib-pincol' : ''}${listLookClasses(look)}`}
      aria-label={props.title}
      data-picking={pick.on ? '' : undefined}
      onClickCapture={pick.onClickCapture}
    >
      {pick.bar}
      <div className="ib-lhead" hidden={pick.on}>
        <SidebarTrigger />
        {props.onRefresh ? (
          <h1 dir="auto" className="ib-lhead-h">
            {/* Two tooltips, each on its own part: the name's (a project's full name and folder, never beside the name;
                else the name when the header cuts it, else the ↻'s), and the ↻'s, below it: "Refresh" with Shift+R's
                two keycaps (the owner, on #2911; withShortcut leaves the keys out with single keys or Show keys on
                buttons off, and Tip opens on no touch screen). The ↻'s box takes the gap, so no part of the button
                is without a tooltip. */}
            <button
              type="button"
              className="ib-lhead-title"
              onClick={props.onRefresh}
              aria-describedby={refreshHintId}
              aria-keyshortcuts={refreshKeys}
              data-list-refresh=""
              data-refreshing={props.refreshSpin != null ? '' : undefined}
            >
              {props.titleMark && <span className="ib-lhead-mark">{props.titleMark}</span>}
              {props.path ? (
                <Tip content={<ProjectTipText name={props.title} root={props.path} />}>
                  <span className="ib-lhead-tt">{props.title}</span>
                </Tip>
              ) : (
                <Tip content={titleCut ? props.title : refreshTip} when={titleTipWhen} side={titleCut ? 'top' : 'bottom'}>
                  <span className="ib-lhead-tt">{props.title}</span>
                </Tip>
              )}
              <Tip content={refreshTip} side="bottom">
                <span className="ib-lhead-ic" data-list-refresh-icon="">
                  <Icon key={props.refreshSpin ?? 'rest'} name="refresh" size={16} className="ib-ic-refresh" />
                </span>
              </Tip>
            </button>
          </h1>
        ) : (
          <Tip content={props.path ? <ProjectTipText name={props.title} root={props.path} /> : props.title} cut={!props.path}>
            <h1 dir="auto">
              {props.titleMark && <span className="ib-lhead-mark">{props.titleMark}</span>}
              {props.title}
            </h1>
          </Tip>
        )}
        {props.titleNote && (
          <span className="ib-lhead-note" data-list-title-note="">
            {props.titleNote}
          </span>
        )}
        {/* The button's description, outside the h1 so the heading reads only the name. */}
        {props.onRefresh && <span id={refreshHintId} hidden>Refresh the list</span>}
        {/* The filter: the funnel alone, at every width (listFilter.ts). */}
        {props.listFilter && <ListFilterButton source={props.listFilter} phone={isMobile} />}
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
            starredAbove={props.rememberLook !== false && props.starred ? { on: starredAbove, onChange: setStarredAbove } : undefined}
            onSelect={pick.start}
            markAllRead={markAllRead ? { disabled: listMarkAllRows(sections).length === 0, onClick: () => void markAllRead(listMarkAllRows(sections)) } : undefined}
            showArchived={props.archived && props.rememberLook !== false ? { on: showArchived, onChange: props.archived.setOn } : undefined}
            tagColours={props.tagColours?.setShow ? { on: props.tagColours.show, onChange: props.tagColours.setShow } : undefined}
          />
        )}
      </div>
      {props.listFilter && <RecentViewBar place={props.listFilter.place ?? ''} picking={pick.on} />}{titleField}{props.listFilter && <RecentViewSaid place={props.listFilter.place ?? ''} />}
      {starredAbove && props.starred && (
        <StarredPills
          rows={props.starred.rows}
          projectNames={props.projectNames}
          openThreadId={props.selectedThreadId}
          phone={props.phone === true}
          onOpen={props.starred.onOpen}
          onAction={props.starred.onAction}
        />
      )}
      {pulls && (
        // The ↻ a pull reveals under the header, behind the list (pullRefresh.ts moves it). Not for a screen reader:
        // the title is the accessible way, and the live region says the refresh.
        <div ref={pullRef} className="ib-pull" aria-hidden="true" data-pull-indicator="">
          <span className="ib-pull-dot">
            <Icon name="refresh" size={18} />
          </span>
        </div>
      )}
      {/* Before the rows: Tab reaches it from the header, ahead of the list. Only after Show (listNewState.ts). */}
      <ListNewPill covered={props.covered === true} unseen={props.unseenNew ?? NO_UNSEEN} onGo={(edge) => props.onGoNew?.(edge)} />
        <ThreadRowMenu
          ref={bodyRef}
          className="ib-lbody"
          rowOf={rowOf}
          sectionOf={sectionOf}
          canMarkRead={props.onMarkRead !== undefined}
          onSnooze={props.onSnooze}
          snoozesOf={props.snoozesOf}
          snoozeRequest={snoozeRequest}
          snoozeBlockedOf={props.snoozeBlockedOf}
          onSnoozeBlocked={props.onSnoozeBlocked}
          pinnedOf={props.pinned ? (row) => (!props.machines || machineTakes(row, props.machines, 'star') ? props.pinned!.has(row.thread_id) : null) : undefined}
          prioritizesOf={props.machines ? (row) => machineTakes(row, props.machines!, 'priority') : undefined}
          onTarget={(id) => setMenuRow(id)}
          onAction={(row, action) => onRowAction?.(row, action)}
          disabled={!onRowAction}
          held={props.selectedThreadId !== null}
          phone={props.phone === true}
          picks={pick.menu}
          bands={bands}
        >
          {onRowAction && <RowSwipeLayer ref={swipeLayerRef} />}
          {props.stale}
          {props.ask}
          {awayLines.map((line) => (
            // A linked machine that is away: one quiet line, as a thread's meta line reads (its rows are greyed below).
            <p key={line.id} className="ib-away" data-machine-away={line.id}>
              <Icon name="clock" size={14} />
              {line.text}
            </p>
          ))}
          <HoldViewOnBar body={bodyRef} lines={bar.lines}>
            <HeldNoticeLine here={bar.here} elsewhere={bar.elsewhere} onShow={() => showNew()} onShowAll={props.onShowAll} />
          </HoldViewOnBar>
          {/* The band alone is an empty list with a band under it: nothing else says the list is clear. */}
          {/* So is a list whose rows are all archived, waiting for the list to settle without them (Archive all). */}
          {visible.every((section) => section.id === 'snoozed' || section.threads.every(inboxRowArchived)) && (titleEmpty === undefined ? props.empty : titleEmpty)}
          {/* The rows' tooltips mount on first use (RowTip.tsx): drawing every row's at once is most of a redraw. Recent activity's times (`sort.by`). */}
          <ListRows timeBy={props.sort?.by}>
          {flat && flat.rows.length > 0 && (
            // List: one run of rows, newest first, no bands; each row keeps the group it is drawn in for its actions.
            <div className="ib-group" data-section-id="list" data-flat-list="">
              {flat.rows.map(({ row, drawn }) => renderRow(row, drawn))}
            </div>
          )}
          {asAgents && <AgentsList sections={sections} sort={props.sort} machines={props.machines} selectedThreadId={props.selectedThreadId} phone={props.phone === true} remember={props.rememberLook !== false} renderRow={renderRow} shows={shows} onDrawn={setAgentRows} />}
          {/* List and Agents draw only the Snoozed band, folded under the rows as the groups draw it. */}
          {(asList || asAgents ? (listBand ? [listBand] : []) : visible).map((section) => {
            const state = groups.state(section.id);
            const open = state.open;
            // Closed, with something new inside since: the count goes bold. The group never opens by itself.
            const fresh = !state.open && newSince(section.threads, state.since);
            return (
              <div key={section.id} className="ib-group" data-section-id={section.id} role="group" aria-label={section.label}>
                {pick.groupBox(section, open)}
                <GroupBand
                  open={open}
                  menu={menuRow === bandMenuId(section.id)}
                  keys={bands && bands.actionsOf(section.id).length > 0 ? rowKeys : undefined}
                  tip={bandTip.shown?.band === section.id ? bandTip.shown.words : null}
                  tipEnd={props.phone === true}
                  onPointed={() => bandTip.pointed(section.id)}
                  onLeft={() => bandTip.left(section.id)}
                  onToggle={(band) => {
                    // Focus in a row of the group that closes goes to its header, not to the page.
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
                </GroupBand>
                {open && section.threads.map((row) => renderRow(row, section.id))}
              </div>
            );
          })}
          {archived && showArchived && <ArchivedGroup host={archived} renderRow={renderRow} onRows={setArchivedRows} phone={props.phone === true} onSearch={props.onSearch} />}
          </ListRows>
        </ThreadRowMenu>
      {pick.sheet}
      <HeldNoticeSaid words={bar.words} place={`${props.scope ?? ''}\n${props.title}`} />
      {props.reconnecting && (
        <p className="ib-relink" data-inbox-reconnecting="">
          Reconnecting…
        </p>
      )}
      {resizable && <ListColumnEdge controls={columnId} onCollapse={props.onHide} />}
    </section>
  );
}

/**
 * One row of the list, in the shape the list draws. Every list read brings new
 * row objects, so it is memoized on the row's content, not its identity: a
 * list update renders only the rows that changed.
 */
export const ListRow = memo(
  function ListRow({ row, project, away, drawn, shape, full, filtered, selected, lit, onOpen, onMarkRead, onMarkUnread, onSendNow, onUnstar, onUnarchive, menu, pinned, pinColumn, keys, pill, compact, noPreview = false, relative = false, titleFirst = false, timeBelow = false, statusMark = false, noAgents = false, noPulls = false, picking = false, picked = false, onPick, tint, tintName, tintAlso }: ListRowProps) {
    const open = () => onOpen(row), pickState = { picking, picked };
    const unstarRow = onUnstar && pinned ? () => onUnstar(row) : undefined;
    const rowLook: RowLook = { noPreview, relative, titleFirst, timeBelow, statusMark, noAgents, noPulls };
    const tagName = <RowTagName tint={tint} tintName={tintName} tintAlso={tintAlso} />;
    if (shape === 'line' || shape === 'phone-line') return <LineRow row={row} drawn={drawn} phone={shape === 'phone-line'} away={away} selected={selected} lit={lit} menu={menu} pinned={pinned} keys={keys} pill={pill} relative={relative} statusMark={statusMark} picking={picking} picked={picked} tint={tint} tagName={tagName} onOpen={open} onUnstar={unstarRow} onPick={onPick} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} onSendNow={onSendNow} />;
    if (shape === 'phone') return <PhoneRow row={row} project={project} away={away} filtered={filtered} lit={lit} menu={menu} pinned={pinned} keys={keys} pill={pill} compact={compact} {...rowLook} {...pickState} onOpen={open} onUnstar={unstarRow} tint={tint} tagName={tagName} />;
    return (
      <RowWithAction row={row} drawn={drawn} menu={menu} onMarkRead={picking ? undefined : onMarkRead} onMarkUnread={picking ? undefined : onMarkUnread} onSendNow={picking ? undefined : onSendNow} onUnarchive={picking ? undefined : onUnarchive}>
        {picking && onPick && <PickBox row state={picked ? 'all' : 'none'} label={`Select ${rowLabel(row, titleOf(row))}`} onPick={(event) => onPick(row, event)} />}
        {shape === 'narrow' ? (
          <NarrowRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} pill={pill} compact={compact} {...rowLook} {...pickState} onOpen={open} onUnstar={unstarRow} tint={tint} tagName={tagName} />
        ) : (
          <WideRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} pinColumn={pinColumn} keys={keys} selected={selected} full={full} pill={pill} noPreview={noPreview} relative={relative} statusMark={statusMark} noPulls={noPulls} {...pickState} onOpen={open} onUnstar={unstarRow} tint={tint} tagName={tagName} />
        )}
      </RowWithAction>
    );
  },
  sameListRow,
);

/** The guided review mark drops its label to its icon when the row is short of room: only then does it need a tooltip. */
function guideLabelHidden(trigger: Element): boolean {
  const label = trigger.querySelector<HTMLElement>('.ib-att-l');
  return !label || label.offsetWidth === 0 || getComputedStyle(label).display === 'none';
}

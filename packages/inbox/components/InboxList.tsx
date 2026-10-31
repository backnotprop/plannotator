import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { inboxListShortcuts } from '../shortcuts/list.shortcuts';
import { shortcutAria, useShortcutAria, withShortcut } from '../shortcuts/hint';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { agentName, formatCount, shortTime, waitCount } from '../format';
import { reaskRowLine, sentRowLine, undeliveredLabel } from '../deliveryLine';
import { sentRecipientsWords } from '../tags';
import { TagStack } from './TagPicker';
import { RowAgents, RowAgentTiles } from './RowAgents';
import { ProjectTipText, Tip } from './Tip';
import { AuthorMark, Icon } from '../icons';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { canMarkUnread, offersRowMarkRead } from '../markRead';
import { useNarrowerThan } from '../narrower';
import { inboxHasUnsent, inboxRowArchived, type InboxSectionId } from '@plannotator/core/inbox-types';
import { DraftLabel, rowUnsent, unsentWords } from './DraftLabel';
import { ThreadRowMenu } from './RowMenu';
import type { RowMenuAction } from '../rowMenu';
import { rowTimeIso, rowWait } from '../rowDelivery';
import { UndeliveredBadge, useMinuteClock } from './Undelivered';
import { TimeWithTick } from './DeliveryTick';
import { ActionBadge, RowBadge, WaitCard, badgeDescription, rowActionCount, rowHasBadge, shownCount } from './RowBadge';
import { attachPullToRefresh } from '../pullRefresh';
import { TidyMenu, type TidyController } from './Tidy';
import { awayLine, type MachinesModel } from '../machines';
import { listLookClasses, useListLook } from '../listLook';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { isComposingKey, keyTarget, modalOpen } from '../shortcuts/guards';
import { listMoveIndex, listStops, LIST_STOPS, type ListMove } from '../listKeys';

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
   * A thread is open beside the list: a column of its own width (380px, or
   * wider where the person dragged its edge), three-line rows until it is
   * wide enough for the wide ones.
   */
  narrow: boolean;
  selectedThreadId: string | null;
  notice: string | null;
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
  /**
   * The person's look options (listLook.ts) from this browser. False (the onboarding tour): today's list, every
   * option off, whatever this browser chose, as the tour's sidebar ignores its closed sections.
   */
  rememberLook?: boolean;
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
 * (Lines). The row itself draws its agents beside the project: after it on a wide row (`RowAgents`), before it on
 * a three-line or phone row (`RowAgentTiles`).
 */
function RowMark({ row }: { row: InboxListRow }) {
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
  return pill ? <span className="ib-key ib-rowkey">{title}</span> : title;
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
 * A wide row's first cell (approval "list-rows-mail-icons"): the project, then the agents' marks right after it.
 * The project is left out in one project's list, which leaves the marks alone. The cell is one line: the project
 * gives way with "…" (its tooltip shows it whole), the marks never do.
 */
function FromLine({ row, project, filtered }: { row: InboxListRow; project: string; filtered: boolean }) {
  return (
    <span className="ib-from">
      {!filtered && <ClipText className="ib-p" text={project} />}
      <RowAgents participants={row.participants} agent={rowAgent(row)} />
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
  return (
    <span className="ib-from ib-lead">
      {!filtered &&
        (tip ? (
          <ClipText className="ib-p" text={project} />
        ) : (
          <span className="ib-p" dir="auto">
            {project}
          </span>
        ))}
      <RowAgentTiles participants={row.participants} agent={rowAgent(row)} tip={tip} />
    </span>
  );
}

/**
 * What the count says in words (approval "inbox-row-byline"), or null: the open counts (`OpenCounts`) or nothing. A
 * three-line or phone row draws `short` in its 124 px slot (option A, 2026-10-29) and says `full` in the tooltip and its
 * name; a wide row draws `long`, the full words (the owner, 2026-10-29: full words in full-width mode). Open action
 * items are no longer words here (approval "inbox-row-action-icon", 2026-10-29): they are the action pill beside `?N`.
 */
function countWords(row: InboxListRow, now: number): { short: ReactNode; long: ReactNode; full: string } | null {
  const same = (words: string) => ({ short: words, long: words, full: words });
  // A reply waiting on a busy agent (approval "inbox-busy-agent-reply"): how long, in place of the count.
  const wait = rowWait(row.delivery);
  if (wait) return { short: <UndeliveredBadge wait={wait} now={now} />, long: <UndeliveredBadge wait={wait} now={now} full />, full: undeliveredLabel(wait.since, now) };
  // A Quiet row says why it is there: archived (resolved), or marked read.
  if (inboxRowArchived(row)) return same('Archived');
  // What the person has not sent (approval "inbox-reply-drafts"): "Draft", and "Draft · Your reply, 2 picks" in full.
  if (row.unsent && inboxHasUnsent(row.unsent)) return { short: <DraftLabel unsent={row.unsent} short />, long: <DraftLabel unsent={row.unsent} />, full: `Draft · ${unsentWords(rowUnsent(row.unsent))}` };
  // Marked read with 👍 Looks good: the row says so in place of "Read".
  if (row.section === 'quiet' && (row.read_at ?? null) !== null && row.ack) return same(`👍 ${row.ack.label}`);
  if (row.section === 'quiet' && (row.read_at ?? null) !== null) return same('Read');
  // An older Inbox (no `unsent`): its own words.
  if (row.answered_not_sent) return { short: 'Answered', long: 'Answered, not sent', full: 'Answered, not sent' };
  if (row.section === 'sent' && row.addressee) return same(`To ${agentName(rowAgent(row))}`);
  return null;
}

/**
 * The count in words (`countWords`), nothing when the count is `?N` or there is none. A three-line or phone row draws
 * the short form, its full words for a screen reader and, with `tip`, in the tooltip. A wide row (`wide`) draws the
 * full words in its words column; cut there, they are the tooltip too.
 */
function CountWords({ row, tip = false, wide = false }: { row: InboxListRow; tip?: boolean; wide?: boolean }) {
  const now = useMinuteClock(rowWait(row.delivery) !== null);
  const words = countWords(row, now);
  if (!words) return null;
  const quiet = row.section === 'quiet' ? ' ib-qlabel' : '';
  if (wide) {
    return (
      <Tip content={words.full} when={(cell) => cell.scrollWidth > cell.clientWidth + 0.5 || [...cell.querySelectorAll('.ib-cst, .ib-draft-l')].some((t) => t.scrollWidth > t.clientWidth + 0.5)}>
        <span className={`ib-c ib-cwords ib-cfull${quiet}`} data-count-words={words.full}>
          <span className="ib-cs">{typeof words.long === 'string' ? <span className="ib-cst">{words.long}</span> : words.long}</span>
        </span>
      </Tip>
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
  return tip ? <Tip content={words.full}>{cell}</Tip> : cell;
}

/**
 * The row's count (approval "inbox-row-byline", 2026-10-29): at the right end of a three-line or phone row's line 3.
 * What waits on the person is the action pill and `?N` (`OpenCounts`); anything else in words (`CountWords`).
 */
function LineCount({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  return (
    <>
      <CountWords row={row} tip={tip} />
      <OpenCounts row={row} tip={tip} />
    </>
  );
}

/**
 * What waits on the person, when the row has no words (approval "inbox-row-action-icon", 2026-10-29): the open
 * action items' pill (`ActionBadge`, A2), then the open questions' `?N` (Q3). Under the alert badge in emphasis.
 */
function OpenCounts({ row, tip = false }: { row: InboxListRow; tip?: boolean }) {
  if (row.questions.open < 1 || countWords(row, 0) !== null) return null;
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
  return tip ? <Tip content={words}>{cell}</Tip> : cell;
}

/**
 * One line of text the row may cut with "…": ui's tooltip shows it whole on
 * hover (`Tip`; the window's provider sets the delays), only while it is cut. Never a
 * focus stop, and nothing for a screen reader to add: the row's name already
 * holds the whole text.
 */
function ClipText({ className, text }: { className: string; text: string }) {
  return (
    <Tip content={text} cut>
      <span className={className} dir="auto">
        {text}
      </span>
    </Tip>
  );
}

/**
 * The thread's name as a soft pill, cut with "…" (its tooltip shows it whole), or nothing.
 * `name` is what `threadChipName` gave. The open thread (Thread.tsx) draws it first in its
 * meta line, with `lead` (for a screen reader only) saying what the word is. The list's
 * rows no longer draw it: their title is the name (approval "list-rows-mail-icons").
 */
export function ThreadChip({ name, lead }: { name: string | null; lead?: string }) {
  if (!name) return null;
  return (
    <span className="ib-key">
      {lead && <span className="ib-sr">{lead}</span>}
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
    <Tip content="Guided review" when={guideLabelHidden}>
      <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review">
        <Icon name="book" size={13} />
        <span className="ib-att-l">Guided review</span>
      </span>
    </Tip>
  );
}

/**
 * The wide row's title cell (approval "list-rows-mail-icons"): the title, the grey preview, the pin and the guided
 * review mark. Short of room the preview gives way first, all the way, then the title; each cut ends in "…" with
 * its tooltip. The mark drops its label to its icon.
 */
function TitleCell({ row, pinned = false, pill = false }: { row: InboxListRow; pinned?: boolean; pill?: boolean }) {
  const preview = previewOf(row);
  return (
    <>
      <RowTitle row={row} className="ib-title" pill={pill} tip />
      {preview && <ClipText className="ib-pv" text={preview} />}
      {pinned && <PinMark />}
      <GuideMark row={row} />
    </>
  );
}

/**
 * A pinned thread's small pin in its list row (approval "inbox-pinned-threads"):
 * after the preview (wide and three-line rows), before the time (a phone's row).
 * For the eye only: the row's name ends with ", pinned" (`PinnedWords`).
 */
function PinMark() {
  return (
    <span className="ib-pinmark" data-pin-mark="" aria-hidden="true">
      <Icon name="pin" size={13} />
    </span>
  );
}

/** The end of a pinned row's accessible name. */
function PinnedWords() {
  return <span className="ib-sr">, pinned</span>;
}

/**
 * Below this list width the wide row of every project leaves its title cell
 * too little room (the project and agents, words, badge, open counts and time
 * columns are fixed at 220px, 124px, 52px, 84px and 76px), so the list draws
 * the three-line rows instead.
 */
export const WIDE_ROWS_MIN_LIST_WIDTH = 900;

/**
 * From this list width a wide row draws the full words and the badge's words (the owner, 2026-10-29: full words in
 * full-width mode; a 1440px window with the sidebar gives a 1192px list). Narrower wide rows keep approval
 * "inbox-row-byline", option A (the short forms, the bare triangle), so the subject keeps its room.
 */
export const FULL_WORDS_MIN_LIST_WIDTH = 1150;

/**
 * One row of the wide list, on one line (approval "inbox-row-byline", the
 * one-line row; its cells as approval "list-rows-mail-icons", 2026-10-30, lays
 * them out). Six columns: the project with the agents' marks after it, the
 * title cell (the thread's name in bold when unread, then the grey subject),
 * then right-aligned the words, the badge, the open counts (the action pill,
 * `?N`) and the time, each in a column of its own so they line up down the
 * list. In one project's list (`filtered`) the first column holds the marks alone.
 */
function WideRow({ row, project, away, selected, filtered, lit, pinned, keys, full, pill, onOpen }: { row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; full: boolean; pill: boolean; onOpen: () => void }) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId();
  const badgeEl = badgeOf(row, kbd, full);
  const sent = row.section === 'sent';
  return (
    <>
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
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
        <TitleCell row={row} pinned={pinned} pill={pill} />
      </span>
      {/* Every column right of the words has a fixed width, so each lines up down the list. The words (a draft,
          Undelivered, Read …) take the width they need, between the title cell and the badge. */}
      <span className="ib-cw">
        <CountWords row={row} wide={full} tip={!full} />
      </span>
      <span className="ib-bcol">{badgeEl}</span>
      <span className="ib-cq">
        <OpenCounts row={row} tip />
      </span>
      <span className="ib-t">
        <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
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
  /** The group the row sits in on screen: a seen update the list still holds in New keeps Mark read. */
  drawn: InboxSectionId;
  menu: boolean;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  children: ReactNode;
}) {
  const offer = onMarkRead && offersRowMarkRead(row, drawn);
  // The action toggles (owner, 2026-10-31): on a read row (the row menu's rule, `canMarkUnread`) it is Mark unread.
  const unread = !offer && onMarkUnread && canMarkUnread(row);
  // A reply waiting on a busy agent that can take it now: Send now, on hover and keyboard focus as Mark read.
  const sendNow = onSendNow && !offer && !unread && row.delivery?.send_now === true && rowWait(row.delivery) !== null;
  return (
    <div
      className="ib-rw"
      data-row={row.thread_id}
      data-menu={menu ? '' : undefined}
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
        <Tip content={`Send now: put your reply into ${agentName(rowAgent(row))}'s running turn without waiting for it to end`}>
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
        </Tip>
      )}
      {offer && (
        <Tip content={withShortcut(`Mark read: out of the top until ${agentName(rowAgent(row))} writes again`, { scope: inboxThreadShortcuts, action: 'markRead' })}>
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
        </Tip>
      )}
      {unread && (
        <Tip content="Mark unread: back to New, bold. Nothing is sent.">
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
        </Tip>
      )}
    </div>
  );
}

function NarrowRow({ row, project, away, selected, filtered, lit, pinned, keys, pill, compact, onOpen }: { row: InboxListRow; project: string; away: boolean; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void }) {
  const [kbd, focus] = useKeyboardFocus(rowHasBadge(row));
  const wordsId = useId();
  const badge = badgeOf(row, kbd);
  return (
    <>
    <button
      type="button"
      className={`ib-nrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
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
      {/* Three lines (approval "inbox-list-row-v2", 2026-10-30). Line 1: the agents' tiles and the project after
          them, on one line, then the ✓ and the time at the right. Compact rows (approval "inbox-list-options"): the
          title joins line 1, before the time, cut with "…", and line 2 goes. */}
      <div className="ib-l1">
        <LeadLine row={row} project={project} filtered={filtered} />
        {compact && <RowTitle row={row} className="ib-title" pill={pill} tip />}
        <span className="ib-t">
          <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
        </span>
      </div>
      {/* Line 2: the title, never cut: a long one wraps (in its pill, one line cut with "…"). */}
      {!compact && (
        <div className="ib-l2">
          <RowTitle row={row} className="ib-title" pill={pill} tip={pill} />
        </div>
      )}
      {/* Line 3: the grey preview, cut first, then the pin, the guided review mark, and at the right end the badge
          and the count (inbox-row-byline's line 2 without the marks). Nothing to show: no line. */}
      <div className="ib-l3">
        <Preview row={row} />
        {pinned && <PinMark />}
        <GuideMark row={row} />
        {badge}
        <LineCount row={row} tip />
      </div>
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}

/**
 * A row on a phone, read like a mail app's, in the three-line row's order
 * (approval "inbox-list-row-v2", 2026-10-30): the agents' tiles and the
 * project, the pin and the time on line 1; the title on line 2, never cut; the
 * grey preview with the guided review book, the badge and the count at the
 * right end of line 3.
 */
function PhoneRow({ row, project, away, filtered, lit, menu, pinned, keys, pill, compact, onOpen }: { row: InboxListRow; project: string; away: boolean; filtered: boolean; lit: boolean; menu: boolean; pinned: boolean; keys?: string; pill: boolean; compact: boolean; onOpen: () => void }) {
  const wordsId = useId();
  // A phone: the icons only, no card (the thread shows the details).
  const badge = rowHasBadge(row) ? <RowBadge row={row} /> : null;
  const guide = row.guide && row.section !== 'sent';
  const preview = previewOf(row);
  return (
    <>
    <button
      type="button"
      className={`ib-mrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}`}
      onClick={onOpen}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-menu={menu ? '' : undefined}
      data-section={row.section}
      data-away={away ? '' : undefined}
      data-lit={lit ? '' : undefined}
      aria-describedby={rowHasBadge(row) ? wordsId : undefined}
    >
      <span className="ib-m1">
        <LeadLine row={row} project={project} filtered={filtered} tip={false} />
        {compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
        {pinned && <PinMark />}
        <span className="ib-t">
          <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
        </span>
      </span>
      {/* Line 2: the title, never cut (in its pill, one line cut with "…"); compact rows have it on line 1. Line 3:
          the preview (cut first), then the book, the badge and the count. */}
      {!compact && <RowTitle row={row} className="ib-m2" pill={pill} />}
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
        {badge}
        <LineCount row={row} />
      </span>
      {pinned && <PinnedWords />}
    </button>
    <BadgeWords row={row} id={wordsId} />
    </>
  );
}

export function InboxList(props: InboxListProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  // Each linked machine that is away, in the list it shows (every machine, or the one the filter shows).
  const awayLines = (props.machines?.linked ?? []).flatMap((machine) => {
    const text = props.machineScope && props.machineScope !== machine.id ? null : awayLine(machine);
    return text ? [{ id: machine.id, text }] : [];
  });
  // The list's look options in its ⋮ menu (listLook.ts), all off by default.
  const [look, setLook] = useListLook(props.rememberLook !== false);
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
      const stops = listStops(body);
      const at = listMoveIndex(stops.length, stops.indexOf(keyTarget(event) as HTMLElement), move);
      const next = at === null ? null : stops[at];
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
  const listEl = useCallback(
    (el: HTMLElement | null) => {
      listRef.current = el;
      fullRef.current = el;
    },
    [listRef, fullRef],
  );
  // Two-line rows in a list too narrow for the wide row's columns: beside an
  // open thread for every list (the column is 380px unless its edge was
  // dragged past the wide rows' width), and in the full list for every
  // project (one project's wide row fits any width).
  const twoLine = narrowList && (props.narrow || !props.filtered);
  // The full words on a wide row need a list of at least 1150px (FULL_WORDS_MIN_LIST_WIDTH); a narrower wide row
  // keeps the short forms and the bare triangles (option A).
  const fullWords = !twoLine && !shortWords;
  // The column beside a thread gets the sidebar's resize edge, except on a phone.
  const { isMobile, open: sidebarDocked } = useSidebar();
  // New message in the header: a phone always has it (its CSS draws it); a wider window only while the
  // main sidebar, which holds its own New message, is closed (the peek does not count as open).
  const headerCompose = isMobile || !sidebarDocked;
  const searchKeys = useShortcutAria({ scope: inboxSearchShortcuts, action: 'openSearch' });
  const columnId = useId();
  const refreshHintId = useId();
  const resizable = props.narrow && !isMobile;
  const visible = props.sections.filter((s) => s.threads.length > 0);
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
  // A row's time reads "8:22 PM" today and "Oct 19" after midnight: a new day renders every row again.
  const day = new Date().toDateString();
  return (
    <section
      ref={listEl}
      id={columnId}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${resizable ? ' ib-resizable' : ''}${props.filtered ? ' ib-noproj' : ''}${fullWords ? ' ib-fullw' : ''}${listLookClasses(look)}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <SidebarTrigger />
        {props.onRefresh ? (
          <h1 dir="auto" className="ib-lhead-h">
            {/* The full name in the tooltip too, for a project name the header cuts; a project's folder is there as well, never beside the name. */}
            <Tip content={props.path ? <ProjectTipText name={`Refresh ${props.title}`} root={props.path} /> : props.title === 'Inbox' ? 'Refresh' : `Refresh ${props.title}`}>
              <button
                type="button"
                className="ib-lhead-title"
                onClick={props.onRefresh}
                aria-describedby={refreshHintId}
                data-list-refresh=""
                data-refreshing={props.refreshSpin != null ? '' : undefined}
              >
                <span className="ib-lhead-tt">{props.title}</span>
                <Icon key={props.refreshSpin ?? 'rest'} name="refresh" size={16} className="ib-ic-refresh" />
              </button>
            </Tip>
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
          <Tip content="New message">
            <button
              type="button"
              className="ib-lhead-compose"
              data-open-compose=""
              // A wider window with the sidebar closed: the list header's own New message, at its far right.
              data-sidebar-closed={isMobile ? undefined : ''}
              aria-label="New message"
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
            onLook={setLook}
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
          pinnedOf={props.pinned ? (threadId) => props.pinned!.has(threadId) : undefined}
          onTarget={setMenuRow}
          onAction={(row, action) => onRowAction?.(row, action)}
          disabled={!onRowAction}
          held={props.selectedThreadId !== null}
        >
          {props.ask}
          {awayLines.map((line) => (
            // A linked machine that is away: one quiet line, as a thread's meta line reads (its rows are greyed below).
            <p key={line.id} className="ib-away" data-machine-away={line.id}>
              <Icon name="clock" size={14} />
              {line.text}
            </p>
          ))}
          {props.notice && (
            <button type="button" className="ib-notice" onClick={props.onShowNew} data-inbox-notice="">
              <Icon name="inbox" size={15} />
              {props.notice}
              <b>Show</b>
            </button>
          )}
          {visible.length === 0 && props.empty}
          {visible.map((section) => {
            const quiet = section.id === 'quiet';
            const open = !quiet || quietOpen;
            return (
              <div key={section.id} className="ib-group" data-section-id={section.id} role="group" aria-label={section.label}>
                {quiet ? (
                  <button type="button" className="ib-band" onClick={() => setQuietOpen((v) => !v)} aria-expanded={quietOpen}>
                    {section.label} <span className="ib-n">{formatCount(section.threads.length)}</span>
                    <Icon name={quietOpen ? 'chevD' : 'chevR'} size={14} />
                  </button>
                ) : (
                  <div className="ib-band">
                    {section.label} <span className="ib-n">{formatCount(section.threads.length)}</span>
                  </div>
                )}
                {open &&
                  section.threads.map((row) => (
                    <ListRow
                      key={row.thread_id}
                      row={row}
                      project={props.projectNames?.get(row.project.id) ?? row.project.name}
                      away={!!row.machine && (props.machines?.away.has(row.machine) ?? false)}
                      drawn={section.id}
                      // A phone's row has no hover action (a hover on a touch screen is a first tap): Mark read is in the thread's header there.
                      shape={props.phone ? 'phone' : twoLine ? 'narrow' : 'wide'}
                      full={fullWords}
                      filtered={props.filtered}
                      selected={row.thread_id === props.selectedThreadId}
                      lit={lit(row)}
                      onOpen={openRow}
                      onMarkRead={props.onMarkRead ? markRead : undefined}
                      onMarkUnread={props.onMarkUnread ? markUnread : undefined}
                      onSendNow={props.onSendNow ? sendNow : undefined}
                      day={day}
                      menu={menuRow === row.thread_id}
                      pinned={props.pinned?.has(row.thread_id) === true}
                      keys={rowKeys}
                      pill={look.highlight}
                      compact={look.compact}
                    />
                  ))}
              </div>
            );
          })}
        </ThreadRowMenu>
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
  drawn: InboxSectionId;
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
  /** Today's date: the row's time is written against it (shortTime). */
  day: string;
  /** Its right-click menu is open (RowMenu.tsx): the muted background. */
  menu: boolean;
  /** Pinned to the sidebar: a small pin after the subject. */
  pinned: boolean;
  /** `aria-keyshortcuts` for the row's menu (Shift+F10), when the list has one. */
  keys?: string;
  /** "Highlight thread subject" (listLook.ts): the title in its pill. */
  pill: boolean;
  /** "Compact rows" (listLook.ts): a three-line or phone row's title on line 1. */
  compact: boolean;
}

/**
 * One row of the list, in the shape the list draws. Every list read brings new
 * row objects, so it is memoized on the row's content, not its identity: a
 * list update renders only the rows that changed.
 */
export const ListRow = memo(
  function ListRow({ row, project, away, drawn, shape, full, filtered, selected, lit, onOpen, onMarkRead, onMarkUnread, onSendNow, menu, pinned, keys, pill, compact }: ListRowProps) {
    const open = () => onOpen(row);
    if (shape === 'phone') return <PhoneRow row={row} project={project} away={away} filtered={filtered} lit={lit} menu={menu} pinned={pinned} keys={keys} pill={pill} compact={compact} onOpen={open} />;
    return (
      <RowWithAction row={row} drawn={drawn} menu={menu} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} onSendNow={onSendNow}>
        {shape === 'narrow' ? (
          <NarrowRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} pill={pill} compact={compact} onOpen={open} />
        ) : (
          <WideRow row={row} project={project} away={away} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} full={full} pill={pill} onOpen={open} />
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
    a.keys === b.keys &&
    a.pill === b.pill &&
    a.compact === b.compact &&
    a.onOpen === b.onOpen &&
    a.onMarkRead === b.onMarkRead &&
    a.onMarkUnread === b.onMarkUnread &&
    a.onSendNow === b.onSendNow &&
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

import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { threadChipName } from '../threadChip';
import { agentName, formatCount, shortTime, waitCount } from '../format';
import { reaskRowLine, sentRowLine } from '../deliveryLine';
import { sentRecipientsWords } from '../tags';
import { TagStack } from './TagPicker';
import { Tip } from './Tip';
import { AuthorMark, Icon } from '../icons';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { offersRowMarkRead } from '../markRead';
import { useNarrowerThan } from '../narrower';
import { inboxHasUnsent, inboxRowArchived } from '@plannotator/core/inbox-types';
import { DraftLabel } from './DraftLabel';
import { ThreadRowMenu } from './RowMenu';
import type { RowMenuAction } from '../rowMenu';
import { rowTimeIso, rowWait } from '../rowDelivery';
import { UndeliveredBadge } from './Undelivered';
import { TimeWithTick } from './DeliveryTick';
import { attachPullToRefresh } from '../pullRefresh';

export interface InboxListProps {
  title: string;
  /** The project's folder, `~/src/billing-svc`, when one project is shown. */
  path: string | null;
  sections: readonly InboxListSection[];
  /** One project is shown: its rows drop the project label. */
  filtered: boolean;
  /**
   * A thread is open beside the list: a column of its own width (380px, or
   * wider where the person dragged its edge), two-line rows until it is
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
}

/**
 * Whom a row is about: the agent that wrote the thread, or, for a thread the
 * person started (compose), the agent it is addressed to (`addressee`), so the
 * row draws that agent's mark and name, never the person's.
 */
export function rowAgent(row: InboxListRow): InboxListRow['author'] {
  return row.addressee ? { kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } : row.author;
}

/** The row's mark: the agent's, or, when several agents are in the thread, their marks overlapping (Lines). */
function RowMark({ row }: { row: InboxListRow }) {
  if ((row.participants?.length ?? 0) > 1) return <TagStack participants={row.participants!} />;
  return <AuthorMark author={rowAgent(row)} />;
}

function badgeOf(row: InboxListRow): string | null {
  if (row.section === 'stopped') return 'Stopped';
  if (row.section === 'holding') return `Holds up ${row.questions.holds_up.length}`;
  return null;
}

/** The badge's class: its tint names the state (Stopped in the destructive colour, Holds up in the warning one). */
function badgeClass(row: InboxListRow): string {
  return row.section === 'stopped' ? 'ib-badge ib-b-stop' : 'ib-badge ib-b-hold';
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

function countOf(row: InboxListRow): ReactNode {
  // A reply waiting on a busy agent (approval "inbox-busy-agent-reply"): how long, in place of the count.
  const wait = rowWait(row.delivery);
  if (wait) return <UndeliveredBadge wait={wait} />;
  // A Quiet row says why it is there: archived (resolved), or marked read.
  if (inboxRowArchived(row)) return 'Archived';
  // What the person has not sent (approval "inbox-reply-drafts"): "Draft · Your reply, 2 picks".
  if (row.unsent && inboxHasUnsent(row.unsent)) return <DraftLabel unsent={row.unsent} />;
  // Marked read with 👍 Looks good: the row says so in place of "Read".
  if (row.section === 'quiet' && (row.read_at ?? null) !== null && row.ack) return `👍 ${row.ack.label}`;
  if (row.section === 'quiet' && (row.read_at ?? null) !== null) return 'Read';
  // An older Inbox (no `unsent`): its own words.
  if (row.answered_not_sent) return 'Answered, not sent';
  if (row.section === 'sent' && row.addressee) return `To ${agentName(rowAgent(row))}`;
  return waitCount(row.questions.open, row.questions.actions ?? 0);
}

/** The thread's name as a chip, unless the subject already starts with it (`threadChipName`). */
export function chipName(row: InboxListRow): string | null {
  return threadChipName(row.thread_name, subjectOf(row));
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
 * The thread chip, the subject and the guided review mark, shared by both row
 * shapes. When the line is short of room the subject gives way first, down to
 * a floor (inbox.css), then the chip; the mark drops its label to its icon.
 */
function SubjectLine({ row, pinned = false }: { row: InboxListRow; pinned?: boolean }) {
  const chip = chipName(row);
  return (
    <>
      {chip && (
        <span className="ib-key">
          <ClipText className="ib-keyt" text={chip} />
        </span>
      )}
      <span className="ib-s">
        <ClipText className="ib-st" text={subjectOf(row)} />
      </span>
      {pinned && <PinMark />}
      {/* The record's 1.1: a thread that carries a guided review says so after its subject. */}
      {row.guide && row.section !== 'sent' && (
        <Tip content="Guided review" when={guideLabelHidden}>
          <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review">
            <Icon name="book" size={13} />
            <span className="ib-att-l">Guided review</span>
          </span>
        </Tip>
      )}
    </>
  );
}

/**
 * A pinned thread's small pin in its list row (approval "inbox-pinned-threads"):
 * after the subject (wide and two-line rows), before the time (a phone's row).
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
 * Below this list width the wide row of every project leaves its subject cell
 * too little room (the project and badge columns are fixed at 130px and
 * 104px), so the list draws the two-line rows instead.
 */
export const WIDE_ROWS_MIN_LIST_WIDTH = 900;

/**
 * One row of the wide list. With every project shown it is five columns:
 * project, badge, subject, count, time. In one project's list (`filtered`)
 * the project and badge columns are not rendered at all: the badge, when the
 * row has one, leads the subject cell, so a row starts at the list's left edge
 * instead of after an empty block.
 */
function WideRow({ row, selected, filtered, lit, pinned, keys, onOpen }: { row: InboxListRow; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; onOpen: () => void }) {
  const badge = badgeOf(row);
  const sent = row.section === 'sent';
  const badgeEl = badge && <span className={badgeClass(row)}>{badge}</span>;
  return (
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-section={row.section}
      data-lit={lit ? '' : undefined}
    >
      {!filtered && <ClipText className="ib-p" text={row.project.name} />}
      {!filtered && <span>{badgeEl}</span>}
      <span className="ib-subj">
        {filtered && badgeEl}
        <RowMark row={row} />
        <SubjectLine row={row} pinned={pinned} />
      </span>
      <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{countOf(row)}</span>
      <span className="ib-t">
        <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
      </span>
      {pinned && <PinnedWords />}
    </button>
  );
}

/**
 * A row and its quiet hover action: Mark read on a row that waits on the
 * person, shown on hover or keyboard focus where the count and time are. It
 * never opens the thread. The action is the row's sibling (a button cannot
 * hold a button).
 */
function RowWithAction({
  row,
  menu,
  onMarkRead,
  onSendNow,
  children,
}: {
  row: InboxListRow;
  menu: boolean;
  onMarkRead?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  children: ReactNode;
}) {
  const offer = onMarkRead && offersRowMarkRead(row);
  // A reply waiting on a busy agent that can take it now: Send now, on hover and keyboard focus as Mark read.
  const sendNow = onSendNow && !offer && row.delivery?.send_now === true && rowWait(row.delivery) !== null;
  return (
    <div className="ib-rw" data-row={row.thread_id} data-menu={menu ? '' : undefined}>
      {children}
      {sendNow && (
        <Tip content={`Send now: put your reply into ${agentName(rowAgent(row))}'s running turn without waiting for it to end`}>
          <button
            type="button"
            className="ib-ract"
            data-row-send-now=""
            aria-label={`Send now: ${row.subject ?? '(no subject)'}`}
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
        <Tip content={`Mark read (E): out of the top until ${agentName(rowAgent(row))} writes again`}>
          <button
            type="button"
            className="ib-ract"
            data-row-mark-read=""
            aria-label={`Mark read: ${row.subject ?? '(no subject)'}`}
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
    </div>
  );
}

function NarrowRow({ row, selected, filtered, lit, pinned, keys, onOpen }: { row: InboxListRow; selected: boolean; filtered: boolean; lit: boolean; pinned: boolean; keys?: string; onOpen: () => void }) {
  const badge = badgeOf(row);
  const count = countOf(row);
  return (
    <button
      type="button"
      className={`ib-nrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-section={row.section}
      data-lit={lit ? '' : undefined}
    >
      <div className="ib-l1">
        <ClipText className="ib-p" text={filtered ? agentName(rowAgent(row)) : row.project.name} />
        {count && <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{count}</span>}
        <span className={`ib-t${count ? '' : ' ib-alone'}`}>
          <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
        </span>
      </div>
      <div className="ib-l2">
        {badge && <span className={badgeClass(row)}>{badge}</span>}
        <RowMark row={row} />
        <SubjectLine row={row} pinned={pinned} />
      </div>
      {pinned && <PinnedWords />}
    </button>
  );
}

/**
 * A row on a phone, read like a mail app's: who and when on the first line
 * (the agent's mark, the project, or the agent in one project's list, and the
 * time), the subject on up to two lines, then what the thread holds (the
 * badge, the thread's name, the question count, the guided review mark),
 * which wraps rather than pushing anything off the row.
 */
function PhoneRow({ row, filtered, lit, menu, pinned, keys, onOpen }: { row: InboxListRow; filtered: boolean; lit: boolean; menu: boolean; pinned: boolean; keys?: string; onOpen: () => void }) {
  const badge = badgeOf(row);
  const count = countOf(row);
  const guide = row.guide && row.section !== 'sent';
  const chip = chipName(row);
  return (
    <button
      type="button"
      className={`ib-mrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}`}
      onClick={onOpen}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={keys}
      data-menu={menu ? '' : undefined}
      data-section={row.section}
      data-lit={lit ? '' : undefined}
    >
      <span className="ib-m1">
        <RowMark row={row} />
        <ClipText className="ib-p" text={filtered ? agentName(rowAgent(row)) : row.project.name} />
        {pinned && <PinMark />}
        <span className="ib-t">
          <TimeWithTick delivery={row.delivery} time={shortTime(rowTimeIso(row))} />
        </span>
      </span>
      <span className="ib-m2" dir="auto">{subjectOf(row)}</span>
      {(badge || chip || count || guide) && (
        <span className="ib-m3">
          {badge && <span className={badgeClass(row)}>{badge}</span>}
          {chip && (
            <span className="ib-key">
              <span className="ib-keyt" dir="auto">{chip}</span>
            </span>
          )}
          {count && <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{count}</span>}
          {guide && (
            <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review">
              <Icon name="book" size={13} />
              <span className="ib-att-l">Guided review</span>
            </span>
          )}
        </span>
      )}
      {pinned && <PinnedWords />}
    </button>
  );
}

export function InboxList(props: InboxListProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  // Another project on a phone: the list starts at its top. The list itself stays mounted (its Quiet fold and,
  // across a resize past the phone width, its scroll are kept).
  const bodyRef = useRef<HTMLDivElement>(null);
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
  // Two-line rows in a list too narrow for the wide row's columns: beside an
  // open thread for every list (the column is 380px unless its edge was
  // dragged past the wide rows' width), and in the full list for every
  // project (one project's wide row fits any width).
  const twoLine = narrowList && (props.narrow || !props.filtered);
  // The column beside a thread gets the sidebar's resize edge, except on a phone.
  const { isMobile, open: sidebarDocked } = useSidebar();
  // New message in the header: a phone always has it (its CSS draws it); a wider window only while the
  // main sidebar, which holds its own New message, is closed (the peek does not count as open).
  const headerCompose = isMobile || !sidebarDocked;
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
  const onRowAction = props.onRowAction;
  // Shift+F10 opens a row's menu (the context-menu key too), named on each row for assistive technology.
  const rowKeys = onRowAction ? 'Shift+F10' : undefined;
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
  const sendNow = useCallback((row: InboxListRow) => latest.current.onSendNow?.(row), []);
  // A row's time reads "8:22 PM" today and "Oct 19" after midnight: a new day renders every row again.
  const day = new Date().toDateString();
  return (
    <section
      ref={listRef}
      id={columnId}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${resizable ? ' ib-resizable' : ''}${props.filtered ? ' ib-noproj' : ''}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <SidebarTrigger />
        {props.onRefresh ? (
          <h1 dir="auto" className="ib-lhead-h">
            {/* The full name in the tooltip too, for a project name the header cuts. */}
            <Tip content={props.title === 'Inbox' ? 'Refresh' : `Refresh ${props.title}`}>
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
          <Tip content={props.title} cut>
            <h1 dir="auto">{props.title}</h1>
          </Tip>
        )}
        {/* The button's description, outside the h1 so the heading reads only the name. */}
        {props.onRefresh && (
          <span id={refreshHintId} hidden>
            Refresh the list
          </span>
        )}
        {props.path && (
          <Tip content={props.path} cut>
            <span className="ib-path">{props.path}</span>
          </Tip>
        )}
        {props.onSearch && (
          <button type="button" className="ib-lhead-search" data-open-search="" aria-label="Search" aria-haspopup="dialog" onClick={(event) => props.onSearch?.(event.currentTarget)}>
            <Icon name="search" size={20} />
          </button>
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
          canMarkRead={props.onMarkRead !== undefined}
          pinnedOf={props.pinned ? (threadId) => props.pinned!.has(threadId) : undefined}
          onTarget={setMenuRow}
          onAction={(row, action) => onRowAction?.(row, action)}
          disabled={!onRowAction}
          held={props.selectedThreadId !== null}
        >
          {props.ask}
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
                      // A phone's row has no hover action (a hover on a touch screen is a first tap): Mark read is in the thread's header there.
                      shape={props.phone ? 'phone' : twoLine ? 'narrow' : 'wide'}
                      filtered={props.filtered}
                      selected={row.thread_id === props.selectedThreadId}
                      lit={lit(row)}
                      onOpen={openRow}
                      onMarkRead={props.onMarkRead ? markRead : undefined}
                      onSendNow={props.onSendNow ? sendNow : undefined}
                      day={day}
                      menu={menuRow === row.thread_id}
                      pinned={props.pinned?.has(row.thread_id) === true}
                      keys={rowKeys}
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
  shape: 'wide' | 'narrow' | 'phone';
  filtered: boolean;
  selected: boolean;
  lit: boolean;
  onOpen: (row: InboxListRow) => void;
  onMarkRead?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
  /** Today's date: the row's time is written against it (shortTime). */
  day: string;
  /** Its right-click menu is open (RowMenu.tsx): the muted background. */
  menu: boolean;
  /** Pinned to the sidebar: a small pin after the subject. */
  pinned: boolean;
  /** `aria-keyshortcuts` for the row's menu (Shift+F10), when the list has one. */
  keys?: string;
}

/**
 * One row of the list, in the shape the list draws. Every list read brings new
 * row objects, so it is memoized on the row's content, not its identity: a
 * list update renders only the rows that changed.
 */
const ListRow = memo(
  function ListRow({ row, shape, filtered, selected, lit, onOpen, onMarkRead, onSendNow, menu, pinned, keys }: ListRowProps) {
    const open = () => onOpen(row);
    if (shape === 'phone') return <PhoneRow row={row} filtered={filtered} lit={lit} menu={menu} pinned={pinned} keys={keys} onOpen={open} />;
    return (
      <RowWithAction row={row} menu={menu} onMarkRead={onMarkRead} onSendNow={onSendNow}>
        {shape === 'narrow' ? (
          <NarrowRow row={row} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} onOpen={open} />
        ) : (
          <WideRow row={row} filtered={filtered} lit={lit} pinned={pinned} keys={keys} selected={selected} onOpen={open} />
        )}
      </RowWithAction>
    );
  },
  (a, b) =>
    a.shape === b.shape &&
    a.filtered === b.filtered &&
    a.selected === b.selected &&
    a.lit === b.lit &&
    a.day === b.day &&
    a.menu === b.menu &&
    a.pinned === b.pinned &&
    a.keys === b.keys &&
    a.onOpen === b.onOpen &&
    a.onMarkRead === b.onMarkRead &&
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

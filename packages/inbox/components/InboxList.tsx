import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { agentName, formatCount, questionCount, shortTime } from '../format';
import { titleIfClipped } from '../clipTitle';
import { AuthorMark, Icon } from '../icons';
import { ListColumnEdge } from '../shell/ListColumnEdge';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { offersRowMarkRead } from '../markRead';
import { useNarrowerThan } from '../narrower';

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
  onOpen: (row: InboxListRow) => void;
  /** The row's hover action (a row that waits on the person): Mark read, without opening it. Absent: no action. */
  onMarkRead?: (row: InboxListRow) => void;
  /** A phone (phone.ts): the list fills the window and its rows are a mail app's. */
  phone?: boolean;
  /** The project shown (null: every project). A phone opens another project's list at its top, as a mail app opens another mailbox. */
  scope?: string | null;
  /** Opens search: on a phone, the list header's search icon (inbox.css shows it there only). */
  onSearch?: (opener: HTMLElement) => void;
  /** Opens compose: on a phone, the list header's compose icon beside search (inbox.css shows it there only). */
  onCompose?: (opener: HTMLElement) => void;
}

/**
 * Whom a row is about: the agent that wrote the thread, or, for a thread the
 * person started (compose), the agent it is addressed to (`addressee`), so the
 * row draws that agent's mark and name, never the person's.
 */
export function rowAgent(row: InboxListRow): InboxListRow['author'] {
  return row.addressee ? { kind: 'agent', host: row.addressee.host, session: row.addressee.session, name: null } : row.author;
}

function badgeOf(row: InboxListRow): string | null {
  if (row.section === 'stopped') return 'Stopped';
  if (row.section === 'holding') return `Holds up ${row.questions.holds_up.length}`;
  return null;
}

/** The subject cell's words: a Sent row says where its reply is (the agent reads it when it checks). */
function subjectOf(row: InboxListRow): string {
  // A thread the person started keeps its own subject in Sent; its count cell says whom it went to.
  if (row.section === 'sent' && !row.addressee) return `Saved for ${agentName(rowAgent(row))}. It sees it when it checks.`;
  return row.subject ?? '(no subject)';
}

function countOf(row: InboxListRow): string {
  // A Quiet row says why it is there: archived (resolved), or marked read.
  if (row.section === 'quiet' && row.resolved_at !== null && row.back_from_archive !== true) return 'Archived';
  if (row.section === 'quiet' && (row.read_at ?? null) !== null) return 'Read';
  if (row.answered_not_sent) return 'Answered, not sent';
  if (row.section === 'sent' && row.addressee) return `To ${agentName(rowAgent(row))}`;
  return questionCount(row.questions.open);
}

/**
 * The thread chip, the subject and the guided review mark, shared by both row
 * shapes. When the line is short of room the subject gives way first, down to
 * a floor (inbox.css), then the chip; the mark drops its label to its icon.
 */
function SubjectLine({ row }: { row: InboxListRow }) {
  return (
    <>
      {row.thread_name && (
        <span className="ib-key">
          <span className="ib-keyt" dir="auto" data-clip="">
            {row.thread_name}
          </span>
        </span>
      )}
      <span className="ib-s">
        <span className="ib-st" dir="auto" data-clip="">
          {subjectOf(row)}
        </span>
      </span>
      {/* The record's 1.1: a thread that carries a guided review says so after its subject. */}
      {row.guide && row.section !== 'sent' && (
        <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review" title="Guided review">
          <Icon name="book" size={13} />
          <span className="ib-att-l">Guided review</span>
        </span>
      )}
    </>
  );
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
function WideRow({ row, selected, filtered, onOpen }: { row: InboxListRow; selected: boolean; filtered: boolean; onOpen: () => void }) {
  const badge = badgeOf(row);
  const sent = row.section === 'sent';
  const badgeEl = badge && <span className="ib-badge">{badge}</span>;
  return (
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      data-section={row.section}
    >
      {!filtered && <span className="ib-p" dir="auto" data-clip="">{row.project.name}</span>}
      {!filtered && <span>{badgeEl}</span>}
      <span className="ib-subj">
        {filtered && badgeEl}
        <AuthorMark author={rowAgent(row)} />
        <SubjectLine row={row} />
      </span>
      <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{countOf(row)}</span>
      <span className="ib-t">{shortTime(row.last_at)}</span>
    </button>
  );
}

/**
 * A row and its quiet hover action: Mark read on a row that waits on the
 * person, shown on hover or keyboard focus where the count and time are. It
 * never opens the thread. The action is the row's sibling (a button cannot
 * hold a button).
 */
function RowWithAction({ row, onMarkRead, children }: { row: InboxListRow; onMarkRead?: (row: InboxListRow) => void; children: ReactNode }) {
  const offer = onMarkRead && offersRowMarkRead(row);
  return (
    <div className="ib-rw" data-row={row.thread_id}>
      {children}
      {offer && (
        <button
          type="button"
          className="ib-ract"
          data-row-mark-read=""
          title={`Mark read (E): out of the top until ${agentName(rowAgent(row))} writes again`}
          aria-label={`Mark read: ${row.subject ?? '(no subject)'}`}
          onClick={(event) => {
            event.stopPropagation();
            onMarkRead(row);
          }}
        >
          <Icon name="checkCircle" size={15} />
          Mark read
        </button>
      )}
    </div>
  );
}

function NarrowRow({ row, selected, filtered, onOpen }: { row: InboxListRow; selected: boolean; filtered: boolean; onOpen: () => void }) {
  const badge = badgeOf(row);
  const count = countOf(row);
  return (
    <button
      type="button"
      className={`ib-nrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-thread-id={row.thread_id}
      data-section={row.section}
    >
      <div className="ib-l1">
        <span className="ib-p" dir="auto" data-clip="">{filtered ? agentName(rowAgent(row)) : row.project.name}</span>
        {count && <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{count}</span>}
        <span className={`ib-t${count ? '' : ' ib-alone'}`}>{shortTime(row.last_at)}</span>
      </div>
      <div className="ib-l2">
        {badge && <span className="ib-badge">{badge}</span>}
        <AuthorMark author={rowAgent(row)} />
        <SubjectLine row={row} />
      </div>
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
function PhoneRow({ row, filtered, onOpen }: { row: InboxListRow; filtered: boolean; onOpen: () => void }) {
  const badge = badgeOf(row);
  const count = countOf(row);
  const guide = row.guide && row.section !== 'sent';
  return (
    <button
      type="button"
      className={`ib-mrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}`}
      onClick={onOpen}
      data-thread-id={row.thread_id}
      data-section={row.section}
    >
      <span className="ib-m1">
        <AuthorMark author={rowAgent(row)} />
        <span className="ib-p" dir="auto" data-clip="">{filtered ? agentName(rowAgent(row)) : row.project.name}</span>
        <span className="ib-t">{shortTime(row.last_at)}</span>
      </span>
      <span className="ib-m2" dir="auto">{subjectOf(row)}</span>
      {(badge || row.thread_name || count || guide) && (
        <span className="ib-m3">
          {badge && <span className="ib-badge">{badge}</span>}
          {row.thread_name && (
            <span className="ib-key">
              <span className="ib-keyt" dir="auto">{row.thread_name}</span>
            </span>
          )}
          {count && <span className={`ib-c${row.section === 'quiet' ? ' ib-qlabel' : ''}`}>{count}</span>}
          {guide && (
            <span className="ib-att" data-guide-mark="" role="img" aria-label="Guided review" title="Guided review">
              <Icon name="book" size={13} />
              <span className="ib-att-l">Guided review</span>
            </span>
          )}
        </span>
      )}
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
  const [listRef, narrowList] = useNarrowerThan(WIDE_ROWS_MIN_LIST_WIDTH, props.narrow);
  // Two-line rows in a list too narrow for the wide row's columns: beside an
  // open thread for every list (the column is 380px unless its edge was
  // dragged past the wide rows' width), and in the full list for every
  // project (one project's wide row fits any width).
  const twoLine = narrowList && (props.narrow || !props.filtered);
  // The column beside a thread gets the sidebar's resize edge, except on a phone.
  const { isMobile } = useSidebar();
  const columnId = useId();
  const resizable = props.narrow && !isMobile;
  const visible = props.sections.filter((s) => s.threads.length > 0);
  return (
    <section
      ref={listRef}
      onPointerOver={titleIfClipped}
      id={columnId}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${resizable ? ' ib-resizable' : ''}${props.filtered ? ' ib-noproj' : ''}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1 dir="auto" data-clip="">
          {props.title}
        </h1>
        {props.path && (
          <span className="ib-path" data-clip="">
            {props.path}
          </span>
        )}
        {props.onSearch && (
          <button type="button" className="ib-lhead-search" data-open-search="" aria-label="Search" aria-haspopup="dialog" onClick={(event) => props.onSearch?.(event.currentTarget)}>
            <Icon name="search" size={20} />
          </button>
        )}
        {props.onCompose && (
          <button type="button" className="ib-lhead-compose" data-open-compose="" aria-label="New message" aria-haspopup="dialog" onClick={(event) => props.onCompose?.(event.currentTarget)}>
            <Icon name="compose" size={20} />
          </button>
        )}
      </div>
      <div className="ib-lbody" ref={bodyRef}>
        {props.ask}
        {props.notice && (
          <button type="button" className="ib-notice" onClick={props.onShowNew} data-inbox-notice="">
            <Icon name="inbox" size={15} />
            {props.notice}
            <b>Show</b>
          </button>
        )}
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
                section.threads.map((row) =>
                  // A phone's row has no hover action (a hover on a touch screen is a first tap): Mark read is in the thread's header there.
                  props.phone ? (
                    <PhoneRow key={row.thread_id} row={row} filtered={props.filtered} onOpen={() => props.onOpen(row)} />
                  ) : (
                    <RowWithAction key={row.thread_id} row={row} onMarkRead={props.onMarkRead}>
                      {twoLine ? (
                        <NarrowRow row={row} filtered={props.filtered} selected={row.thread_id === props.selectedThreadId} onOpen={() => props.onOpen(row)} />
                      ) : (
                        <WideRow row={row} filtered={props.filtered} selected={row.thread_id === props.selectedThreadId} onOpen={() => props.onOpen(row)} />
                      )}
                    </RowWithAction>
                  ),
                )}
            </div>
          );
        })}
      </div>
      {resizable && <ListColumnEdge controls={columnId} />}
    </section>
  );
}

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { agentName, questionCount, shortTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';

export interface InboxListProps {
  title: string;
  /** The project's folder, `~/src/billing-svc`, when one project is shown. */
  path: string | null;
  sections: readonly InboxListSection[];
  /** One project is shown: its rows drop the project label. */
  filtered: boolean;
  /** A thread is open beside the list: two-line rows in a narrow column. */
  narrow: boolean;
  selectedThreadId: string | null;
  notice: string | null;
  /** The one-time notifications line (record 6.1), above everything else. */
  ask?: ReactNode;
  onShowNew: () => void;
  onOpen: (row: InboxListRow) => void;
}

function badgeOf(row: InboxListRow): string | null {
  if (row.section === 'stopped') return 'Stopped';
  if (row.section === 'holding') return `Holds up ${row.questions.holds_up.length}`;
  return null;
}

/** The subject cell's words: a Sent row says where its reply is (the agent reads it when it checks). */
function subjectOf(row: InboxListRow): string {
  if (row.section === 'sent') return `Saved for ${agentName(row.author)}. It sees it when it checks.`;
  return row.subject ?? '(no subject)';
}

function countOf(row: InboxListRow): string {
  if (row.answered_not_sent) return 'Answered, not sent';
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
          <span className="ib-keyt">{row.thread_name}</span>
        </span>
      )}
      <span className="ib-s">
        <span className="ib-st">{subjectOf(row)}</span>
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
 * Whether the list is narrower than `min`, read before paint and on every
 * resize. Unmeasured (no layout, no ResizeObserver) reads as wide.
 */
function useNarrowerThan(min: number) {
  const ref = useRef<HTMLElement>(null);
  const [narrower, setNarrower] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (width: number) => setNarrower(width > 0 && width < min);
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => read(entries[0]?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [min]);
  return [ref, narrower] as const;
}

/**
 * One row of the wide list. With every project shown it is five columns:
 * project, badge, subject, count, time. In one project's list (`filtered`)
 * the project and badge columns are not rendered at all: the badge, when the
 * row has one, leads the subject cell, so a row starts at the list's left edge
 * instead of after an empty block.
 */
function WideRow({ row, filtered, onOpen }: { row: InboxListRow; filtered: boolean; onOpen: () => void }) {
  const badge = badgeOf(row);
  const sent = row.section === 'sent';
  const badgeEl = badge && <span className="ib-badge">{badge}</span>;
  return (
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}`}
      onClick={onOpen}
      data-thread-id={row.thread_id}
      data-section={row.section}
    >
      {!filtered && <span className="ib-p">{row.project.name}</span>}
      {!filtered && <span>{badgeEl}</span>}
      <span className="ib-subj">
        {filtered && badgeEl}
        <AuthorMark author={row.author} />
        <SubjectLine row={row} />
      </span>
      <span className="ib-c">{countOf(row)}</span>
      <span className="ib-t">{shortTime(row.last_at)}</span>
    </button>
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
        <span className="ib-p">{filtered ? agentName(row.author) : row.project.name}</span>
        {count && <span className="ib-c">{count}</span>}
        <span className={`ib-t${count ? '' : ' ib-alone'}`}>{shortTime(row.last_at)}</span>
      </div>
      <div className="ib-l2">
        {badge && <span className="ib-badge">{badge}</span>}
        <AuthorMark author={row.author} />
        <SubjectLine row={row} />
      </div>
    </button>
  );
}

export function InboxList(props: InboxListProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  const [listRef, narrowList] = useNarrowerThan(WIDE_ROWS_MIN_LIST_WIDTH);
  // Two-line rows beside an open thread, and for every project in a list too narrow for the wide row's columns.
  const twoLine = props.narrow || (!props.filtered && narrowList);
  const visible = props.sections.filter((s) => s.threads.length > 0);
  return (
    <section
      ref={listRef}
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${props.filtered ? ' ib-noproj' : ''}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1>{props.title}</h1>
        {props.path && <span className="ib-path">{props.path}</span>}
      </div>
      <div className="ib-lbody">
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
                  {section.label} <span className="ib-n">{section.threads.length}</span>
                  <Icon name={quietOpen ? 'chevD' : 'chevR'} size={14} />
                </button>
              ) : (
                <div className="ib-band">
                  {section.label} <span className="ib-n">{section.threads.length}</span>
                </div>
              )}
              {open &&
                section.threads.map((row) =>
                  twoLine ? (
                    <NarrowRow
                      key={row.thread_id}
                      row={row}
                      filtered={props.filtered}
                      selected={row.thread_id === props.selectedThreadId}
                      onOpen={() => props.onOpen(row)}
                    />
                  ) : (
                    <WideRow key={row.thread_id} row={row} filtered={props.filtered} onOpen={() => props.onOpen(row)} />
                  ),
                )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

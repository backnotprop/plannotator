import { useState } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { agentName, questionCount, shortTime } from '../format';
import { AuthorMark, Icon } from '../icons';

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

function WideRow({ row, onOpen }: { row: InboxListRow; onOpen: () => void }) {
  const badge = badgeOf(row);
  const sent = row.section === 'sent';
  return (
    <button
      type="button"
      className={`ib-row${row.unread ? ' ib-u' : ''}${sent ? ' ib-sent' : ''}`}
      onClick={onOpen}
      data-thread-id={row.thread_id}
      data-section={row.section}
    >
      <span className="ib-p">{row.project.name}</span>
      <span>{badge && <span className="ib-badge">{badge}</span>}</span>
      <span className="ib-subj">
        <AuthorMark author={row.author} />
        {row.thread_name && <span className="ib-key">{row.thread_name}</span>}
        <span className="ib-s">{subjectOf(row)}</span>
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
        {row.thread_name && <span className="ib-key">{row.thread_name}</span>}
        <span className="ib-s">{subjectOf(row)}</span>
      </div>
    </button>
  );
}

export function InboxList(props: InboxListProps) {
  const [quietOpen, setQuietOpen] = useState(false);
  const visible = props.sections.filter((s) => s.threads.length > 0);
  return (
    <section
      className={`ib-listcol${props.narrow ? ' ib-narrow' : ''}${props.filtered ? ' ib-noproj' : ''}`}
      aria-label={props.title}
    >
      <div className="ib-lhead">
        <h1>{props.title}</h1>
        {props.path && <span className="ib-path">{props.path}</span>}
      </div>
      <div className="ib-lbody">
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
                  props.narrow ? (
                    <NarrowRow
                      key={row.thread_id}
                      row={row}
                      filtered={props.filtered}
                      selected={row.thread_id === props.selectedThreadId}
                      onOpen={() => props.onOpen(row)}
                    />
                  ) : (
                    <WideRow key={row.thread_id} row={row} onOpen={() => props.onOpen(row)} />
                  ),
                )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

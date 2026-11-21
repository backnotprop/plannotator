/**
 * Who gets the reply, on a phone (approval "inbox-phone-composer-picker"): the control and the sheet it opens. A
 * computer keeps ReplyRecipient.tsx. Like that one it shows only in a thread with several agents (ThreadPane's
 * `pillActive`): a one-agent thread has no control at all.
 *
 * - A thread's reply box (`chip`; approval "inbox-reply-target-chip", option B, 2026-11-20, which superseded the
 *   mark-only control in the row): the computer's chip at the start of the words' first line, "to [mark] Pi ⌄", with
 *   the name (the short one, as a narrow box shows it), drawn by the field (FieldLead.tsx). Its name is the computer's.
 * - Without `chip` (a PR's new thread): the control in the box's row, after the paperclip and Skills. One recipient: its
 *   mark and a small chevron, never a name (`AgentPill`). Several: the first mark with how many (`AgentMark`).
 * - The sheet: each agent by its session's title (issue #2450) with "<agent> · <folder>" under it. A tap on a row sends
 *   to that agent only and closes; the circle at a row's end adds it and the sheet stays; the last row types a real `@`.
 *   A start row (thread/replyStart.ts), "+ [mark] New Claude Code session" with "in ledger" under it, takes it alone.
 *
 * The rules stay replyRecipients.ts and ThreadPane's (the choice, the most one reply goes to, Send).
 */
import { HostMark, Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import { labelOf, type SessionLabels } from '../sessionLabels';
import { agentName, namesList } from '../tags';
import { recipientNames } from '../thread/recipientNames';
import { AgentMark, AgentPill } from './AgentPill';
import { BottomSheet } from './BottomSheet';
import { SheetLine, SheetRow } from './SheetRow';
import { RecipientChip } from './ReplyRecipient';


const AtSign = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function PhoneReplyRecipient({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  section,
  labels,
  folderOf,
  noun = 'reply',
  chip = false,
}: {
  /** Every agent the sheet offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (a typed `@` included). */
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  /** Add a second recipient. Absent (a PR's new thread): one recipient only, a row's circle only shows the choice. */
  onToggle?: (row: RecipientRow) => void;
  /** The last row, "Tag another agent". Absent: no such row. */
  onTagAnother?: () => void;
  /** The thread's pane: the sheet is drawn in it. */
  section: HTMLElement | null;
  /** Each session's title, where it has one. */
  labels: SessionLabels;
  /** The folder a session works in, as the thread knows it. */
  folderOf: (session: string) => string;
  /** What is sent: a reply, or a PR's new thread's first message (`PullThreadStart`), as the sheet and names say it. */
  noun?: 'reply' | 'message';
  /** The chip at the start of the words (a thread's reply box, drawn as the field's lead), not the control in the row. */
  chip?: boolean;
}) {
  const titleOf = (row: RecipientRow) => labelOf(labels, row.session);
  const names = recipientNames(rows, labels, folderOf);
  const chosenIds = chosen.map((r) => r.session);
  const first = chosen[0];
  const ended = chosen.length === 1 && first!.state === 'ended';
  /** As it is read out: "Claude Code · Invoice PDF fonts", each agent with its session's title. */
  const spoken = namesList(chosen.map((r) => (titleOf(r) ? `${agentName(r.host)} · ${titleOf(r)}` : r.label)));
  const control = {
    open,
    keepFocus: true,
    onClick: () => onOpen(!open),
    ariaLabel: `${noun === 'reply' ? 'Reply' : 'Message'} goes to ${spoken || 'nobody yet'}${ended ? ', ended' : ''}. Change`,
    attrs: { 'data-recipient': '', 'data-recipient-chosen': chosenIds.join(' ') },
  };
  return (
    <>
      {chip ? (
        <RecipientChip rows={rows} chosen={chosen} open={open} onClick={() => onOpen(!open)} labels={labels} folderOf={folderOf} noun={noun} attrs={{ 'aria-haspopup': 'dialog' }} narrowAtFirst />
      ) : !first ? (
        <AgentPill {...control} label="Choose an agent" ask />
      ) : chosen.length === 1 ? (
        <AgentPill {...control} host={first.host} agent={first.start ? null : first.session} start={!!first.start} label={null} detail={ended ? 'ended' : null} />
      ) : (
        <AgentMark {...control} host={first.host} agent={first.session} count={chosen.length} />
      )}
      <BottomSheet open={open} onClose={() => onOpen(false)} title={`Who gets this ${noun}`} host={section} attrs={{ 'data-recipient-list': '' }}>
        <div className="ib-sheet-list" role="listbox" aria-label={`Who gets this ${noun}`} aria-multiselectable={onToggle ? true : undefined}>
          {rows.map((row) => {
            const on = chosenIds.includes(row.session);
            if (row.start) {
              return (
                <SheetRow
                  key={row.session}
                  lead={
                    <>
                      <span className="ib-cp-plus" aria-hidden="true">
                        <Icon name="plus" size={12} />
                      </span>
                      <span className="ib-sheet-mark">
                        <HostMark host={row.host} />
                      </span>
                    </>
                  }
                  title={row.label}
                  detail={[`in ${row.start.project}`, row.start.asleep ? "starts when it's back" : null].filter(Boolean).join(' · ')}
                  ariaLabel={`${row.label} in ${row.start.project}`}
                  selected={on}
                  attrs={{ 'data-recipient-row': row.session, 'data-recipient-start': row.host ?? '' }}
                  onClick={() => onOnly(row)}
                  end={
                    <span role="checkbox" aria-checked={on} aria-hidden="true" className="ib-sheet-tick">
                      <Icon name="check" size={13} />
                    </span>
                  }
                />
              );
            }
            const title = titleOf(row);
            const named = names.get(row.session) ?? { name: title ?? row.label, detail: undefined };
            return (
              <SheetRow
                key={row.session}
                host={row.host}
                agent={row.session}
                title={named.name}
                detail={named.detail}
                selected={on}
                disabled={row.alone === false}
                attrs={{ 'data-recipient-row': row.session }}
                onClick={() => onOnly(row)}
                end={
                  !onToggle ? (
                    <span role="checkbox" aria-checked={on} aria-hidden="true" className="ib-sheet-tick">
                      <Icon name="check" size={13} />
                    </span>
                  ) : (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`Also send to ${named.name}`}
                    className="ib-sheet-tick"
                    data-recipient-tick={row.session}
                    disabled={!canAddRecipient(row, chosenIds, rows)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggle(row);
                    }}
                  >
                    <Icon name="check" size={13} />
                  </button>
                  )
                }
              />
            );
          })}
          {onTagAnother && (
            <>
              <SheetLine />
              <SheetRow quiet lead={<AtSign />} title="Tag another agent" attrs={{ 'data-recipient-tag': '' }} onClick={onTagAnother} />
            </>
          )}
        </div>
      </BottomSheet>
    </>
  );
}

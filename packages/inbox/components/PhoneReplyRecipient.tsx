/**
 * Who gets the reply, on a phone (approval "inbox-phone-composer-picker"): the agent control in the reply box's row,
 * after the paperclip and Skills, and the sheet it opens. A computer keeps ReplyRecipient.tsx.
 *
 * - A thread with one agent: its mark alone (`AgentMark`). The agent is seldom changed there; the sheet names it and
 *   offers the `@`.
 * - A thread with several: the mark and a short name with a chevron (`AgentPill`), so the person sees who gets the
 *   reply before Send. Several recipients: the first mark with how many.
 * - The sheet: each agent by its session's title (issue #2450) with "<agent> · <folder>" under it, a check on who
 *   gets the reply. A tap on a row sends to that agent only and closes; with several agents the circle at a row's end
 *   adds it and the sheet stays; the last row types a real `@`.
 *
 * The rules stay replyRecipients.ts and ThreadPane's (the choice, the most one reply goes to, Send).
 */
import { Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import { labelOf, type SessionLabels } from '../sessionLabels';
import { agentName, namesList } from '../tags';
import { AgentMark, AgentPill } from './AgentPill';
import { BottomSheet } from './BottomSheet';
import { SheetLine, SheetRow } from './SheetRow';

const QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };
const TITLE = 'Who gets this reply';

const AtSign = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function PhoneReplyRecipient({
  rows,
  chosen,
  several,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  section,
  labels,
  folderOf,
}: {
  /** Every agent the sheet offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (a typed `@` included). */
  chosen: readonly RecipientRow[];
  /** The thread has several agents: the control names the recipient, and rows can be added to. */
  several: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  onToggle: (row: RecipientRow) => void;
  onTagAnother: () => void;
  /** The thread's pane: the sheet is drawn in it. */
  section: HTMLElement | null;
  /** Each session's title, where it has one. */
  labels: SessionLabels;
  /** The folder a session works in, as the thread knows it. */
  folderOf: (session: string) => string;
}) {
  const titleOf = (row: RecipientRow) => labelOf(labels, row.session);
  const chosenIds = chosen.map((r) => r.session);
  const first = chosen[0];
  const ended = chosen.length === 1 && first!.state === 'ended';
  /** As it is read out: "Claude Code · Invoice PDF fonts", each agent with its session's title. */
  const spoken = namesList(chosen.map((r) => (titleOf(r) ? `${agentName(r.host)} · ${titleOf(r)}` : r.label)));
  const control = {
    open,
    keepFocus: true,
    onClick: () => onOpen(!open),
    ariaLabel: `Reply goes to ${spoken || 'nobody yet'}${ended ? ', ended' : ''}. Change`,
    attrs: { 'data-recipient': '', 'data-recipient-chosen': chosenIds.join(' ') },
  };
  return (
    <>
      {!first ? (
        <AgentPill {...control} label="Choose an agent" ask />
      ) : several && chosen.length === 1 ? (
        <AgentPill {...control} host={first.host} label={titleOf(first) ?? first.short} detail={ended ? 'ended' : null} />
      ) : (
        <AgentMark {...control} host={first.host} count={chosen.length} ended={ended} />
      )}
      <BottomSheet open={open} onClose={() => onOpen(false)} title={TITLE} host={section} attrs={{ 'data-recipient-list': '' }}>
        <div className="ib-sheet-list" role="listbox" aria-label={TITLE} aria-multiselectable={several || undefined}>
          {rows.map((row) => {
            const on = chosenIds.includes(row.session);
            const title = titleOf(row);
            return (
              <SheetRow
                key={row.session}
                host={row.host}
                title={title ?? row.label}
                detail={[title ? agentName(row.host) : null, QUIET[row.state] ?? folderOf(row.session)].filter(Boolean).join(' · ')}
                selected={on}
                disabled={row.alone === false}
                attrs={{ 'data-recipient-row': row.session }}
                onClick={() => onOnly(row)}
                end={
                  several ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`Also send to ${title ?? row.label}`}
                      className="ib-sheet-tick"
                      data-recipient-tick={row.session}
                      disabled={!canAddRecipient(row, chosenIds)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(row);
                      }}
                    >
                      <Icon name="check" size={13} />
                    </button>
                  ) : (
                    on && <Icon name="check" size={18} className="ib-sheet-check" />
                  )
                }
              />
            );
          })}
          <SheetLine />
          <SheetRow quiet lead={<AtSign />} title="Tag another agent" attrs={{ 'data-recipient-tag': '' }} onClick={onTagAnother} />
        </div>
      </BottomSheet>
    </>
  );
}

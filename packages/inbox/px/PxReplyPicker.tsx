/**
 * PROTOTYPE ONLY (branch proto/composer-picker; never merged): who gets the reply, as the one picker. The pill sits in
 * the reply box's bottom row on a phone and a computer alike and names the session by its title; its list is the
 * thread's agents, each by title with "Claude Code · project" under it. A tap on a row sends to that agent only; the
 * circle at its end adds it; the last row types a real `@`. The rules stay replyRecipients.ts and ThreadPane's.
 */
import { useRef } from 'react';
import { Icon } from '../icons';
import { useComposeSessions } from '../compose/useComposeSessions';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import { agentName, namesList } from '../tags';
import { PxPill, PxRow, PxSurface } from './PxPicker';

const QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };

export function PxReplyPicker({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  phone,
  section,
  project,
  several,
}: {
  rows: readonly RecipientRow[];
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  onToggle: (row: RecipientRow) => void;
  onTagAnother: () => void;
  phone: boolean;
  /** The thread's pane: the sheet is drawn in it. */
  section: HTMLElement | null;
  /** The thread's project, for a session the live list does not name. */
  project: string;
  /** The thread has several agents: rows can be added to (the circles). One agent: the list names it and offers the `@`. */
  several: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  // The sessions' titles, as New message's To reads them.
  const { model } = useComposeSessions(true);
  const live = new Map((model?.projects ?? []).flatMap((group) => group.sessions.map((s) => [s.session, { label: s.label ?? null, project: group.project.name }] as const)));
  const titleOf = (row: RecipientRow) => live.get(row.session)?.label ?? null;
  const chosenIds = chosen.map((r) => r.session);
  const one = chosen.length === 1 ? chosen[0]! : null;
  const names = namesList(chosen.map((r) => titleOf(r) ?? r.label));
  const ended = one?.state === 'ended';
  const label = one ? (titleOf(one) ?? one.label) : chosen.length > 0 ? `${chosen.length} agents` : 'Choose an agent';
  return (
    <>
      <PxPill
        buttonRef={anchor}
        hosts={chosen.map((r) => r.host)}
        label={label}
        detail={ended ? 'ended' : null}
        ask={chosen.length === 0}
        open={open}
        ariaLabel={`To ${names || 'nobody yet'}${ended ? ', ended' : ''}. Change who gets this reply`}
        attrs={{ 'data-recipient': '', 'data-ended': ended ? '' : undefined, 'data-px-chosen': chosenIds.join(',') }}
        onClick={() => onOpen(!open)}
      />
      <PxSurface open={open} phone={phone} title="Who gets this reply" onClose={() => onOpen(false)} anchor={anchor} host={phone ? section : null} label="Who gets this reply" attrs={{ 'data-recipient-list': '' }}>
        <div className="ib-px-list" role="listbox" aria-label="Who gets this reply" aria-multiselectable={several || undefined}>
          {rows.map((row) => {
            const on = chosenIds.includes(row.session);
            const title = titleOf(row);
            const agent = agentName(row.host);
            const detail = [title ? agent : null, QUIET[row.state] ?? live.get(row.session)?.project ?? project].filter(Boolean).join(' · ');
            return (
              <PxRow
                key={row.session}
                phone={phone}
                host={row.host}
                title={title ?? row.label}
                detail={detail}
                selected={on}
                highlighted={on}
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
                      className="ib-px-tick"
                      data-on={on ? '' : undefined}
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
                    on && <Icon name="check" size={18} className="ib-px-ck" />
                  )
                }
              />
            );
          })}
          <div className="ib-px-sep" aria-hidden="true" />
          <PxRow
            phone={phone}
            plain
            lead={
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Tag another agent"
            attrs={{ 'data-recipient-tag': '' }}
            onClick={onTagAnother}
          />
        </div>
      </PxSurface>
    </>
  );
}

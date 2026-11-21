/**
 * A thread under an agent in the list's Agents view (design A): one line, its title, the thread's other agents' small
 * icons, the counts every row draws (rowParts.tsx `LineCount`: the action box and `?N`, a draft, Session ended …) and
 * its time. Everything else a row does is the same as in the other views, because it is the same kind of element in
 * the same place: a `data-thread-id` button in a `.ib-rw[data-row]` wrapper straight in its `.ib-group` (a click
 * opens it, ↑ ↓ J K move to it, the row menu and a phone's long press find it, a phone's swipe moves it, a settle
 * slides it); on a wider window the wrapper is `RowWithAction` (its hover Mark read, Mark unread, Send now). Bold
 * while unread, the selection's fill while open.
 */
import { createContext, useContext, useId, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { BadgeWords, LineCount, RowTime, RowTitle, RowWithAction, cardOf, titleOf } from '../components/rowParts';
import { RowAgentTiles } from '../components/RowAgents';
import { useRowDragA11y } from '../components/RowMenu';
import { PickBox, PickMark } from '../components/PickBar';
import { useKeyboardFocus } from '../components/useKeyboardFocus';
import { rowHasBadge } from '../components/RowBadge';
import { PinMark } from '../parts/RowPin';
import { tintProps } from '../parts/RowTint';
import { notePressPointer, pressRow } from '../starPress';
import { rowLabel } from '../scheduled/rowLook';
import { otherAgents } from './model';

/** The sessions of the agent a row is drawn under: its other agents are the rest of its participants. */
export const LineAgent = createContext<readonly string[] | null>(null);

const PERSON = { kind: 'person' } as const;

export interface LineRowProps {
  row: InboxListRow;
  drawn: InboxListGroupId;
  phone: boolean;
  away: boolean;
  selected: boolean;
  lit: boolean;
  menu: boolean;
  pinned: boolean;
  keys?: string;
  pill: boolean;
  relative: boolean;
  statusMark: boolean;
  picking: boolean;
  picked: boolean;
  tint?: string;
  tagName: ReactNode;
  onOpen: () => void;
  onUnstar?: () => void;
  onPick?: (row: InboxListRow, event: ReactMouseEvent) => void;
  onMarkRead?: (row: InboxListRow) => void;
  onMarkUnread?: (row: InboxListRow) => void;
  onSendNow?: (row: InboxListRow) => void;
}

export function LineRow(props: LineRowProps) {
  const { row, phone, picking, picked } = props;
  const sessions = useContext(LineAgent);
  const others = sessions ? otherAgents(row, sessions) : [];
  const badge = rowHasBadge(row);
  const [kbd, focus] = useKeyboardFocus(badge && !phone);
  const wordsId = useId();
  const dragA11y = useRowDragA11y(badge ? wordsId : undefined);
  const button = (
    <button
      type="button"
      className={`ib-lrow${row.unread ? ' ib-u' : ''}${row.section === 'sent' ? ' ib-sent' : ''}${props.selected && !phone ? ' ib-sel' : ''}${picked ? ' ib-picked' : ''}`}
      aria-pressed={picking ? picked : undefined}
      aria-current={props.selected ? 'true' : undefined}
      onPointerDown={notePressPointer}
      onClick={(event) => pressRow(event, row.thread_id, props.onOpen, props.onUnstar)}
      data-thread-id={row.thread_id}
      // The row's menu (RowMenu.tsx); a click opens the thread, so no aria-haspopup.
      aria-keyshortcuts={props.keys}
      data-section={row.section}
      data-away={props.away ? '' : undefined}
      data-lit={props.lit ? '' : undefined}
      {...dragA11y}
      {...tintProps(props.tint)}
      {...(phone ? {} : focus)}
    >
      {phone && picking && <PickMark on={picked} />}
      <RowTitle row={row} className="ib-lrow-t" pill={props.pill} tip={!phone} />
      {others.length > 0 && <RowAgentTiles participants={others} agent={PERSON} tip={!phone} />}
      <span className="ib-lend">
        {props.pinned && <PinMark threadId={row.thread_id} press={!!props.onUnstar} />}
        <LineCount row={row} tip={!phone} status={props.statusMark} card={phone ? undefined : cardOf(row)} open={kbd} />
      </span>
      {props.tagName}
      <span className="ib-t">
        <RowTime row={row} relative={props.relative} />
      </span>
    </button>
  );
  if (phone) {
    // A phone's row has no hover action (a hover on a touch screen is a first tap): the wrapper alone, which its
    // swipe and its long press find.
    return (
      <div className="ib-rw" data-row={row.thread_id} data-menu={props.menu ? '' : undefined}>
        {button}
        <BadgeWords row={row} id={wordsId} />
      </div>
    );
  }
  return (
    <RowWithAction row={row} drawn={props.drawn} menu={props.menu} onMarkRead={picking ? undefined : props.onMarkRead} onMarkUnread={picking ? undefined : props.onMarkUnread} onSendNow={picking ? undefined : props.onSendNow}>
      {picking && props.onPick && <PickBox row state={picked ? 'all' : 'none'} label={`Select ${rowLabel(row, titleOf(row))}`} onPick={(event) => props.onPick!(row, event)} />}
      {button}
      <BadgeWords row={row} id={wordsId} />
    </RowWithAction>
  );
}

/**
 * The checklist's line at the top of the thread (approval "inbox-checklist-spinners-2026-11-07", Take C with
 * spinners), under the thread's subject and meta line: the current step with its mark, then a quieter count.
 *
 *   fresh    "◯ Next: <step> · 0 of 4 done"
 *   doing    "<spinner> <step> · 1 of 4 done"
 *   waiting  "<amber pause> Waiting on you: <step> · 2 of 4 done" (the first words amber)
 *   all done "✓ All steps done · 4 of 4"
 *
 * A click opens the whole list in place under it (a disclosure button with `aria-expanded`; no popover, no sheet),
 * with the same marks; a second click closes it. No keyboard shortcut (the approval's "No new keyboard shortcuts").
 * The line cuts a long step with "…"; the list under it shows every step whole.
 *
 * Freshness is the spinner alone, by the line's and each list's presence class: it turns while its session works, is
 * still and dimmed while idle, and still and grey once ended, when the count adds "as of 2:40 PM".
 */

import { useId, useState } from 'react';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { presenceClass, stepsAsOf, stepsLine, stepsLineList, stepsLineName } from './model';
import { StepGlyph } from './StepsMarks';
import { StepsLists } from './StepsList';

export interface StepsLineProps {
  /** The lists with steps, newest first (model.ts `shownStepLists`). Empty: no line. */
  lists: readonly InboxStepsWire[];
  phone: boolean;
  /** Where a list's "Waiting on you ›" goes (its session's open question), or null: the words stay, with no link. */
  onWaiting?: (list: InboxStepsWire) => (() => void) | null;
  /**
   * The Board card that links the thread (approval "inbox-thread-steps", part 4), while the Board is on and a card
   * links it; null: no icon. Shown at the line's end while the list is open.
   */
  boardCard?: { title: string; onOpen: () => void } | null;
  /** Held open or closed from outside (the reveal dialog's picture); absent: the line's own click decides. */
  open?: boolean;
  now?: Date;
}

export function StepsLine({ lists, phone, onWaiting, boardCard = null, open: held, now }: StepsLineProps) {
  const [ownOpen, setOpen] = useState(false);
  const listId = useId();
  const shown = stepsLineList(lists);
  if (!shown) return null;
  const open = held ?? ownOpen;
  const line = stepsLine(shown);
  const asOf = stepsAsOf(shown, now);
  // Another session's list too: "+1" says it is there (the open list shows them all, each under its agent's name).
  const more = lists.length - 1;
  const name = `${stepsLineName(agentName(shown.agent), shown)}${more > 0 ? `, and ${more} more checklist${more === 1 ? '' : 's'}` : ''}`;
  return (
    <div className={`ib-stl${phone ? ' ib-stl-phone' : ''}`} data-steps-line={line.kind} data-presence={shown.presence}>
      <div className="ib-stl-row">
        {/* The presence class on the button alone: each list under it carries its own session's. */}
        <button
          type="button"
          className={`ib-stl-btn ${presenceClass(shown.presence)}`}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={name}
          data-steps-toggle=""
          onClick={() => setOpen(!open)}
        >
          <span className="ib-st-gl">
            <StepGlyph status={line.mark} />
          </span>
          <span className="ib-stl-now" data-steps-now="">
            {line.kind === 'waiting' && <span className="ib-stl-wait">Waiting on you:</span>}
            {line.kind === 'next' && <span className="ib-stl-quiet">Next:</span>}
            {line.kind === 'done' ? (
              'All steps done'
            ) : (
              <>
                {line.kind === 'doing' ? null : ' '}
                <bdi>{line.step}</bdi>
              </>
            )}
          </span>
          <span className="ib-stl-cnt" data-steps-count="">
            {line.count}
            {asOf && <span data-steps-as-of=""> · as of {asOf}</span>}
          </span>
          {more > 0 && (
            <span className="ib-st-more" data-steps-more="">
              +{more}
            </span>
          )}
          <span className="ib-stl-chev">
            <Icon name={open ? 'chevU' : 'chevD'} size={13} />
          </span>
        </button>
        {open && boardCard && (
          <Tip content="Open its card on the Board">
            <button type="button" className="ib-st-card" aria-label={`Open “${boardCard.title}” on the Board`} data-steps-card="" onClick={boardCard.onOpen}>
              <Icon name="board" size={phone ? 18 : 15} />
            </button>
          </Tip>
        )}
      </div>
      {open && (
        <div id={listId} className="ib-stl-list" data-steps-panel="">
          <StepsLists lists={lists} heads="many" onWaiting={onWaiting} now={now} />
        </div>
      )}
    </div>
  );
}

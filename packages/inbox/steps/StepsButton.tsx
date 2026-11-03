/**
 * The thread foot's steps button (approval "inbox-thread-steps", A1): "◑ 3/6 ⌃" beside the open questions, opening
 * the steps in a popover on a desktop and a sheet from the bottom edge on a phone, by the open-questions list's
 * rules (its positioner and scrim classes; 44 px targets on a phone). Base UI's Popover carries the keys (Escape
 * closes, focus back to the button) and `aria-expanded`. No keyboard shortcut (the approval's "Out of scope").
 *
 * The button shows the newest list's count (one list per agent session; the panel shows them all). Freshness is
 * the panel's class from each list's presence: the in-progress mark turns only while its session works, is still
 * and dim while idle, and dashed once ended, when the head adds "as of <time>".
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { Icon } from '../icons';
import { presenceClass, stepsCount, stepsName } from './model';
import { StepsPie } from './StepsMarks';
import { StepsLists } from './StepsList';

export interface StepsButtonProps {
  /** The lists with steps, newest first (model.ts `shownStepLists`). Empty: no button. */
  lists: readonly InboxStepsWire[];
  phone: boolean;
  /** Where a list's "Waiting on you ›" goes (its session's open question), or null: the words stay, with no link. */
  onWaiting: (list: InboxStepsWire) => (() => void) | null;
  /** What sits at the right of the panel's head (the Board's card, approval part 4). */
  headExtra?: React.ReactNode;
}

export function StepsButton({ lists, phone, onWaiting, headExtra = null }: StepsButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** A jump to the question takes focus there, not back to the button. */
  const jumped = useRef(false);
  // Drawn inside the window's root, so its styles and theme reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const first = lists[0];
  if (!first) return null;
  const { done, total, text } = stepsCount(first);
  const name = stepsName(agentName(first.agent), first);
  const waitingFor = (list: InboxStepsWire) => {
    const go = onWaiting(list);
    return go
      ? () => {
          jumped.current = true;
          setOpen(false);
          go();
        }
      : null;
  };
  return (
    <Popover.Root
      open={open}
      modal={phone}
      onOpenChange={(next) => {
        if (next) jumped.current = false;
        setOpen(next);
      }}
    >
      <Popover.Trigger ref={trigger} className={`ib-btn ib-st-btn ${presenceClass(first.presence)}`} data-steps-button="" aria-label={name}>
        <StepsPie done={done} total={total} size={13} />
        <span className="ib-st-num" aria-hidden="true">
          {text}
        </span>
        <span className="ib-oq-chev" aria-hidden="true">
          <Icon name="chevU" size={13} />
        </span>
      </Popover.Trigger>
      <Popover.Portal container={portal ?? undefined}>
        {phone && <Popover.Backdrop className="ib-oq-scrim" data-steps-scrim="" />}
        <Popover.Positioner className="ib-oq-pos ib-st-pos" side="top" align="start" sideOffset={8} collisionPadding={16} data-phone={phone ? '' : undefined}>
          <Popover.Popup className="ib-stp" aria-label={lists.length > 1 ? 'Checklist' : name} data-steps-panel="" finalFocus={() => (jumped.current ? false : (trigger.current ?? true))}>
            {phone && <div className="ib-st-grab" aria-hidden="true" />}
            <div className="ib-stp-scroll">
              <StepsLists
                lists={lists}
                onWaiting={waitingFor}
                headExtra={
                  <>
                    {headExtra}
                    {phone && (
                      <Popover.Close className="ib-st-x" aria-label="Close" data-steps-close="">
                        <Icon name="x" size={16} />
                      </Popover.Close>
                    )}
                  </>
                }
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The thread foot's steps button (approval "inbox-thread-steps", A1): "◑ 3/6 ⌃" beside the open questions, opening
 * the steps in a popover on a desktop and a sheet from the bottom edge on a phone, by the open-questions list's
 * rules (its positioner and scrim classes; 44 px targets on a phone). Base UI's Popover carries the keys (Escape
 * closes, focus back to the button) and `aria-expanded`. No keyboard shortcut (the approval's "Out of scope").
 *
 * The look (approval "inbox-checklist-spinners-2026-11-07", mock 1, and its 11:25Z addendum): the button looks like
 * Reply (its `.ib-btn` surface, theme tokens only) and shows the current step's mark, the amber pause while a step
 * waits on the person, the spinner while one is worked on, else the pie; then the count ("1/4"). It shows the list
 * that waits on the person, else the newest (one list per agent session; the panel shows them all). Freshness is
 * each list's presence class: the spinner turns only while its session works, is still and dim while idle, and still
 * and grey once ended, when the head adds "as of <time>".
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { drawStepsFit, fitFootRow, laidOutChildren } from '../footFit';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { presenceClass, stepsAsOf, stepsButtonList, stepsButtonMark, stepsCount, stepsName } from './model';
import { StepGlyph, StepsPie } from './StepsMarks';
import { StepsLists } from './StepsList';

export interface StepsButtonProps {
  /** The lists with steps, newest first (model.ts `shownStepLists`). Empty: no button. */
  lists: readonly InboxStepsWire[];
  phone: boolean;
  /** Where a list's "Waiting on you ›" goes (its session's open question), or null: the words stay, with no link. */
  onWaiting: (list: InboxStepsWire) => (() => void) | null;
  /**
   * The Board card that links the thread (approval part 4: "the small Board button in the head opens it"), while the
   * Board is on and a card links it; null: no icon.
   */
  boardCard?: { title: string; onOpen: () => void } | null;
}

export function StepsButton({ lists, phone, onWaiting, boardCard = null }: StepsButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** A jump to the question takes focus there, not back to the button. */
  const jumped = useRef(false);
  // Drawn inside the window's root, so its styles and theme reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // The row's fit: read only, this button gives way first (its chevron goes). Beside the open questions button,
  // that button's fit does it (before its own words shorten); alone, this one fits itself, on each render and resize.
  const fittedFor = useRef('');
  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => {
    const buttons = trigger.current?.parentElement;
    if (!buttons || buttons.querySelector('[data-open-questions]')) return;
    const key = `${buttons.getBoundingClientRect().width}|${laidOutChildren(buttons).map((el) => el.textContent ?? '').join('|')}`;
    if (key === fittedFor.current) return;
    fittedFor.current = key;
    drawStepsFit(buttons, fitFootRow(buttons, [false, true], (narrow) => drawStepsFit(buttons, narrow)) ?? false);
  };
  useLayoutEffect(() => fitRef.current());
  useLayoutEffect(() => {
    const buttons = trigger.current?.parentElement;
    if (!buttons || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(buttons);
    return () => observer.disconnect();
  }, [lists.length > 0]);
  const first = stepsButtonList(lists);
  if (!first) return null;
  // Another session's list too: "+1" says it is there (the panel shows them all).
  const more = lists.length - 1;
  const asOf = stepsAsOf(first);
  const name = `${stepsName(agentName(first.agent), first)}${asOf ? `, as of ${asOf}` : ''}${more > 0 ? `, and ${more} more checklist${more === 1 ? '' : 's'}` : ''}`;
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
        <StepsButtonFace list={first} more={more} />
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
                    {boardCard && (
                      <Tip content="Open its card on the Board">
                        <button
                          type="button"
                          className="ib-st-card"
                          aria-label={`Open “${boardCard.title}” on the Board`}
                          data-steps-card=""
                          onClick={() => {
                            // The Board takes the page: focus goes to the opened card, not back to this button.
                            jumped.current = true;
                            setOpen(false);
                            boardCard.onOpen();
                          }}
                        >
                          <Icon name="board" size={phone ? 18 : 15} />
                        </button>
                      </Tip>
                    )}
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

/**
 * What the button shows (the real one, and the intro's picture of it): the current step's mark (the amber pause, the
 * spinner, else the pie), the count, "· as of 2:40 PM" once the list's session ended, "+1" for another session's list
 * (the owner said yes to both, approval addendum), and the chevron.
 */
export function StepsButtonFace({ list, more = 0, now }: { list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>; more?: number; now?: Date }) {
  const { done, total, text } = stepsCount(list);
  const mark = stepsButtonMark(list);
  const asOf = stepsAsOf(list, now);
  return (
    <>
      {mark ? <StepGlyph status={mark} size={13} /> : <StepsPie done={done} total={total} size={13} />}
      <span className="ib-st-num" aria-hidden="true">
        {text}
      </span>
      {asOf && (
        <span className="ib-st-asof" data-steps-as-of="" aria-hidden="true">
          as of {asOf}
        </span>
      )}
      {more > 0 && (
        <span className="ib-st-more" data-steps-more="" aria-hidden="true">
          +{more}
        </span>
      )}
      <span className="ib-oq-chev" aria-hidden="true">
        <Icon name="chevU" size={13} />
      </span>
    </>
  );
}

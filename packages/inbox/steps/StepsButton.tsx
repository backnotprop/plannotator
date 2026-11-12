import { useLayoutEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { drawStepsFit, fitFootRow, laidOutChildren } from '../footFit';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { presenceClass, stepsAsOf, stepsButtonList, stepsButtonMark, stepsCount, stepsName, stepsWaitingNameTail, type StepsAnsweredSince } from './model';
import { StepGlyph, StepsPie } from './StepsMarks';
import { StepsLists } from './StepsList';

export interface StepsButtonProps {
  lists: readonly InboxStepsWire[];
  phone: boolean;
  onWaiting: (list: InboxStepsWire) => (() => void) | null;
  boardCard?: { title: string; onOpen: () => void } | null;
  answeredSince?: StepsAnsweredSince;
}

export function StepsButton({ lists, phone, onWaiting, boardCard = null, answeredSince }: StepsButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const jumped = useRef(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
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
  const first = stepsButtonList(lists, answeredSince);
  if (!first) return null;
  const more = lists.length - 1;
  const asOf = stepsAsOf(first);
  const name = `${stepsName(agentName(first.agent), first)}${stepsWaitingNameTail(first, answeredSince)}${asOf ? `, as of ${asOf}` : ''}${more > 0 ? `, and ${more} more checklist${more === 1 ? '' : 's'}` : ''}`;
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
        <StepsButtonFace list={first} more={more} answeredSince={answeredSince} />
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

export function StepsButtonFace({ list, more = 0, now, answeredSince }: { list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>; more?: number; now?: Date; answeredSince?: StepsAnsweredSince }) {
  const { done, total, text } = stepsCount(list);
  const mark = stepsButtonMark(list, answeredSince);
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

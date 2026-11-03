/**
 * A session's steps as rows (approval "inbox-thread-steps", A1): the shape, the step, and its right side (a done
 * step's time, a note, or "Waiting on you ›"). One text weight, no fills but hover; drawn the same in the foot's
 * popover, the phone's sheet and the Board's opened card. Read only: nothing here changes a step.
 */

import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { agentName } from '../format';
import { Icon } from '../icons';
import { STEP_STATUS_WORDS, presenceClass, stepMeta, stepsAsOf, stepsCount, stepsName } from './model';
import { StepGlyph, StepsPie } from './StepsMarks';

export function StepsList({ list, onWaiting, now }: { list: InboxStepsWire; onWaiting?: (() => void) | null; now?: Date }) {
  return (
    <ul className="ib-sts" data-steps-list="">
      {list.steps.map((step, index) => {
        const meta = stepMeta(step, now);
        return (
          <li key={`${index}:${step.step}`} className="ib-st" data-step-status={step.status} aria-label={`${step.step}, ${STEP_STATUS_WORDS[step.status]}${step.note && step.status !== 'done' ? `: ${step.note}` : ''}`}>
            <span className="ib-st-gl">
              <StepGlyph status={step.status} />
            </span>
            <span className="ib-st-t">{step.step}</span>
            {meta?.kind === 'time' && (
              <span className="ib-st-m" title={meta.title}>
                {meta.text}
              </span>
            )}
            {meta?.kind === 'note' && (
              <span className="ib-st-m" title={meta.text}>
                {meta.text}
              </span>
            )}
            {meta?.kind === 'waiting' &&
              (onWaiting ? (
                <button type="button" className="ib-st-m ib-st-jump" data-steps-waiting="" onClick={onWaiting}>
                  Waiting on you
                  <Icon name="chevR" size={12} />
                </button>
              ) : (
                <span className="ib-st-m ib-st-wait">Waiting on you</span>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A list's head: "Checklist ◑ 3/6", "· as of 2:40 PM" once its session ended, and what the caller adds at the right
 * (the Board icon, a phone's close). With more than one session's list, each head names its agent instead.
 */
export function StepsHead({
  list,
  label,
  children,
  now,
  headingId,
  heading = false,
}: {
  list: InboxStepsWire;
  label: string;
  children?: React.ReactNode;
  now?: Date;
  headingId?: string;
  /** The label is a section heading (the opened card's, beside Threads and Links), not plain words. */
  heading?: boolean;
}) {
  const { done, total, text } = stepsCount(list);
  const asOf = stepsAsOf(list, now);
  const Label = heading ? 'h3' : 'span';
  return (
    <div className="ib-st-head" data-steps-head="">
      <Label className="ib-st-lbl" id={headingId}>
        {label}
      </Label>
      <span className="ib-st-plan" aria-label={`${done} of ${total} done`}>
        <StepsPie done={done} total={total} size={12} />
        <span className="ib-st-num" aria-hidden="true">
          {text}
        </span>
      </span>
      {asOf && (
        <span className="ib-st-asof" data-steps-as-of="">
          as of {asOf}
        </span>
      )}
      <span className="ib-st-grow" />
      {children}
    </div>
  );
}

/** Every shown list: one head and its rows each, in the server's order; one list reads "Checklist". */
export function StepsLists({
  lists,
  onWaiting,
  headExtra,
  now,
  heading = false,
}: {
  lists: readonly InboxStepsWire[];
  /** "Waiting on you ›" for a list, or null where there is nowhere to go. */
  onWaiting?: (list: InboxStepsWire) => (() => void) | null;
  /** What sits at the right of the first head (the Board icon, a phone's close). */
  headExtra?: React.ReactNode;
  now?: Date;
  /** Each head's label is a section heading (the opened card). */
  heading?: boolean;
}) {
  return (
    <>
      {lists.map((list, index) => (
        <section key={list.id} className={`ib-st-group ${presenceClass(list.presence)}`} data-steps-group={list.agent.session ?? ''} data-presence={list.presence} aria-label={stepsName(agentName(list.agent), list)}>
          <StepsHead list={list} label={lists.length > 1 ? agentName(list.agent) : 'Checklist'} now={now} heading={heading}>
            {index === 0 ? headExtra : null}
          </StepsHead>
          <StepsList list={list} onWaiting={onWaiting?.(list) ?? null} now={now} />
        </section>
      ))}
    </>
  );
}

/**
 * A session's steps as rows (approval "inbox-checklist-spinners-2026-11-07", Take C with spinners): the mark, the
 * step's words, and its right side (a done step's time, a note, "Dropped: <note>", or "Waiting on you ›"). Weight for
 * the step in progress and the one waiting on the person, muted words for done and dropped. Drawn the same under the
 * line at the top of the thread and in the Board's opened card. Read only: nothing here changes a step.
 */

import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { STEP_STATUS_WORDS, presenceClass, stepMeta, stepsAsOf, stepsCount, stepsListLabels, stepsName } from './model';
import { StepGlyph } from './StepsMarks';

export function StepsList({ list, onWaiting, now }: { list: InboxStepsWire; onWaiting?: (() => void) | null; now?: Date }) {
  return (
    <ul className="ib-sts" data-steps-list="">
      {list.steps.map((step, index) => {
        const meta = stepMeta(step, now);
        return (
          <li key={`${index}:${step.step}`} className="ib-st-row" data-step-status={step.status} aria-label={`${step.step}, ${STEP_STATUS_WORDS[step.status]}${step.note && step.status !== 'done' ? `: ${step.note}` : ''}`}>
            <span className="ib-st-gl">
              <StepGlyph status={step.status} />
            </span>
            {/* An agent's words, in whatever script: the browser finds their direction. Whole here (the line cuts them). */}
            <span className="ib-st-t" dir="auto">
              {step.step}
            </span>
            {meta?.kind === 'time' && (
              <span className="ib-st-m ib-st-time" title={meta.title}>
                {meta.text}
              </span>
            )}
            {meta?.kind === 'note' && (
              <span className="ib-st-m" dir="auto" title={meta.text}>
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
 * A list's head where one is drawn (the Board's opened card, and each list when two sessions keep one): its label,
 * "3 of 6 done", "· as of 2:40 PM" once its session ended, and what the caller adds at the right.
 */
export function StepsHead({
  list,
  label,
  named = false,
  children,
  now,
  headingId,
  heading = false,
}: {
  list: InboxStepsWire;
  label: string;
  /** The label is an agent's name (more than one list), which can be cut. */
  named?: boolean;
  children?: React.ReactNode;
  now?: Date;
  headingId?: string;
  /** The label is a section heading (the opened card's, beside Threads and Links), not plain words. */
  heading?: boolean;
}) {
  const { text } = stepsCount(list);
  const asOf = stepsAsOf(list, now);
  const Label = heading ? 'h3' : 'span';
  return (
    <div className="ib-st-head" data-steps-head="">
      {/* An agent's name (`named`) can be cut: its title has it whole. "Checklist" never is, so it has none. */}
      <Label className="ib-st-lbl" id={headingId} title={named ? label : undefined} dir="auto">
        {label}
      </Label>
      <span className="ib-st-plan" data-steps-count="">
        {text}
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

/**
 * Every shown list, in the server's order. `heads`: `always` draws a head over each list ("Checklist", or each
 * agent's name when there are more); `many` only when there is more than one list (under the thread's line, which is
 * the one list's head).
 */
export function StepsLists({
  lists,
  onWaiting,
  now,
  heading = false,
  heads = 'always',
}: {
  lists: readonly InboxStepsWire[];
  /** "Waiting on you ›" for a list, or null where there is nowhere to go. */
  onWaiting?: (list: InboxStepsWire) => (() => void) | null;
  now?: Date;
  /** Each head's label is a section heading (the opened card). */
  heading?: boolean;
  heads?: 'always' | 'many';
}) {
  // Two sessions of one agent each get a number, so the person can tell the lists apart.
  const labels = stepsListLabels(lists);
  const headed = heads === 'always' || lists.length > 1;
  return (
    <>
      {lists.map((list, index) => (
        <section key={list.id} className={`ib-st-group ${presenceClass(list.presence)}`} data-steps-group={list.agent.session ?? ''} data-presence={list.presence} aria-label={stepsName(labels[index]!, list)}>
          {headed && <StepsHead list={list} label={lists.length > 1 ? labels[index]! : 'Checklist'} named={lists.length > 1} now={now} heading={heading} />}
          <StepsList list={list} onWaiting={onWaiting?.(list) ?? null} now={now} />
        </section>
      ))}
    </>
  );
}

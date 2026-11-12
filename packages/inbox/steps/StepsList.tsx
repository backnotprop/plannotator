import type { InboxStepsWire } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { STEP_STATUS_WORDS, presenceClass, stepMeta, stepsAsOf, stepsCount, stepsListLabels, stepsName } from './model';
import { StepGlyph, StepsPie } from './StepsMarks';

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
  named?: boolean;
  children?: React.ReactNode;
  now?: Date;
  headingId?: string;
  heading?: boolean;
}) {
  const { done, total, text } = stepsCount(list);
  const asOf = stepsAsOf(list, now);
  const Label = heading ? 'h3' : 'span';
  return (
    <div className="ib-st-head" data-steps-head="">
      <Label className="ib-st-lbl" id={headingId} title={named ? label : undefined} dir="auto">
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

export function StepsLists({
  lists,
  onWaiting,
  headExtra,
  now,
  heading = false,
}: {
  lists: readonly InboxStepsWire[];
  onWaiting?: (list: InboxStepsWire) => (() => void) | null;
  headExtra?: React.ReactNode;
  now?: Date;
  heading?: boolean;
}) {
  const labels = stepsListLabels(lists);
  return (
    <>
      {lists.map((list, index) => (
        <section key={list.id} className={`ib-st-group ${presenceClass(list.presence)}`} data-steps-group={list.agent.session ?? ''} data-presence={list.presence} aria-label={stepsName(labels[index]!, list)}>
          <StepsHead list={list} label={lists.length > 1 ? labels[index]! : 'Checklist'} named={lists.length > 1} now={now} heading={heading}>
            {index === 0 ? headExtra : null}
          </StepsHead>
          <StepsList list={list} onWaiting={onWaiting?.(list) ?? null} now={now} />
        </section>
      ))}
    </>
  );
}

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { inboxSnoozeChoices, inboxSnoozeDays, inboxSnoozeFirstPick, inboxSnoozeKeepTime, inboxSnoozeTimes, inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { Icon } from './icons';

export type SnoozeView = 'times' | 'pick';

export interface SnoozeTimesProps {
  view: SnoozeView;
  onView: (view: SnoozeView) => void;
  onBack?: () => void;
  onPick: (until: string) => void;
  onClose: () => void;
}

function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Menu.Item className="ib-pmi ib-zb" label={label} closeOnClick={false} onClick={onBack} data-snooze-back="">
      <Icon name="chevL" size={14} />
      {label}
    </Menu.Item>
  );
}

export function focusAfterSwap(find: () => HTMLElement | null | undefined): () => void {
  find()?.focus({ preventScroll: true });
  const frame = requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
  return () => cancelAnimationFrame(frame);
}

export function SnoozeTimes({ view, onView, onBack, onPick, onClose }: SnoozeTimesProps) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => focusAfterSwap(() => body.current?.querySelector<HTMLElement>(view === 'times' ? '[data-snooze-choice]' : '[role="listbox"]')), [view]);
  const now = useMemo(() => new Date(), []);
  const choices = useMemo(() => inboxSnoozeChoices(now), [now]);
  return (
    <div ref={body} data-snooze-view={view}>
      {view === 'pick' ? (
        <>
          <BackRow label="Pick a time" onBack={() => onView('times')} />
          <SnoozePicker
            now={now}
            onPick={(until) => {
              onPick(until);
              onClose();
            }}
          />
        </>
      ) : (
        <>
          {onBack ? (
            <BackRow label="Snooze until" onBack={onBack} />
          ) : (
            <div className="ib-pm-title" aria-hidden="true" data-snooze-title="">
              Snooze until
            </div>
          )}
          {choices.map((choice) => (
            <Menu.Item key={choice.id} className="ib-pmi ib-zi" label={choice.label} onClick={() => onPick(choice.until)} data-snooze-choice={choice.id}>
              {choice.label}
              <span className="ib-zw">{inboxSnoozeWhen(choice.until, now)}</span>
            </Menu.Item>
          ))}
          <Menu.Separator className="ib-pm-sep" />
          <Menu.Item className="ib-pmi" label="Pick a time" closeOnClick={false} onClick={() => onView('pick')} data-snooze-pick-time="">
            Pick a time…
          </Menu.Item>
        </>
      )}
    </div>
  );
}

function centre(list: HTMLElement | null): void {
  const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (list && option) list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
}

const PAGE_ROWS = 6;

interface PickListProps {
  label: string;
  id: string;
  options: readonly { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  onNeighbour: () => void;
  onDone: () => void;
  centreOn: string;
  children?: ReactNode;
}

function PickList({ label, id, options, value, onChange, onNeighbour, onDone, centreOn }: PickListProps) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => centre(list.current), [centreOn]);
  const at = options.findIndex((option) => option.key === value);
  const move = (index: number) => {
    const option = options[Math.max(0, Math.min(options.length - 1, index))];
    if (!option) return;
    onChange(option.key);
    requestAnimationFrame(() => list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, () => void> = {
      ArrowDown: () => move(at + 1),
      ArrowUp: () => move(at - 1),
      PageDown: () => move(at + PAGE_ROWS),
      PageUp: () => move(at - PAGE_ROWS),
      Home: () => move(0),
      End: () => move(options.length - 1),
      ArrowLeft: onNeighbour,
      ArrowRight: onNeighbour,
      Enter: onDone,
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    step();
  };
  return (
    <div
      ref={list}
      className="ib-zcol"
      role="listbox"
      id={id}
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={at >= 0 ? `${id}-${value}` : undefined}
      data-snooze-list={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        <div
          key={option.key}
          id={`${id}-${option.key}`}
          role="option"
          className="ib-zli"
          aria-selected={option.key === value}
          data-on={option.key === value ? '' : undefined}
          data-snooze-option={option.key}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </div>
      ))}
    </div>
  );
}

export function SnoozePicker({ now, onPick }: { now: Date; onPick: (until: string) => void }) {
  const days = useMemo(() => inboxSnoozeDays(now), [now]);
  const first = useMemo(() => inboxSnoozeFirstPick(now), [now]);
  const [day, setDay] = useState(first.day);
  const [time, setTime] = useState(first.time);
  const times = useMemo(() => inboxSnoozeTimes(day, now), [day, now]);
  const shownTime = inboxSnoozeKeepTime(times, time);
  const root = useRef<HTMLDivElement>(null);
  const uid = useId();
  const until = times.find((entry) => entry.key === shownTime)?.until ?? null;
  const go = () => {
    if (until) onPick(until);
  };
  const cross = (to: string) => () => root.current?.querySelector<HTMLElement>(`[data-snooze-list="${to}"]`)?.focus({ preventScroll: true });
  return (
    <div
      ref={root}
      className="ib-zp"
      data-snooze-picker=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation();
      }}
    >
      <div className="ib-zlists">
        <PickList label="Day" id={`${uid}day`} options={days} value={day} onChange={setDay} onNeighbour={cross('Time')} onDone={go} centreOn="" />
        <PickList label="Time" id={`${uid}time`} options={times} value={shownTime ?? ''} onChange={setTime} onNeighbour={cross('Day')} onDone={go} centreOn={day} />
      </div>
      <div className="ib-zfoot">
        <button type="button" className="ib-zgo" onClick={go} disabled={!until} data-snooze-go="">
          Snooze
        </button>
      </div>
    </div>
  );
}

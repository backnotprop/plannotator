import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { inboxSnoozeChoices, inboxSnoozeDays, inboxSnoozeFirstPick, inboxSnoozeKeepTime, inboxSnoozeTimes, inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { Icon } from './icons';

/**
 * Snooze's times, for a menu that swaps in place (approval "inbox-snooze"):
 * Later today, Tomorrow, In 3 days, Next week, each with its real time on the
 * right, then Pick a time, two scrolling lists of days and half hours. It
 * reads no clock but the browser's, makes no request and writes nothing: the
 * host gets the moment the person picked. The rules are core's inbox-snooze.ts.
 * Draw it inside a Base UI `Menu.Popup` or `ContextMenu.Popup`.
 */
export type SnoozeView = 'times' | 'pick';

export interface SnoozeTimesProps {
  view: SnoozeView;
  onView: (view: SnoozeView) => void;
  /** Back to the menu these times swapped in for. */
  onBack: () => void;
  /** The person picked a moment (ISO, UTC). */
  onPick: (until: string) => void;
  /** Pick a time's Snooze has no menu item to close the menu: the host closes it. */
  onClose: () => void;
}

/** A row that goes back a step: `‹ Snooze until`. */
function BackRow({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Menu.Item className="ib-pmi ib-zb" label={label} closeOnClick={false} onClick={onBack} data-snooze-back="">
      <Icon name="chevL" size={14} />
      {label}
    </Menu.Item>
  );
}

/** The swapped-in list. The menu's own keys move through it; focus starts on its first choice. */
export function SnoozeTimes({ view, onView, onBack, onPick, onClose }: SnoozeTimesProps) {
  const body = useRef<HTMLDivElement>(null);
  // A menu keeps focus on an item that a swap has taken away: the view's first row takes it.
  useLayoutEffect(() => {
    body.current?.querySelector<HTMLElement>(view === 'times' ? '[data-snooze-choice]' : '[role="listbox"]')?.focus({ preventScroll: true });
  }, [view]);
  const now = useMemo(() => new Date(), []);
  const choices = useMemo(() => inboxSnoozeChoices(now), [now]);
  return (
    <div ref={body} className="ib-zview" data-snooze-view={view}>
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
          <BackRow label="Snooze until" onBack={onBack} />
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

/** Places the highlighted option in the middle of its list, as far as the list's ends allow. */
function centre(list: HTMLElement | null): void {
  const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (list && option) list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
}

/** How far PageUp and PageDown move: about the lists' height. */
const PAGE_ROWS = 6;

interface PickListProps {
  label: string;
  id: string;
  options: readonly { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  onNeighbour: () => void;
  onDone: () => void;
  /** Re-centres the list when it changes from outside. */
  centreOn: string;
  children?: ReactNode;
}

/**
 * One scrolling list. A real list: the wheel, a touch and a scrollbar drag
 * move it natively, a click or a tap picks, and with focus on it the arrows,
 * Page Up and Down, Home and End walk it. Left and Right cross to the other
 * list; Enter snoozes.
 */
function PickList({ label, id, options, value, onChange, onNeighbour, onDone, centreOn }: PickListProps) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => centre(list.current), [centreOn]);
  const at = options.findIndex((option) => option.key === value);
  const move = (index: number) => {
    const option = options[Math.max(0, Math.min(options.length - 1, index))];
    if (!option) return;
    onChange(option.key);
    // After the render: the option may be the one just scrolled to.
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

/**
 * Pick a time: a day and a half hour. Today lists only the half hours ahead of
 * `now`, and a day has no half hour the clocks skip. A day that lacks the
 * picked time moves it to the next one on.
 */
export function SnoozePicker({ now, onPick }: { now: Date; onPick: (until: string) => void }) {
  const days = useMemo(() => inboxSnoozeDays(now), [now]);
  const first = useMemo(() => inboxSnoozeFirstPick(now), [now]);
  const [day, setDay] = useState(first.day);
  const [time, setTime] = useState(first.time);
  const times = useMemo(() => inboxSnoozeTimes(day, now), [day, now]);
  const shownTime = inboxSnoozeKeepTime(times, time);
  const root = useRef<HTMLDivElement>(null);
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
      // The lists' keys are theirs: the menu around them would take the arrows and type-ahead, and close on Tab. Escape still closes it.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation();
      }}
    >
      <div className="ib-zlists">
        <PickList label="Day" id="ib-zday" options={days} value={day} onChange={setDay} onNeighbour={cross('Time')} onDone={go} centreOn="" />
        <PickList label="Time" id="ib-ztime" options={times} value={shownTime ?? ''} onChange={setTime} onNeighbour={cross('Day')} onDone={go} centreOn={day} />
      </div>
      <div className="ib-zfoot">
        <button type="button" className="ib-zgo" onClick={go} disabled={!until} data-snooze-go="">
          Snooze
        </button>
      </div>
    </div>
  );
}

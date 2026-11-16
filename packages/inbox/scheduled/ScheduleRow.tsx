/**
 * The editor's one Schedule row: the picker (Hourly, Daily, Weekdays, Weekly, Once, Custom, No schedule), its time,
 * the time zone, and the next run as you edit (from the preview route), with the 15-minute refusal under it.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePhone } from '../phone';
import type { InboxScheduledPreview, InboxScheduledSchedule } from '@plannotator/core/inbox-scheduled-types';
import { Icon } from '../icons';
import { nextRunLine } from './words';

export type ScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once' | 'custom' | 'none';

const KINDS: { id: ScheduleKind; item: string; shown: string }[] = [
  { id: 'hourly', item: 'Hourly', shown: 'Every hour' },
  { id: 'daily', item: 'Daily', shown: 'Every day' },
  { id: 'weekdays', item: 'Weekdays', shown: 'Every weekday' },
  { id: 'weekly', item: 'Weekly', shown: 'Every week' },
  { id: 'once', item: 'Once', shown: 'Once' },
  { id: 'custom', item: 'Custom', shown: 'Custom' },
  { id: 'none', item: 'No schedule', shown: 'No schedule' },
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The parts the row edits, read from a stored schedule. */
export function scheduleParts(schedule: InboxScheduledSchedule) {
  if (!schedule) return { kind: 'none' as ScheduleKind, hour: 9, minute: 0, day: 5, date: '', cron: '' };
  if ('at' in schedule) {
    const [date = '', clock = '17:00'] = schedule.at.split('T');
    const [hour = 17, minute = 0] = clock.split(':').map(Number);
    return { kind: 'once' as ScheduleKind, hour, minute, day: 5, date, cron: '' };
  }
  const m = /^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(schedule.cron.trim());
  const parts = { hour: 9, minute: 0, day: 5, date: '', cron: schedule.cron };
  if (!m) return { kind: 'custom' as ScheduleKind, ...parts };
  const minute = Number(m[1]);
  if (m[2] === '*') return { kind: (m[3] === '*' ? 'hourly' : 'custom') as ScheduleKind, ...parts, minute };
  const hour = Number(m[2]);
  const kind: ScheduleKind = m[3] === '*' ? 'daily' : m[3] === '1-5' ? 'weekdays' : 'weekly';
  return { kind, ...parts, hour, minute, day: m[3] === '*' || m[3] === '1-5' ? 5 : Number(m[3]) };
}

/** A preset picked: its cron (CONTRACT.md: Daily 9:00 AM, Weekly Friday 5:00 PM, Once a date and time). */
export function scheduleOf(kind: ScheduleKind, p: { hour: number; minute: number; day: number; date: string; cron: string }, tz: string): InboxScheduledSchedule {
  switch (kind) {
    case 'none':
      return null;
    case 'hourly':
      return { cron: `${p.minute} * * * *`, tz };
    case 'daily':
      return { cron: `${p.minute} ${p.hour} * * *`, tz };
    case 'weekdays':
      return { cron: `${p.minute} ${p.hour} * * 1-5`, tz };
    case 'weekly':
      return { cron: `${p.minute} ${p.hour} * * ${p.day}`, tz };
    case 'once': {
      const date = p.date || new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      return { at: `${date}T${two(p.hour)}:${two(p.minute)}`, tz };
    }
    case 'custom':
      return { cron: p.cron || `${p.minute} ${p.hour} * * *`, tz };
  }
}

function KindMenu({ kind, onKind }: { kind: ScheduleKind; onKind: (kind: ScheduleKind) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  // On a phone, main's bottom sheet (inbox.css `.ib-pm-pos[data-phone]`): it fits the screen and scrolls.
  const sheet = usePhone();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const shown = KINDS.find((k) => k.id === kind)!;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={anchor} className="st-pick" aria-label={`Schedule: ${shown.shown}. Change`} data-schedule-kind={kind}>
        {shown.shown}
        <Icon name="chevD" size={12} />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {sheet && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={sheet ? '' : undefined}>
          <Menu.Popup className="ib-pm st-kinds" aria-label="Schedule">
            <Menu.RadioGroup value={kind} onValueChange={(next: ScheduleKind) => next !== kind && onKind(next)}>
              {KINDS.map((k) => (
                <div key={k.id} role="presentation">
                  {k.id === 'none' && <Menu.Separator className="ib-pm-sep" />}
                  <Menu.RadioItem value={k.id} closeOnClick className="ib-pmi" label={k.item} data-schedule-option={k.id}>
                    <span className="ib-pmi-l">{k.item}</span>
                    {k.id === kind && <Icon name="check" size={15} className="ib-pmi-check" />}
                  </Menu.RadioItem>
                </div>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const timeValue = (hour: number, minute: number) => `${two(hour)}:${two(minute)}`;

export function ScheduleRow({ schedule, preview, onChange }: { schedule: InboxScheduledSchedule; preview: InboxScheduledPreview | null; onChange: (next: InboxScheduledSchedule) => void }) {
  const read = scheduleParts(schedule);
  // Custom stays picked while its cron happens to read as a preset ("0 9 * * *"): the person is typing a cron.
  const [custom, setCustom] = useState(false);
  const parts = custom && schedule && 'cron' in schedule ? { ...read, kind: 'custom' as ScheduleKind } : read;
  const tz = schedule?.tz ?? localZone();
  const [cron, setCron] = useState(parts.cron);
  const set = (change: Partial<typeof parts>, kind = parts.kind) => onChange(scheduleOf(kind, { ...parts, ...change }, tz));
  const onTime = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    if (Number.isFinite(hour) && Number.isFinite(minute)) set({ hour: hour!, minute: minute! });
  };
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [tz];
  const refused = preview?.refused ?? null;
  const time = <input type="time" className="st-pick st-time" aria-label="Time" value={timeValue(parts.hour, parts.minute)} onChange={(event) => onTime(event.target.value)} />;
  return (
    <>
      <div className="st-sched" aria-invalid={refused ? true : undefined} aria-describedby={refused ? 'st-sched-err' : undefined} data-schedule-row="">
        <Icon name="clock" />
        <KindMenu
          kind={parts.kind}
          onKind={(kind) => {
            // Custom starts from the schedule as it is now, not the cron the row opened with.
            const typed = schedule && 'cron' in schedule ? schedule.cron : cron || scheduleCron(schedule);
            setCustom(kind === 'custom');
            if (kind === 'custom') setCron(typed);
            set(kind === 'custom' ? { cron: typed } : {}, kind);
          }}
        />
        {parts.kind === 'hourly' && (
          <>
            <span className="st-w">at</span>
            <select className="st-pick" aria-label="Minute" value={parts.minute} onChange={(event) => set({ minute: Number(event.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={m}>
                  :{two(m)}
                </option>
              ))}
            </select>
          </>
        )}
        {parts.kind === 'weekly' && (
          <>
            <span className="st-w">on</span>
            <select className="st-pick" aria-label="Day" value={parts.day} onChange={(event) => set({ day: Number(event.target.value) })}>
              {WEEKDAYS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </>
        )}
        {parts.kind === 'once' && (
          <>
            <span className="st-w">on</span>
            <input type="date" className="st-pick" aria-label="Date" value={parts.date} onChange={(event) => event.target.value && set({ date: event.target.value })} />
          </>
        )}
        {(parts.kind === 'daily' || parts.kind === 'weekdays' || parts.kind === 'weekly' || parts.kind === 'once') && (
          <>
            <span className="st-w">at</span>
            {time}
          </>
        )}
        {parts.kind === 'custom' && (
          <input
            className="st-pick st-cron"
            aria-label="Cron"
            spellCheck={false}
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            onBlur={() => cron.trim() && cron.trim() !== parts.cron && set({ cron: cron.trim() })}
            onKeyDown={(event) => event.key === 'Enter' && cron.trim() && set({ cron: cron.trim() })}
          />
        )}
        {parts.kind === 'none' ? (
          <span className="st-w">Runs when you run it.</span>
        ) : (
          <label className="st-tz">
            <span>{preview?.tz_short ?? tz}</span>
            <select aria-label="Time zone" value={tz} onChange={(event) => schedule && onChange({ ...schedule, tz: event.target.value })}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        )}
        {preview?.ok && preview.next_run && (
          <span className="st-next" data-schedule-next="">
            {nextRunLine(preview.next_run, schedule, preview.tz_short)}
          </span>
        )}
      </div>
      {refused ? (
        <p className="st-err" id="st-sched-err" role="alert" data-schedule-refused={refused.code}>
          {refused.error}
        </p>
      ) : (
        parts.kind === 'custom' && preview?.ok && <p className="st-echo">{preview.schedule_words}</p>
      )}
    </>
  );
}

const scheduleCron = (schedule: InboxScheduledSchedule) => (schedule && 'cron' in schedule ? schedule.cron : '0 9 * * *');

/**
 * New message's To on a phone (approval "inbox-phone-composer-picker"): the sheet the pill in the bottom row opens.
 * A computer keeps ToPicker.tsx; the rows, their order and the filter are the same rules (`compose/model.ts`).
 *
 * - Running sessions, each by its own title (issue #2450) with "<agent> · <project> · <time>" under it; a session
 *   with no title is its agent. A check on the one To names.
 * - Launch on, or two or more machines (approval "inbox-launcher-machine-switch"): "Running", then "Start new" with one
 *   row per agent kind ("Claude Code", "in kiln-render"); with two or more machines, chips that wrap choose the machine.
 * - The filter on top takes no focus when the sheet opens, so the keyboard stays down and the list has the screen;
 *   a tap on it raises the keyboard and the sheet sits above it. ↓ ↑ and Enter work from it, as in ToPicker.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { BottomSheet } from '../components/BottomSheet';
import { SheetRow } from '../components/SheetRow';
import { whenTime } from '../format';
import { Icon } from '../icons';
import { busyWord, hostLabel, type ComposeGroup, type ComposeStart, type ComposeTarget } from './model';
import { MachineChips } from './MachineSwitch';
import { asleepSince, HERE, inParts, pickable, toItemOn, toItems, type ToItem, type ToMachine } from './toMachines';

export function PhoneToSheet({
  open,
  groups,
  selected,
  onPick,
  onClose,
  start,
  onStart,
  host,
  machines,
  opensOn,
}: {
  open: boolean;
  groups: readonly ComposeGroup[];
  /** The session To names, or a start row's key (`toStartKey`). */
  selected: string | null;
  /** `machine`: the linked machine the session is on; null for this computer. */
  onPick: (target: ComposeTarget, machine: string | null) => void;
  onClose: () => void;
  /** Launch on: the agents To offers to start and where. Absent: sessions only. */
  start?: { launch: InboxComposeLaunch; current: { id: string | null; root: string | null } | null } | null;
  onStart?: (start: ComposeStart) => void;
  /** The compose dialog: the sheet is drawn in it (a modal dialog is the top layer). */
  host: HTMLElement | null;
  /** Every machine To can reach, as ToPicker takes them. */
  machines?: readonly ToMachine[];
  /** The machine the chips open on. */
  opensOn?: string;
}) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(opensOn ?? HERE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Each opening starts with no filter, on the machine To's pick is on.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setChosen(opensOn ?? HERE);
    setExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const all = useMemo<readonly ToMachine[]>(
    () => machines ?? [{ key: HERE, machine: null, name: '', self: true, asleep: false, since: null, home: null, groups, launch: start ? { agents: start.launch.agents, projects: start.launch.projects } : null, notice: null }],
    [machines, groups, start],
  );
  const typing = query.trim() !== '';
  const parts = inParts(all);
  const items = useMemo(() => toItems({ machines: all, chosen, query, expanded, current: start?.current ?? null }), [all, chosen, query, expanded, start?.current]);
  const options = useMemo(() => items.filter(pickable), [items]);
  // The highlight follows a row's key (the list is read again every 5 s). Null: none, until typing or an arrow key.
  const [hlKey, setHlKey] = useState<string | null>(null);
  const found = options.findIndex((o) => o.key === hlKey);
  const hl = hlKey === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlKey(options[index]?.key ?? null);
  useLayoutEffect(() => {
    setHlKey(query === '' ? null : (options[0]?.key ?? null));
    // Only the filter, the chips and an opening move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, chosen]);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-to-o-${uid}-${i}`;
  useLayoutEffect(() => {
    if (hl >= 0) document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  const pick = (option: ToItem | undefined) => {
    if (option?.type === 'start') onStart?.(option.start);
    else if (option?.type === 'session') onPick(option.row.target, option.machine.machine);
    else if (option?.type === 'more') setExpanded((had) => new Set([...had, option.machine.key]));
  };
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      setHl(hl < 0 ? 0 : (hl + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(hl >= 0 ? options[hl] : undefined);
    }
  };
  const indexOf = new Map(options.map((o, i) => [o.key, i]));

  return (
    <BottomSheet open={open} onClose={onClose} title="To" host={host} attrs={{ 'data-compose-to-sheet': '' }}>
      <div className="ib-sheet-body" onKeyDown={onKey}>
        <label className="ib-sheet-filter">
          <Icon name="search" size={18} />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={`ib-to-list-${uid}`}
            aria-activedescendant={hl >= 0 && options[hl] ? optionId(hl) : undefined}
            aria-label="Find an agent or project"
            placeholder="Find an agent or project"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {all.length > 1 && !typing && <MachineChips machines={all} chosen={chosen} onChoose={setChosen} />}
        <div className="ib-sheet-list" role="listbox" id={`ib-to-list-${uid}`} aria-label="Live agent sessions">
          {items.length === 0 && <div className="ib-sheet-none">{typing && parts ? `Nothing matches “${query.trim()}”` : 'No live session matches.'}</div>}
          {items.map((item) => {
            const i = indexOf.get(item.key) ?? -1;
            if (item.type === 'cap') {
              return (
                <div key={item.key} className="ib-sheet-cap" aria-hidden="true" data-compose-cap={item.key.split(':')[1]}>
                  {item.words}
                </div>
              );
            }
            if (item.type === 'head') {
              const m = item.machine;
              return (
                <div key={item.key} className="ib-sheet-cap ib-cp-mhd" aria-hidden="true" data-compose-machine-head={m.key}>
                  <Icon name={m.asleep ? 'moon' : 'laptop'} size={14} />
                  <bdi>{m.name}</bdi>
                  {(m.self || m.asleep) && <span>· {m.self ? 'this computer' : asleepSince(m)}</span>}
                </div>
              );
            }
            if (item.type === 'notice') {
              return (
                <div key={item.key} className="ib-sheet-none" data-compose-start-notice="">
                  {item.words}
                </div>
              );
            }
            if (item.type === 'missing') {
              return <SheetRow key={item.key} host={item.agent} title={item.name} disabled end={<span className="ib-cp-stend">Not on {item.machine.name}</span>} attrs={{ 'data-compose-start-missing': item.agent }} />;
            }
            if (item.type === 'more') {
              return (
                <SheetRow
                  key={item.key}
                  id={optionId(i)}
                  lead={<Icon name="chevD" size={16} />}
                  title={`${item.count} more running`}
                  quiet
                  highlighted={i === hl}
                  attrs={{ 'data-compose-more-running': item.machine.key }}
                  onClick={() => pick(item)}
                />
              );
            }
            const on = toItemOn(item, selected, typing);
            const check = on && <Icon name="check" size={18} className="ib-sheet-check" />;
            if (item.type === 'start') {
              const s = item.start;
              const m = item.machine;
              return (
                <SheetRow
                  key={item.key}
                  id={optionId(i)}
                  host={s.agent}
                  title={s.name}
                  detail={`in ${s.project.name}`}
                  selected={on}
                  highlighted={i === hl}
                  end={check || (m.asleep ? <span className="ib-cp-stend">starts when it's back</span> : null)}
                  ariaLabel={`New ${s.name} session in ${s.project.name}${m.machine ? `, on ${m.name}` : ''}`}
                  attrs={{ 'data-compose-start': s.agent, 'data-compose-start-machine': m.key, 'data-compose-start-project': s.project.name }}
                  onClick={() => pick(item)}
                />
              );
            }
            const { target } = item.row;
            const agent = hostLabel(target.host);
            const time = target.started_at ? whenTime(target.started_at) : null;
            const asleep = item.machine.asleep;
            return (
              <SheetRow
                key={item.key}
                id={i >= 0 ? optionId(i) : undefined}
                host={target.host}
                agent={target.session}
                // A session with a title leads with it and names its agent under it; one without is its agent.
                title={target.label ?? agent}
                detail={[target.label ? agent : null, target.project.name, time].filter(Boolean).join(' · ')}
                selected={on}
                highlighted={i >= 0 && i === hl}
                // An asleep machine's agents can't take a message now: shown, as the sidebar shows them, not picked.
                disabled={asleep}
                end={check || (parts ? <span className="ib-cp-stend" data-compose-state="">{asleep ? 'asleep' : busyWord(target)}</span> : null)}
                ariaLabel={`${agent}${target.label ? `, ${target.label},` : ''} in ${target.project.name}${time ? `, started ${time}` : ''}`}
                attrs={{ 'data-compose-session': target.session, 'data-compose-project': target.project.name, 'data-compose-session-machine': item.machine.key, 'data-session-label': target.label ? '' : undefined }}
                onClick={() => pick(item)}
              />
            );
          })}
        </div>
      </div>
    </BottomSheet>
  );
}

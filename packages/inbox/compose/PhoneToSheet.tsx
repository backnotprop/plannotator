/**
 * New message's To on a phone (approval "inbox-phone-composer-picker"): the sheet the pill in the bottom row opens.
 * A computer keeps ToPicker.tsx; the rows, their order and the filter are the same rules (`compose/model.ts`).
 *
 * - Running sessions, each by its own title (issue #2450) with "<agent> · <project> · <time>" under it; a session
 *   with no title is its agent. A check on the one To names.
 * - A hairline, then "Start a new session in <folder>" with one row per agent the Inbox can start (Launch on).
 * - The filter on top takes no focus when the sheet opens, so the keyboard stays down and the list has the screen;
 *   a tap on it raises the keyboard and the sheet sits above it. ↓ ↑ and Enter work from it, as in ToPicker.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { BottomSheet } from '../components/BottomSheet';
import { SheetLine, SheetRow } from '../components/SheetRow';
import { whenTime } from '../format';
import { Icon } from '../icons';
import { filterGroups, hostLabel, pickerRows, startBlock, type ComposeGroup, type ComposeStart, type ComposeTarget, type MachineLaunchProject } from './model';
import { startKey } from './ToPicker';

type Option = { key: string; target: ComposeTarget; start?: undefined } | { key: string; start: ComposeStart; target?: undefined };

export function PhoneToSheet({
  open,
  groups,
  selected,
  onPick,
  onClose,
  start,
  onStart,
  host,
}: {
  open: boolean;
  groups: readonly ComposeGroup[];
  /** The session To names, or `start:<agent>` for a start. */
  selected: string | null;
  onPick: (target: ComposeTarget) => void;
  onClose: () => void;
  /** Launch on: the agents To offers to start and where. Absent: sessions only. */
  start?: { launch: InboxComposeLaunch; current: { id: string | null; root: string | null } | null } | null;
  onStart?: (start: ComposeStart) => void;
  /** The compose dialog: the sheet is drawn in it (a modal dialog is the top layer). */
  host: HTMLElement | null;
}) {
  const [query, setQuery] = useState('');
  // Each opening starts with no filter.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const rows = useMemo(() => pickerRows(shown, groups), [shown, groups]);
  const block = useMemo(() => (start ? startBlock(start.launch, start.current, query) : null), [start, query]);
  const options = useMemo<Option[]>(
    () => [
      ...rows.map((row) => ({ key: row.target.session, target: row.target })),
      ...(block ? block.agents.map((a) => ({ key: startKey(a.agent), start: { agent: a.agent, name: a.name, project: block.project } })) : []),
    ],
    [rows, block],
  );
  // The highlight follows a row's key (the list is read again every 5 s). Null: none, until typing or an arrow key.
  const [hlKey, setHlKey] = useState<string | null>(null);
  const found = options.findIndex((o) => o.key === hlKey);
  const hl = hlKey === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlKey(options[index]?.key ?? null);
  useLayoutEffect(() => {
    setHlKey(query === '' ? null : (options[0]?.key ?? null));
    // Only the filter and an opening move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-to-o-${uid}-${i}`;
  useLayoutEffect(() => {
    if (hl >= 0) document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  const pick = (option: Option | undefined) => {
    if (option?.start) onStart?.(option.start);
    else if (option?.target) onPick(option.target);
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
        <div className="ib-sheet-list" role="listbox" id={`ib-to-list-${uid}`} aria-label="Live agent sessions">
          {options.length === 0 && <div className="ib-sheet-none">No live session matches.</div>}
          {options.map((option, i) => {
            const on = option.key === selected;
            const check = on && <Icon name="check" size={18} className="ib-sheet-check" />;
            if (option.start) {
              const s = option.start;
              const machine = (s.project as MachineLaunchProject).machine_name;
              return (
                <div key={option.key} className="ib-sheet-group">
                  {i === rows.length && (
                    <>
                      {rows.length > 0 && <SheetLine />}
                      <div className="ib-sheet-cap" aria-hidden="true" data-compose-start-caption="">
                        Start a new session in <b dir="auto">{s.project.name}</b>
                        {machine ? <> · {machine}</> : null}
                      </div>
                    </>
                  )}
                  <SheetRow
                    id={optionId(i)}
                    host={s.agent}
                    title={s.name}
                    detail="New session"
                    selected={on}
                    highlighted={i === hl}
                    end={check}
                    ariaLabel={`New ${s.name} session in ${s.project.name}${machine ? `, on ${machine}` : ''}`}
                    attrs={{ 'data-compose-start': s.agent }}
                    onClick={() => pick(option)}
                  />
                </div>
              );
            }
            const { target } = option;
            const agent = hostLabel(target.host);
            const time = target.started_at ? whenTime(target.started_at) : null;
            return (
              <SheetRow
                key={option.key}
                id={optionId(i)}
                host={target.host}
                // A session with a title leads with it and names its agent under it; one without is its agent.
                title={target.label ?? agent}
                detail={[target.label ? agent : null, target.project.name, time].filter(Boolean).join(' · ')}
                selected={on}
                highlighted={i === hl}
                end={check}
                ariaLabel={`${agent}${target.label ? `, ${target.label},` : ''} in ${target.project.name}${time ? `, started ${time}` : ''}`}
                attrs={{ 'data-compose-session': target.session, 'data-compose-project': target.project.name, 'data-session-label': target.label ? '' : undefined }}
                onClick={() => pick(option)}
              />
            );
          })}
        </div>
      </div>
    </BottomSheet>
  );
}

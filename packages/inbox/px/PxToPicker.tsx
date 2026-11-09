/**
 * PROTOTYPE ONLY (branch proto/composer-picker; never merged): New message's To, as the one picker. Running sessions
 * by their title with "Claude Code · project · time" under it, a hairline, then "Start a new session in <project>"
 * with one row per agent the Inbox can start. Under a chosen new Claude Code session, Model and Effort (a switch of
 * the prototype): they show here and in the pill, and do NOT change what is launched.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { filterGroups, hostLabel, pickerRows, startBlock, type ComposeGroup, type ComposeStart, type ComposeTarget, type MachineLaunchProject } from '../compose/model';
import { startKey } from '../compose/ToPicker';
import { PxCheck, PxRow, PxSurface, pxTime } from './PxPicker';

export const PX_MODELS = [
  { id: 'opus', name: 'Opus 5.5' },
  { id: 'sonnet', name: 'Sonnet 5' },
  { id: 'haiku', name: 'Haiku 4.5' },
  { id: 'default', name: 'Claude Code’s default' },
] as const;
export const PX_EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max'] as const;
export type PxModelId = (typeof PX_MODELS)[number]['id'];
export type PxEffort = (typeof PX_EFFORTS)[number];
export interface PxLaunchChoice {
  model: PxModelId;
  effort: PxEffort;
}
const CHOICE_KEY = 'ib-px-launch-choice';
export function readPxLaunchChoice(): PxLaunchChoice {
  try {
    const v = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') as Partial<PxLaunchChoice>;
    return { model: PX_MODELS.some((m) => m.id === v.model) ? v.model! : 'opus', effort: PX_EFFORTS.includes(v.effort as PxEffort) ? v.effort! : 'High' };
  } catch {
    return { model: 'opus', effort: 'High' };
  }
}
export function savePxLaunchChoice(choice: PxLaunchChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {}
}
/** What the pill says for a new session: "Opus 5.5" and a quiet "High". */
export function pxLaunchWords(choice: PxLaunchChoice): { label: string; detail: string } {
  const model = PX_MODELS.find((m) => m.id === choice.model)!;
  return { label: choice.model === 'default' ? 'Claude Code' : model.name, detail: choice.effort };
}
/** Whether the prototype offers Model and Effort for this agent (Claude Code only: the others have no such setting to show). */
export const pxHasLaunchChoice = (agent: string): boolean => agent === 'claude-code';

type Option = { key: string; target: ComposeTarget; start?: undefined } | { key: string; start: ComposeStart; target?: undefined };

export function PxToPicker({
  open,
  groups,
  selected,
  phone,
  onPick,
  onClose,
  start,
  onStart,
  anchor,
  host,
  showLaunchChoice,
  choice,
  onChoice,
}: {
  open: boolean;
  groups: readonly ComposeGroup[];
  /** The session To names, or `start:<agent>` for a start. */
  selected: string | null;
  phone: boolean;
  onPick: (target: ComposeTarget) => void;
  onClose: () => void;
  start?: { launch: InboxComposeLaunch; current: { id: string | null; root: string | null } | null } | null;
  /** `stay`: the row has Model and Effort under it, so the list stays open on it. */
  onStart?: (start: ComposeStart, stay: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  host: HTMLElement | null;
  showLaunchChoice: boolean;
  choice: PxLaunchChoice;
  onChoice: (choice: PxLaunchChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<'list' | 'model'>('list');
  // Each opening starts on the list with no filter.
  useEffect(() => {
    if (open) {
      setQuery('');
      setPage('list');
    }
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
  const [hlKey, setHlKey] = useState<string | null>(null);
  const found = options.findIndex((o) => o.key === hlKey);
  const hl = hlKey === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlKey(options[index]?.key ?? null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-px-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = (option: Option | undefined) => {
    if (option?.start) onStart?.(option.start, showLaunchChoice && pxHasLaunchChoice(option.start.agent));
    else if (option?.target) onPick(option.target);
  };
  useLayoutEffect(() => {
    const at = options.findIndex((o) => o.key === selected);
    if (query === '') setHlKey(at >= 0 ? options[at]!.key : null);
    else setHl(0);
    // Only the filter and an opening move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);
  // A computer types to filter at once. A phone keeps its keyboard down until the filter is tapped, so the list has the room.
  useEffect(() => {
    if (open && !phone && page === 'list') inputRef.current?.focus();
  }, [open, phone, page]);
  useLayoutEffect(() => {
    if (hl >= 0) document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || page !== 'list') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      if (hl < 0) return setHl(0);
      setHl((hl + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(hl >= 0 ? options[hl] : undefined);
    }
  };

  const model = PX_MODELS.find((m) => m.id === choice.model)!;
  return (
    <PxSurface
      open={open}
      phone={phone}
      title={page === 'model' ? 'Model' : 'To'}
      back={page === 'model' ? { label: 'To', onBack: () => setPage('list') } : null}
      onClose={onClose}
      anchor={anchor}
      host={host}
      label={page === 'model' ? 'Model' : 'To'}
      attrs={{ 'data-px-to-picker': '', 'data-px-page': page }}
    >
      {page === 'model' ? (
        <div className="ib-px-list" role="listbox" aria-label="Model" data-px-models="">
          {PX_MODELS.map((m) => (
            <PxRow
              key={m.id}
              phone={phone}
              lead={null}
              title={m.name}
              selected={m.id === choice.model}
              highlighted={m.id === choice.model}
              end={<PxCheck on={m.id === choice.model} />}
              attrs={{ 'data-px-model': m.id, 'data-px-bare': '' }}
              onClick={() => {
                onChoice({ ...choice, model: m.id });
                setPage('list');
              }}
            />
          ))}
        </div>
      ) : (
        <div className="ib-px-body" onKeyDown={onKey}>
          <label className="ib-px-filter">
            <Icon name="search" size={phone ? 18 : 14} />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={`ib-px-list-${uid}`}
              aria-activedescendant={hl >= 0 && options[hl] ? optionId(hl) : undefined}
              aria-label="Find an agent or project"
              placeholder="Find an agent or project"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ib-px-list" role="listbox" id={`ib-px-list-${uid}`} aria-label="Agents">
            {options.length === 0 && <div className="ib-px-none">No running session matches.</div>}
            {options.map((option, i) => {
              if (option.start) {
                const s = option.start;
                const on = option.key === selected;
                const machine = (s.project as MachineLaunchProject).machine_name;
                return (
                  <div key={option.key} className="ib-px-startrow">
                    {i === rows.length && (
                      <>
                        {rows.length > 0 && <div className="ib-px-sep" aria-hidden="true" />}
                        <div className="ib-px-cap" aria-hidden="true" data-compose-start-caption="">
                          Start a new session in <b dir="auto">{s.project.name}</b>
                          {machine ? <> · {machine}</> : null}
                        </div>
                      </>
                    )}
                    <PxRow
                      id={optionId(i)}
                      phone={phone}
                      host={s.agent}
                      title={s.name}
                      detail="New session"
                      selected={on}
                      highlighted={i === hl || on}
                      end={<PxCheck on={on} />}
                      ariaLabel={`New ${s.name} session in ${s.project.name}`}
                      attrs={{ 'data-compose-start': s.agent }}
                      onHover={() => i !== hl && setHl(i)}
                      onClick={() => pick(option)}
                    />
                    {on && showLaunchChoice && pxHasLaunchChoice(s.agent) && (
                      <div className="ib-px-lset" data-px-launch-choice="">
                        <button type="button" className="ib-px-lrow" data-px-model-row="" onClick={() => setPage('model')}>
                          <span className="ib-px-lk">Model</span>
                          <span className="ib-px-lv">{model.name}</span>
                          <Icon name="chevR" size={phone ? 18 : 14} className="ib-px-lc" />
                        </button>
                        <div className="ib-px-lrow ib-px-segrow">
                          <span className="ib-px-lk" id={`ib-px-eff-${uid}`}>
                            Effort
                          </span>
                          <div className="ib-px-seg" role="radiogroup" aria-labelledby={`ib-px-eff-${uid}`}>
                            {PX_EFFORTS.map((effort) => (
                              <button key={effort} type="button" role="radio" aria-checked={effort === choice.effort} data-on={effort === choice.effort ? '' : undefined} data-px-effort={effort} onClick={() => onChoice({ ...choice, effort })}>
                                {effort}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              const { target } = option;
              const on = target.session === selected;
              const agent = hostLabel(target.host);
              const time = pxTime(target.last_thread?.at ?? target.started_at);
              // A session with a title leads with it and names its agent under it; one without is its agent.
              const detail = [target.label ? agent : null, target.project.name, time].filter(Boolean).join(' · ');
              return (
                <PxRow
                  key={target.session}
                  id={optionId(i)}
                  phone={phone}
                  host={target.host}
                  title={target.label ?? agent}
                  detail={detail}
                  selected={on}
                  highlighted={i === hl || on}
                  end={<PxCheck on={on} />}
                  ariaLabel={`${agent}${target.label ? `, ${target.label},` : ''} in ${target.project.name}`}
                  attrs={{ 'data-compose-session': target.session, 'data-compose-project': target.project.name }}
                  onHover={() => i !== hl && setHl(i)}
                  onClick={() => pick(option)}
                />
              );
            })}
          </div>
        </div>
      )}
    </PxSurface>
  );
}

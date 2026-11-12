import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HostMark, Icon } from '../icons';
import { isTextCut, ProjectTipText, Tip } from '../components/Tip';
import { tildePath } from '../format';
import { splitPath } from '../agents';
import type { InboxComposeLaunch, InboxLaunchAgent } from '@plannotator/core/inbox-types';
import { filterGroups, hostLabel, pickerRows, splitProjectName, startBlock, type ComposeGroup, type ComposeStart, type ComposeTarget, type MachineLaunchProject } from './model';

type PickerOption = { key: string; target: ComposeTarget; started: string | null; start?: undefined } | { key: string; start: ComposeStart; target?: undefined };

export function ToPicker({
  groups,
  selected,
  home,
  phone,
  onPick,
  onClose,
  start,
  onStart,
}: {
  groups: readonly ComposeGroup[];
  selected: string | null;
  home: string | null;
  phone: boolean;
  onPick: (target: ComposeTarget) => void;
  onClose: () => void;
  start?: { launch: InboxComposeLaunch; current: { id: string | null; root: string | null } | null } | null;
  onStart?: (start: ComposeStart) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const rows = useMemo(() => pickerRows(shown, groups), [shown, groups]);
  const block = useMemo(() => (start ? startBlock(start.launch, start.current, query) : null), [start, query]);
  const options = useMemo<PickerOption[]>(
    () => [
      ...rows.map((row) => ({ key: row.target.session, target: row.target, started: row.started })),
      ...(block ? block.agents.map((a) => ({ key: startKey(a.agent), start: { agent: a.agent, name: a.name, project: block.project } })) : []),
    ],
    [rows, block],
  );
  const [hlSession, setHlSession] = useState<string | null>(null);
  const found = options.findIndex((o) => o.key === hlSession);
  const hl = hlSession === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlSession(options[index]?.key ?? null);
  const pick = (option: PickerOption | undefined) => {
    if (option?.start) onStart?.(option.start);
    else if (option?.target) onPick(option.target);
  };
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const at = options.findIndex((o) => o.key === selected);
    if (query === '') setHlSession(at >= 0 ? options[at]!.key : null);
    else setHl(0);
  }, [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
  }, [hl]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('[data-compose-to]')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      if (hl < 0) {
        setHl(0);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHl((hl + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(hl >= 0 ? options[hl] : undefined);
    }
  };

  return (
    <div className="ib-cp-picker" ref={ref} data-compose-picker="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onClose}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>To</span>
        </div>
      )}
      <div className="ib-cp-filter">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-cp-list-${uid}`}
          aria-activedescendant={hl >= 0 && options[hl] ? optionId(hl) : undefined}
          aria-label="Find an agent or project"
          placeholder="Find an agent or project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        className="ib-cp-list"
        role="listbox"
        id={`ib-cp-list-${uid}`}
        aria-label="Live agent sessions"
        data-session-labels={rows.some((row) => row.target.label) ? '' : undefined}
      >
        {options.length === 0 && <div className="ib-cp-none">No live session matches.</div>}
        {options.map((option, i) => {
          if (option.start) {
            const s = option.start;
            return (
              <Fragment key={option.key}>
                {i === rows.length && (
                  <div className={`ib-cp-cap${rows.length ? ' ib-cp-cap-line' : ''}`} aria-hidden="true" data-compose-start-caption="">
                    Start a new session in <b dir="auto">{s.project.name}</b>
                    {(s.project as MachineLaunchProject).machine_name ? <> · {(s.project as MachineLaunchProject).machine_name}</> : null}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === hl}
                  aria-label={`New ${s.name} session in ${s.project.name}${(s.project as MachineLaunchProject).machine_name ? `, on ${(s.project as MachineLaunchProject).machine_name}` : `, ${tildePath(s.project.root, home)}`}`}
                  className={`ib-cp-opt ib-cp-start${i === hl ? ' ib-hl' : ''}`}
                  data-compose-start={s.agent}
                  onPointerMove={() => i !== hl && setHl(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                >
                  <HostMark host={s.agent} />
                  <b className="ib-cp-oa">{s.name}</b>
                  <span className="ib-cp-ons">New session</span>
                  <span className="ib-cp-check" aria-hidden="true">
                    {option.key === selected && <Icon name="check" size={15} />}
                  </span>
                </div>
              </Fragment>
            );
          }
          const { target, started } = option;
          const folder = tildePath(target.project.root, home);
          return (
            <div
              key={target.session}
              id={optionId(i)}
              role="option"
              aria-selected={i === hl}
              aria-label={`${hostLabel(target.host)}${target.label ? `, ${target.label},` : ''} in ${target.project.name}, ${folder}${started ? `, started ${started}` : ''}`}
              className={`ib-cp-opt${i === hl ? ' ib-hl' : ''}`}
              data-compose-session={target.session}
              data-compose-project={target.project.name}
              onPointerMove={() => i !== hl && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option)}
            >
              <HostMark host={target.host} agent={target.session} />
              <b className="ib-cp-oa">{hostLabel(target.host)}</b>
              {target.label ? (
                <Tip content={target.label} cut>
                  <span className="ib-cp-op" dir="auto" data-session-label="">
                    <bdi className="ib-cp-ol">{target.label}</bdi>
                    {phone && <span className="ib-cp-olp">{` · ${target.project.name}`}</span>}
                  </span>
                </Tip>
              ) : (
                <span className="ib-cp-op" dir="auto">
                  {target.project.name}
                </span>
              )}
              <FolderPath path={folder} />
              <Tip content={started ? `Started ${started}` : null}>
                <span className="ib-cp-os" data-compose-started={started ?? undefined}>
                  {started ? `· ${started}` : null}
                </span>
              </Tip>
              <span className="ib-cp-check" aria-hidden="true">
                {target.session === selected && <Icon name="check" size={15} />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const startKey = (agent: InboxLaunchAgent): string => `start:${agent}`;

export function SessionDetail({ name, root, suffix, label }: { name: string; root: string | null; suffix?: string; label?: string }) {
  const { folder, parents } = label ? { folder: label, parents: name } : splitProjectName(name);
  const whole = label ? `${label} · ${name}` : name;
  return (
    <Tip content={root ? <ProjectTipText name={whole} root={root} /> : whole} when={detailCut}>
      <span className="ib-cp-tod" data-compose-detail="">
        <span className="ib-cp-tdsep">{'· '}</span>
        <span className="ib-cp-tdw">
          <bdi className="ib-cp-tdf" data-cut="">
            {folder}
          </bdi>
          {parents && (
            <span className="ib-cp-tdp" data-cut="">
              {' · '}
              <bdi>{parents}</bdi>
            </span>
          )}
        </span>
        {suffix && <span className="ib-cp-tdsuf">{` · ${suffix}`}</span>}
      </span>
    </Tip>
  );
}

function detailCut(trigger: Element): boolean {
  const bottom = (trigger.querySelector('.ib-cp-tdw') ?? trigger).getBoundingClientRect().bottom;
  return [...trigger.querySelectorAll('[data-cut]')].some((part) => isTextCut(part) || part.getBoundingClientRect().top >= bottom - 1);
}

export function FolderPath({ path, drive }: { path: string; drive?: { name: string; folders: readonly string[] } | null }) {
  if (drive) {
    const last = drive.folders[drive.folders.length - 1];
    const middle = drive.folders.slice(0, -1);
    const SEP = '\u00a0›\u00a0';
    return (
      <Tip content={path} when={(trigger) => isTextCut(trigger.querySelector('.ib-cp-ofh')) || isTextCut(trigger.querySelector('.ib-cp-oft')) || isTextCut(trigger)}>
        <span className="ib-cp-of" dir="ltr" data-folder-drive-path="">
          <span className="ib-cp-ofd">
            <bdi>{drive.name}</bdi>
          </span>
          {middle.length > 0 && (
            <span className="ib-cp-ofh">
              {middle.map((name, index) => (
                <Fragment key={index}>
                  {SEP}
                  <bdi>{name}</bdi>
                </Fragment>
              ))}
            </span>
          )}
          {last !== undefined && (
            <span className="ib-cp-oft">
              {SEP}
              <bdi>{last}</bdi>
            </span>
          )}
        </span>
      </Tip>
    );
  }
  const split = splitPath(path);
  const moveSlash = split.head.endsWith('/') && split.head.length > 1;
  const head = moveSlash ? split.head.slice(0, -1) : split.head;
  const tail = moveSlash ? `/${split.tail}` : split.tail;
  const segments = (part: string) =>
    part.split('/').map((name, index, all) => (
      <Fragment key={index}>
        {name && <bdi>{name}</bdi>}
        {index < all.length - 1 && '/'}
      </Fragment>
    ));
  return (
    <Tip content={path} when={(trigger) => isTextCut(trigger.querySelector('.ib-cp-ofh')) || isTextCut(trigger.querySelector('.ib-cp-oft')) || isTextCut(trigger)}>
      <span className="ib-cp-of" dir="ltr">
        <span className="ib-cp-ofh">{segments(head)}</span>
        <span className="ib-cp-oft">{segments(tail)}</span>
      </span>
    </Tip>
  );
}

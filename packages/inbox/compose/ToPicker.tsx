import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HostMark, Icon } from '../icons';
import { isTextCut, ProjectTipText, Tip } from '../components/Tip';
import { tildePath } from '../format';
import { splitPath } from '../agents';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { busyWord, hostLabel, splitProjectName, type ComposeGroup, type ComposeStart, type ComposeTarget } from './model';
import { MachineSwitch } from './MachineSwitch';
import { asleepSince, HERE, inParts, pickable, toItemOn, toItems, type ToItem, type ToMachine } from './toMachines';

/**
 * The To picker (compose; approval "inbox-compose-to-picker"): a filter field
 * over one listbox of live sessions, one line each: the agent's mark and
 * name, the project, its folder (muted, cut in the middle), a check on the
 * chosen one. On a phone two lines each (inbox.css): the project's whole name
 * goes under the agent, since To there has room for only part of it. A start
 * time shows only where one project has two or more live sessions. The current project first, then the most recently active.
 * ↓ ↑ move a wrapping highlight, Enter picks, Escape closes the picker only
 * (the dialog stays), typing filters by host, label, project and last subject.
 * A session with a label (approval "inbox-session-label") shows it in the
 * project's place, with the project after it on a phone.
 * With nobody in To it opens with no row highlighted, so Enter picks nothing
 * (the first row is the session last sent to: one Enter must not bring back
 * the auto-fill compose dropped); typing or an arrow key highlights the first row.
 * Focus stays in the filter (`aria-activedescendant`).
 *
 * Launch on (`start`), or `machines` (approval "inbox-launcher-machine-switch", `toMachines.ts`): "Running" then
 * "Start new", one row per agent kind ("+ Claude Code in kiln-render"); with two or more machines a switch on top
 * shows one machine at a time, each running row ends in its state, and typing looks across every machine.
 */
export function ToPicker({
  groups,
  selected,
  home,
  phone,
  onPick,
  onClose,
  start,
  onStart,
  machines,
  opensOn,
}: {
  groups: readonly ComposeGroup[];
  /** The session To names, or a start row's key (`toStartKey`). */
  selected: string | null;
  home: string | null;
  phone: boolean;
  /** `machine`: the linked machine the session is on; null for this computer. */
  onPick: (target: ComposeTarget, machine: string | null) => void;
  onClose: () => void;
  /** Launch on: the agents To offers to start and where (`GET /api/inbox/sessions` `launch`). Absent: sessions only, as always. */
  start?: { launch: InboxComposeLaunch; current: { id: string | null; root: string | null } | null } | null;
  onStart?: (start: ComposeStart) => void;
  /** Every machine To can reach (compose): `groups` and `start` then only give the current project. Absent: this computer's `groups` and `start`. */
  machines?: readonly ToMachine[];
  /** The machine the switch opens on (the one To's pick is on). */
  opensOn?: string;
}) {
  const [query, setQuery] = useState('');
  const all = useMemo<readonly ToMachine[]>(
    () => machines ?? [{ key: HERE, machine: null, name: '', self: true, asleep: false, since: null, home, groups, launch: start ? { agents: start.launch.agents, projects: start.launch.projects } : null, notice: null }],
    [machines, groups, start, home],
  );
  const [chosen, setChosen] = useState(opensOn ?? HERE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const typing = query.trim() !== '';
  const many = all.length > 1;
  const items = useMemo(() => toItems({ machines: all, chosen, query, expanded, current: start?.current ?? null }), [all, chosen, query, expanded, start?.current]);
  const options = useMemo(() => items.filter(pickable), [items]);
  // Parts and states at the row's end only where something can start or there is a switch: the Board's New card keeps its plain rows.
  const parts = inParts(all);
  // The highlight follows a row's key, not its number: the list is read again
  // every 5 s, and a re-read that moves rows must not move the highlight.
  // `null`: no row highlighted (-1), only while To is empty and nothing was typed or arrowed.
  const [hlKey, setHlKey] = useState<string | null>(null);
  const found = options.findIndex((o) => o.key === hlKey);
  const hl = hlKey === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlKey(options[index]?.key ?? null);
  const pick = (option: ToItem | undefined) => {
    if (option?.type === 'start') onStart?.(option.start);
    else if (option?.type === 'session') onPick(option.row.target, option.machine.machine);
    else if (option?.type === 'more') setExpanded((had) => new Set([...had, option.machine.key]));
  };
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The highlight starts on the row To names, else on no row (To empty); a filter snaps it to the first row, and
  // another machine starts with none.
  useLayoutEffect(() => {
    const at = options.find((o) => toItemOn(o, selected, typing));
    if (query === '') setHlKey(at ? at.key : null);
    else setHl(0);
    // Only the filter and the switch move it; the re-read keeps the row it is on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, chosen]);
  useEffect(() => inputRef.current?.focus(), []);
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  // A press outside closes it (the To button toggles it itself).
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
      // The picker only: the dialog's own Escape never sees this one.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      // Nothing highlighted yet: either arrow lands on the first row.
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
      // Nothing highlighted: Enter picks nothing.
      pick(hl >= 0 ? options[hl] : undefined);
    }
  };

  const optionIndex = new Map(options.map((o, i) => [o.key, i]));
  const rowProps = (item: ToItem) => {
    const i = optionIndex.get(item.key) ?? -1;
    return {
      id: i >= 0 ? optionId(i) : undefined,
      role: 'option' as const,
      'aria-selected': i >= 0 && i === hl,
      onPointerMove: () => i >= 0 && i !== hl && setHl(i),
      onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
      onClick: () => pick(item),
      hl: i >= 0 && i === hl,
    };
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
      {/* Typing looks across every machine: the switch steps aside. */}
      {many && !typing && <MachineSwitch machines={all} chosen={chosen} onChoose={setChosen} />}
      <div
        className="ib-cp-list"
        role="listbox"
        id={`ib-cp-list-${uid}`}
        aria-label="Live agent sessions"
        data-session-labels={items.some((item) => item.type === 'session' && item.row.target.label) ? '' : undefined}
      >
        {items.length === 0 && <div className="ib-cp-none">{typing && parts ? `Nothing matches “${query.trim()}”` : 'No live session matches.'}</div>}
        {items.map((item) => {
          if (item.type === 'cap') {
            return (
              <div key={item.key} className="ib-cp-cap" aria-hidden="true" data-compose-cap={item.key.split(':')[1]}>
                {item.words}
              </div>
            );
          }
          if (item.type === 'head') {
            const m = item.machine;
            return (
              <div key={item.key} className="ib-cp-mhd" aria-hidden="true" data-compose-machine-head={m.key}>
                <Icon name={m.asleep ? 'moon' : 'laptop'} size={14} />
                <bdi>{m.name}</bdi>
                {(m.self || m.asleep) && <span>· {m.self ? 'this computer' : asleepSince(m)}</span>}
              </div>
            );
          }
          if (item.type === 'notice') {
            return (
              <div key={item.key} className="ib-cp-opt ib-cp-fnotice" aria-disabled="true" data-compose-start-notice="">
                <Icon name="info" size={15} />
                <span className="ib-cp-op">{item.words}</span>
              </div>
            );
          }
          if (item.type === 'missing') {
            return (
              <div key={item.key} className="ib-cp-opt ib-cp-st" role="option" aria-selected={false} aria-disabled="true" data-compose-start-missing={item.agent}>
                <span className="ib-cp-plus" aria-hidden="true">
                  <Icon name="plus" size={12} />
                </span>
                <span className="ib-cp-stk">{item.name}</span>
                <span className="ib-cp-stend">Not on {item.machine.name}</span>
              </div>
            );
          }
          if (item.type === 'more') {
            const { hl: on, ...props } = rowProps(item);
            return (
              <div key={item.key} {...props} className={`ib-cp-opt ib-cp-st ib-cp-more${on ? ' ib-hl' : ''}`} data-compose-more-running={item.machine.key}>
                {item.count} more running
              </div>
            );
          }
          if (item.type === 'start') {
            const s = item.start;
            const { hl: on, ...props } = rowProps(item);
            const m = item.machine;
            return (
              <div
                key={item.key}
                {...props}
                aria-label={`New ${s.name} session in ${s.project.name}${m.machine ? `, on ${m.name}` : `, ${tildePath(s.project.root, m.home)}`}`}
                className={`ib-cp-opt ib-cp-st ib-cp-start${on ? ' ib-hl' : ''}`}
                data-compose-start={s.agent}
                data-compose-start-machine={m.key}
                data-compose-start-project={s.project.name}
              >
                <span className="ib-cp-plus" aria-hidden="true">
                  <Icon name="plus" size={12} />
                </span>
                <HostMark host={s.agent} />
                <span className="ib-cp-stk">{s.name}</span>
                <span className="ib-cp-stin" dir="auto">
                  in {s.project.name}
                </span>
                {m.asleep && !toItemOn(item, selected, typing) && <span className="ib-cp-stend">starts when it's back</span>}
                <span className="ib-cp-check" aria-hidden="true">
                  {toItemOn(item, selected, typing) && <Icon name="check" size={15} />}
                </span>
              </div>
            );
          }
          const { target, started } = item.row;
          const folder = tildePath(target.project.root, item.machine.home);
          const { hl: on, ...props } = rowProps(item);
          const chosenRow = toItemOn(item, selected, typing);
          // An asleep machine's agents can't take a message now: shown, as the sidebar shows them, not picked.
          const asleep = item.machine.asleep;
          return (
            <div
              key={item.key}
              {...(asleep ? { role: 'option' as const, 'aria-selected': false, 'aria-disabled': 'true' as const } : props)}
              aria-label={`${hostLabel(target.host)}${target.label ? `, ${target.label},` : ''} in ${target.project.name}, ${folder}${started ? `, started ${started}` : ''}`}
              className={`ib-cp-opt${on ? ' ib-hl' : ''}`}
              data-compose-session={target.session}
              data-compose-project={target.project.name}
              data-compose-session-machine={item.machine.key}
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
              <span className="ib-cp-check" aria-hidden="true" data-compose-state={parts && !chosenRow ? '' : undefined}>
                {chosenRow ? <Icon name="check" size={15} /> : parts ? (asleep ? 'asleep' : busyWord(target)) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * To's detail after the agent's name, always one line: "· main · workspaces/worktrees".
 * The folder's own name stays whole while it fits; the parents (`splitProjectName`)
 * give way first, cut with "…", and drop out entirely once only a sliver of them
 * would show (they wrap onto a line the box hides); a folder name too long for
 * the row is then cut with its own "…". The whole name and folder in a tooltip while
 * anything is cut; on a phone the picker shows it whole. A session's `label` leads
 * and stays whole in the folder's place, and the project gives way as the parents
 * do ("· Fix login redirect · ai-collab"); a " · " inside the label splits nothing.
 */
export function SessionDetail({ name, root, suffix, label }: { name: string; root: string | null; suffix?: string; label?: string }) {
  const { folder, parents } = label ? { folder: label, parents: name } : splitProjectName(name);
  const whole = label ? `${label} · ${name}` : name;
  return (
    <Tip content={root ? <ProjectTipText name={whole} root={root} /> : whole} when={detailCut}>
      <span className="ib-cp-tod" data-compose-detail="">
        {/* The spaces read in the text (copy, `textContent`); the gaps draw them. */}
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

/** Whether any part of To's detail is cut or dropped (wrapped below the one line the box shows). */
function detailCut(trigger: Element): boolean {
  const bottom = (trigger.querySelector('.ib-cp-tdw') ?? trigger).getBoundingClientRect().bottom;
  return [...trigger.querySelectorAll('[data-cut]')].some((part) => isTextCut(part) || part.getBoundingClientRect().top >= bottom - 1);
}

/** A project folder on one line, cut in the middle: the leading folders shrink with "…", the last name stays; the whole path in a tooltip while it is cut. */
export function FolderPath({ path, drive }: { path: string; drive?: { name: string; folders: readonly string[] } | null }) {
  if (drive) {
    // A folder on a drive: "Studio SSD › footage-tools". The drive's name and the last folder stay whole; the folders
    // between are cut first.
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
  // The slash before the last name stays with it, so a cut reads "~/pando/proj…/main".
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

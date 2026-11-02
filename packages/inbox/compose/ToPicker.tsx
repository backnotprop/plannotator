import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HostMark, Icon } from '../icons';
import { isTextCut, ProjectTipText, Tip } from '../components/Tip';
import { tildePath } from '../format';
import { splitPath } from '../agents';
import { filterGroups, hostLabel, pickerRows, splitProjectName, type ComposeGroup, type ComposeTarget } from './model';

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
 */
export function ToPicker({
  groups,
  selected,
  home,
  phone,
  onPick,
  onClose,
}: {
  groups: readonly ComposeGroup[];
  selected: string | null;
  home: string | null;
  phone: boolean;
  onPick: (target: ComposeTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const rows = useMemo(() => pickerRows(shown, groups), [shown, groups]);
  const options = useMemo(() => rows.map((row) => row.target), [rows]);
  // The highlight follows a session, not a row number: the list is read again
  // every 5 s, and a re-read that moves rows must not move the highlight.
  // `null`: no row highlighted (-1), only while To is empty and nothing was typed or arrowed.
  const [hlSession, setHlSession] = useState<string | null>(null);
  const found = options.findIndex((t) => t.session === hlSession);
  const hl = hlSession === null ? -1 : found >= 0 ? found : 0;
  const setHl = (index: number) => setHlSession(options[index]?.session ?? null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The highlight starts on the session To names, else on no row (To empty); a filter snaps it to the first row.
  useLayoutEffect(() => {
    const at = options.findIndex((t) => t.session === selected);
    if (query === '') setHlSession(at >= 0 ? options[at]!.session : null);
    else setHl(0);
    // Only the filter moves it; the re-read keeps the session it is on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
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
      const target = hl >= 0 ? options[hl] : undefined;
      if (target) onPick(target);
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
        {rows.length === 0 && <div className="ib-cp-none">No live session matches.</div>}
        {rows.map(({ target, started }, i) => {
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
              onClick={() => onPick(target)}
            >
              <HostMark host={target.host} />
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
function FolderPath({ path }: { path: string }) {
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

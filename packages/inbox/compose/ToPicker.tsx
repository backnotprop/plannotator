import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { HostMark, Icon } from '../icons';
import { tildePath } from '../format';
import { busyWord, filterGroups, hostLabel, lastLine, sessionTitle, type ComposeGroup, type ComposeTarget } from './model';

/**
 * The To picker (compose): a filter field over one listbox of live sessions,
 * grouped by project with the current project first. ↓ ↑ move a wrapping
 * highlight, Enter picks, Escape closes the picker only (the dialog stays),
 * typing filters by host, project and last subject. Focus stays in the
 * filter (`aria-activedescendant`).
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
  const options = useMemo(() => shown.flatMap((group) => group.sessions), [shown]);
  const [hl, setHl] = useState(0);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-o-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The highlight starts on the session To names, else the first row; a new filter snaps it to the first row.
  useLayoutEffect(() => {
    const at = options.findIndex((t) => t.session === selected);
    setHl(query === '' && at >= 0 ? at : 0);
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
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHl((current) => (current + step + options.length) % options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = options[hl];
      if (target) onPick(target);
    }
  };

  let index = -1;
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
          aria-activedescendant={options[hl] ? optionId(hl) : undefined}
          aria-label="Find an agent or project"
          placeholder="Find an agent or project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-list-${uid}`} aria-label="Live agent sessions">
        {shown.length === 0 && <div className="ib-cp-none">No live session matches.</div>}
        {shown.map((group) => {
          const headingId = `ib-cp-g-${uid}-${group.project.root.replace(/[^A-Za-z0-9]/g, '')}`;
          return (
            <div key={group.project.root} role="group" aria-labelledby={headingId} className="ib-cp-group" data-compose-group={group.project.name}>
              <div className="ib-cp-gh" id={headingId}>
                <b dir="auto">{group.project.name}</b>
                <span className="ib-cp-path" dir="auto">
                  {tildePath(group.project.root, home)}
                </span>
                {group.current && <span className="ib-cp-cur">current</span>}
                <span className="ib-sr">{group.current ? ', current project' : ''}</span>
              </div>
              {group.sessions.map((target) => {
                index += 1;
                const i = index;
                const isSelected = target.session === selected;
                return (
                  <div
                    key={target.session}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === hl}
                    aria-label={`${hostLabel(target.host)}, ${sessionTitle(target).split(' · ')[1]}, ${busyWord(target).toLowerCase()}, ${lastLine(target)}`}
                    className={`ib-cp-opt${i === hl ? ' ib-hl' : ''}`}
                    data-compose-session={target.session}
                    onPointerMove={() => i !== hl && setHl(i)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(target)}
                  >
                    <HostMark host={target.host} />
                    <span className="ib-cp-ot">
                      <span className="ib-cp-o1">
                        <b>{hostLabel(target.host)}</b> · {sessionTitle(target).split(' · ')[1]}
                      </span>
                      <span className="ib-cp-o2" dir="auto">
                        {lastLine(target)}
                      </span>
                    </span>
                    <span className={`ib-cp-busy${target.busy ? ' ib-on' : ''}`}>{busyWord(target)}</span>
                    <span className="ib-cp-check" aria-hidden="true">
                      {isSelected && <Icon name="check" size={15} />}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="ib-cp-pickfoot">Live Claude Code, Pi and OpenCode sessions with Plannotator.</div>
    </div>
  );
}

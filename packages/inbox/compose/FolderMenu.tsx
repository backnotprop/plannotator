import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../icons';
import { tildePath } from '../format';
import { FolderPath } from './ToPicker';
import { filterLaunchProjects, type LaunchProject } from './model';

/**
 * The folder menu (launch, UX screen 03): where a new session starts, picked
 * from the Inbox's own projects (the most recently active first, ✓ on the
 * one To names), so a typo can never start an agent in the wrong folder.
 * The To picker's look and keys: a filter, ↓ ↑ and Enter, Escape closes the
 * menu only. A project whose folder is gone is listed struck through, and
 * picking it gets compose's folder-missing note (screen 13).
 */
export function FolderMenu({
  projects,
  selected,
  home,
  phone,
  onPick,
  onClose,
}: {
  projects: readonly LaunchProject[];
  selected: string | null;
  home: string | null;
  phone: boolean;
  onPick: (project: LaunchProject) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => filterLaunchProjects(projects, query), [projects, query]);
  const [hlId, setHlId] = useState<string | null>(selected);
  const found = options.findIndex((p) => p.id === hlId);
  const hl = options.length === 0 ? -1 : found >= 0 ? found : 0;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-f-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (query !== '') setHlId(options[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('[data-compose-folder]')) onClose();
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
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHlId(options[(hl + step + options.length) % options.length]!.id);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const project = hl >= 0 ? options[hl] : undefined;
      if (project) onPick(project);
    }
  };

  return (
    <div className="ib-cp-picker ib-cp-folders" ref={ref} data-compose-folders="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onClose}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>Start in</span>
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
          aria-controls={`ib-cp-flist-${uid}`}
          aria-activedescendant={hl >= 0 ? optionId(hl) : undefined}
          aria-label="Find a project"
          placeholder="Find a project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-flist-${uid}`} aria-label="Projects">
        {options.length === 0 && <div className="ib-cp-none">No project matches.</div>}
        {options.map((project, i) => {
          const folder = tildePath(project.root, home);
          return (
            <div
              key={project.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === hl}
              aria-label={`${project.name}, ${folder}${project.exists ? '' : ', not there any more'}`}
              className={`ib-cp-opt ib-cp-fopt${i === hl ? ' ib-hl' : ''}`}
              data-compose-folder-option={project.id}
              data-missing={project.exists ? undefined : ''}
              onPointerMove={() => i !== hl && setHlId(project.id)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(project)}
            >
              <Icon name="folder" size={15} />
              {project.exists ? (
                <span className="ib-cp-op" dir="auto">
                  {project.name}
                </span>
              ) : (
                <s className="ib-cp-op" dir="auto">
                  {project.name}
                </s>
              )}
              <FolderPath path={folder} />
              <span className="ib-cp-check" aria-hidden="true">
                {project.id === selected && <Icon name="check" size={15} />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

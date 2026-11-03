import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from '../icons';
import { tildePath } from '../format';
import { FolderPath } from './ToPicker';
import { filterLaunchProjects, scratchMatches, SCRATCH_PICK, type LaunchProject } from './model';

/**
 * The folder menu (launch, UX screen 03): where a new session starts, picked
 * from the Inbox's own projects (the most recently active first, ✓ on the
 * one To names), so a typo can never start an agent in the wrong folder.
 * The To picker's look and keys: a filter, ↓ ↑ and Enter, Escape closes the
 * menu only. A project whose folder is gone is listed struck through, and
 * picking it gets compose's folder-missing note (screen 13).
 *
 * Last, under a line: "New scratch folder" and the folder a Send would make
 * (`<root>/<thread-name slug>`). While the agent does not trust the root yet
 * and no press of Trust and start can (a guest, a root at home) it reads "New
 * scratch folder · trust it once", shows the root, and says under it that the
 * first start asks to trust the root once: that start fails as untrusted, and
 * its run line trusts the root (Trust folder, or Open in Terminal), so one
 * trust covers every scratch folder after it.
 */
export function FolderMenu({
  projects,
  selected,
  home,
  phone,
  onPick,
  scratch,
  onScratch,
  onClose,
}: {
  projects: readonly LaunchProject[];
  selected: string | null;
  home: string | null;
  phone: boolean;
  onPick: (project: LaunchProject) => void;
  /**
   * "New scratch folder": the folder a Send would make and its root (`~/…`), whether the agent (`agentName`)
   * trusts the root already, else the row names the root and says how the first start asks for it. Null: no row.
   */
  scratch?: { folder: string; root: string; trusted: boolean; agentName: string } | null;
  onScratch?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => filterLaunchProjects(projects, query), [projects, query]);
  const scratchShown = !!scratch && !!onScratch && scratchMatches(query);
  // The keys walk the projects, then the scratch row.
  const ids = useMemo(() => [...options.map((p) => p.id), ...(scratchShown ? [SCRATCH_PICK] : [])], [options, scratchShown]);
  const [hlId, setHlId] = useState<string | null>(selected);
  const found = ids.indexOf(hlId ?? '');
  const hl = ids.length === 0 ? -1 : found >= 0 ? found : 0;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-f-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (query !== '') setHlId(ids[0] ?? null);
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
      if (ids.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHlId(ids[(hl + step + ids.length) % ids.length]!);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (hl >= 0 && ids[hl] === SCRATCH_PICK) onScratch?.();
      else if (hl >= 0 && options[hl]) onPick(options[hl]);
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
        {options.length === 0 && !scratchShown && <div className="ib-cp-none">No project matches.</div>}
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
        {scratchShown && scratch && (
          <>
            {options.length > 0 && <div className="ib-cp-cap-line" role="presentation" />}
            <div
              id={optionId(options.length)}
              role="option"
              aria-selected={hl === options.length}
              aria-label={scratch.trusted ? `New scratch folder, ${scratch.folder}` : `New scratch folder in ${scratch.root}. ${untrustedHint(scratch)}`}
              className={`ib-cp-opt ib-cp-fopt ib-cp-scratch${hl === options.length ? ' ib-hl' : ''}`}
              data-compose-folder-option={SCRATCH_PICK}
              data-untrusted={scratch.trusted ? undefined : ''}
              onPointerMove={() => hl !== options.length && setHlId(SCRATCH_PICK)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onScratch?.()}
            >
              <Icon name="folderPlus" size={15} />
              <span className="ib-cp-op">
                New scratch folder
                {!scratch.trusted && <span className="ib-cp-trust"> · trust it once</span>}
              </span>
              <FolderPath path={scratch.trusted ? scratch.folder : scratch.root} />
              <span className="ib-cp-check" aria-hidden="true">
                {selected === SCRATCH_PICK && <Icon name="check" size={15} />}
              </span>
            </div>
            {!scratch.trusted && (
              <div className="ib-cp-scratch-hint" aria-hidden="true" data-compose-scratch-hint="">
                {untrustedHint(scratch)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Under an untrusted "New scratch folder" row: what "trust it once" asks of the person. */
function untrustedHint(scratch: { root: string; agentName: string }): string {
  return `${scratch.agentName} doesn't trust ${scratch.root} yet. Your first Send asks you to trust it once; after that every scratch folder there starts.`;
}

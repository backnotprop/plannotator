import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
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
 *
 * Linked machines (remote launch, the picker's A): `groups` lists the projects
 * by machine, each under its machine's caption ("MacBook · this computer",
 * "Mac mini · asleep"), the machine the person started an agent on last first,
 * a project on several machines under each. A group's own scratch row ends it.
 * A machine where the agent can't start shows one disabled line, with its
 * command to copy when there is one. The filter matches a project's name or
 * path, or the machine's name; the keys walk every row of every group.
 */
/** "New scratch folder" in one place: the folder a Send would make, its root, and whether the agent trusts the root. */
export interface ScratchRow {
  folder: string;
  root: string;
  trusted: boolean;
  agentName: string;
}

/** One machine's group (remote launch). */
export interface FolderGroup {
  /** The machine's id, or null for this computer. */
  machine: string | null;
  name: string;
  /** After the name in the caption: "this computer", "asleep". */
  quiet: string | null;
  home: string | null;
  projects: readonly LaunchProject[];
  /** The project the person last started an agent in there: "· you started it here last". */
  last: string | null;
  scratch: ScratchRow | null;
  /** The agent can't start there: one disabled line instead of its projects. */
  notice: { line: string; command: string | null } | null;
}

type Row =
  | { key: string; kind: 'project'; project: LaunchProject; group: FolderGroup }
  | { key: string; kind: 'scratch'; scratch: ScratchRow; group: FolderGroup };

const rowKey = (machine: string | null, id: string) => `${machine ?? ''}:${id}`;

export function FolderMenu({
  projects,
  selected,
  selectedMachine = null,
  home,
  phone,
  onPick,
  scratch,
  onScratch,
  onClose,
  groups,
}: {
  projects: readonly LaunchProject[];
  selected: string | null;
  /** The machine of the project To names (null: this computer). */
  selectedMachine?: string | null;
  home: string | null;
  phone: boolean;
  onPick: (project: LaunchProject, machine: string | null) => void;
  /**
   * "New scratch folder": the folder a Send would make and its root (`~/…`), whether the agent (`agentName`)
   * trusts the root already, else the row names the root and says how the first start asks for it. Null: no row.
   */
  scratch?: ScratchRow | null;
  onScratch?: (machine: string | null) => void;
  onClose: () => void;
  /** Linked machines: the projects grouped by machine, each with its caption. Absent or null: one list, as always. */
  groups?: readonly FolderGroup[] | null;
}) {
  const [query, setQuery] = useState('');
  const grouped = !!groups;
  // Without linked machines: one group with no caption, so the menu is exactly what it was.
  const all = useMemo<readonly FolderGroup[]>(
    () => groups ?? [{ machine: null, name: '', quiet: null, home, projects, last: null, scratch: scratch && onScratch ? scratch : null, notice: null }],
    [groups, home, projects, scratch, onScratch],
  );
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .map((group) => {
        // A machine's name picks its whole group ("mini").
        const named = grouped && words.length > 0 && words.every((w) => group.name.toLowerCase().includes(w));
        return {
          group,
          projects: named ? [...group.projects] : filterLaunchProjects(group.projects, query),
          scratch: group.scratch && (named || scratchMatches(query)) ? group.scratch : null,
          notice: group.notice && (named || words.length === 0) ? group.notice : null,
        };
      })
      .filter((g) => g.projects.length > 0 || g.scratch || g.notice);
  }, [all, grouped, query]);
  const rows = useMemo<Row[]>(
    () =>
      shown.flatMap((g) => [
        ...g.projects.map((project) => ({ key: rowKey(g.group.machine, project.id), kind: 'project' as const, project, group: g.group })),
        ...(g.scratch ? [{ key: rowKey(g.group.machine, SCRATCH_PICK), kind: 'scratch' as const, scratch: g.scratch, group: g.group }] : []),
      ]),
    [shown],
  );
  // The keys walk the projects, then the scratch row, group after group.
  const ids = useMemo(() => rows.map((row) => row.key), [rows]);
  const [hlId, setHlId] = useState<string | null>(selected ? rowKey(selectedMachine, selected) : null);
  const found = ids.indexOf(hlId ?? '');
  const hl = ids.length === 0 ? -1 : found >= 0 ? found : 0;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-f-${uid}-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);

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

  const choose = (row: Row) => (row.kind === 'scratch' ? onScratch?.(row.group.machine) : onPick(row.project, row.group.machine));

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
      // The copy button of a machine's line takes its own Enter.
      if ((event.target as Element).closest?.('[data-compose-folder-copy]')) return;
      event.preventDefault();
      if (hl >= 0 && rows[hl]) choose(rows[hl]);
    }
  };

  const copy = async (command: string, key: string) => {
    const ok = await copyTextToClipboard(command);
    setCopied(ok ? key : null);
    if (ok) setTimeout(() => setCopied((was) => (was === key ? null : was)), 1500);
  };

  let at = 0;
  return (
    <div className="ib-cp-picker ib-cp-folders" ref={ref} data-compose-folders="" data-grouped={grouped ? '' : undefined} data-phone={phone ? '' : undefined} onKeyDown={onKey}>
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
        {rows.length === 0 && !shown.some((g) => g.notice) && <div className="ib-cp-none">No project matches.</div>}
        {shown.map((g, gi) => {
          const group = g.group;
          const gHome = grouped ? group.home : home;
          const on = grouped ? `${group.name}${group.quiet ? `, ${group.quiet}` : ''}` : null;
          return (
            <Fragment key={group.machine ?? ''}>
              {grouped && (
                <div className={`ib-cp-cap${gi > 0 ? ' ib-cp-cap-line' : ''}`} aria-hidden="true" data-compose-folder-group={group.machine ?? 'self'}>
                  <b dir="auto">{group.name}</b>
                  {group.quiet ? ` · ${group.quiet}` : ''}
                </div>
              )}
              {g.notice && (
                <div className="ib-cp-opt ib-cp-fopt ib-cp-fnotice" role="option" aria-selected={false} aria-disabled="true" data-compose-folder-notice={group.machine ?? 'self'}>
                  <Icon name="info" size={15} />
                  <span className="ib-cp-op">{g.notice.line}</span>
                  {g.notice.command && (
                    <button
                      type="button"
                      className="ib-lnk ib-cp-fcopy"
                      aria-label={`Copy the command to run on ${group.name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void copy(g.notice!.command!, group.machine ?? '')}
                      data-compose-folder-copy=""
                    >
                      {copied === (group.machine ?? '') ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              )}
              {g.projects.map((project) => {
                const i = at++;
                const folder = tildePath(project.root, gHome);
                const last = grouped && project.id === group.last;
                return (
                  <div
                    key={project.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === hl}
                    aria-label={`${project.name}${last ? ', you started it here last' : ''}, ${folder}${on ? `, on ${on}` : ''}${project.exists ? '' : ', not there any more'}`}
                    className={`ib-cp-opt ib-cp-fopt${i === hl ? ' ib-hl' : ''}`}
                    data-compose-folder-option={project.id}
                    data-compose-folder-machine={group.machine ?? undefined}
                    data-missing={project.exists ? undefined : ''}
                    onPointerMove={() => i !== hl && setHlId(rowKey(group.machine, project.id))}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(project, group.machine)}
                  >
                    <Icon name="folder" size={15} />
                    {project.exists ? (
                      <span className="ib-cp-op" dir="auto">
                        {project.name}
                        {last && <span className="ib-cp-trust"> · you started it here last</span>}
                      </span>
                    ) : (
                      <s className="ib-cp-op" dir="auto">
                        {project.name}
                      </s>
                    )}
                    <FolderPath path={folder} />
                    <span className="ib-cp-check" aria-hidden="true">
                      {project.id === selected && group.machine === selectedMachine && <Icon name="check" size={15} />}
                    </span>
                  </div>
                );
              })}
              {g.scratch &&
                (() => {
                  const i = at++;
                  const s = g.scratch;
                  return (
                    <>
                      {!grouped && g.projects.length > 0 && <div className="ib-cp-cap-line" role="presentation" />}
                      <div
                        id={optionId(i)}
                        role="option"
                        aria-selected={hl === i}
                        aria-label={`${s.trusted ? `New scratch folder, ${s.folder}` : `New scratch folder in ${s.root}. ${untrustedHint(s)}`}${on ? `, on ${on}` : ''}`}
                        className={`ib-cp-opt ib-cp-fopt ib-cp-scratch${hl === i ? ' ib-hl' : ''}`}
                        data-compose-folder-option={SCRATCH_PICK}
                        data-compose-folder-machine={group.machine ?? undefined}
                        data-untrusted={s.trusted ? undefined : ''}
                        onPointerMove={() => hl !== i && setHlId(rowKey(group.machine, SCRATCH_PICK))}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onScratch?.(group.machine)}
                      >
                        <Icon name="folderPlus" size={15} />
                        <span className="ib-cp-op">
                          New scratch folder
                          {!s.trusted && <span className="ib-cp-trust"> · trust it once</span>}
                        </span>
                        <FolderPath path={s.trusted ? s.folder : s.root} />
                        <span className="ib-cp-check" aria-hidden="true">
                          {selected === SCRATCH_PICK && group.machine === selectedMachine && <Icon name="check" size={15} />}
                        </span>
                      </div>
                      {!s.trusted && (
                        <div className="ib-cp-scratch-hint" aria-hidden="true" data-compose-scratch-hint="">
                          {untrustedHint(s)}
                        </div>
                      )}
                    </>
                  );
                })()}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Under an untrusted "New scratch folder" row: what "trust it once" asks of the person. */
function untrustedHint(scratch: { root: string; agentName: string }): string {
  return `${scratch.agentName} doesn't trust ${scratch.root} yet. Your first Send asks you to trust it once; after that every scratch folder there starts.`;
}

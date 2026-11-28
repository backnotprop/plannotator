/**
 * "On this computer"'s + (approval "reviews-open-any-branch-a", pictures A1-A9; addendum "Another folder…"): open any
 * branch or worktree folder as a review. The Inbox's own picker (New message's folder menu look, `.ib-cp-picker`, a
 * full-screen sheet on a phone): pick a project (skipped when there is one), then a worktree folder or a branch, browsed
 * or found by typing. A folder is titled with the branch checked out in it, its own name quiet (on no branch: its name,
 * its short commit quiet); a branch is its name. Each says its commits not on the default branch, or "uncommitted", or
 * "same as main" (dimmed, still opened), and its age. Last, "Another folder…": New message's folder opener
 * (compose/HomeFolderBrowser.tsx) as it is, its folder opened as a review like any other row. The picker's keys only
 * (↑ ↓ Enter, Escape closes); no new shortcut.
 */
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { inboxLocalFolderQuiet, inboxLocalSameAsBase, inboxLocalWorkKey, inboxLocalWorkLabel, type InboxLocalRefProjectsAnswer, type InboxLocalRefsAnswer, type InboxLocalWork } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { HomeFolderBrowser } from '../compose/HomeFolderBrowser';
import { relativeWords } from '../relativeTime';
import { reviewAge } from './reviewRowParts';
import { readLocalRefProjects, readLocalRefs } from './localWork';
import type { LocalOpen } from './localRoute';

export interface OpenLocalProps {
  phone: boolean;
  projectNames: ReadonlyMap<string, string>;
  /** A branch, a folder or a picked folder: open it (and keep it in the group). */
  onOpen: (open: LocalOpen) => void;
}

/** The + at the right of the heading, and its picker while open. */
export function OpenLocal({ phone, projectNames, onOpen }: OpenLocalProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
  };
  return (
    <>
      <Tip content="Open branch or folder" side="left">
        <button ref={button} type="button" className="ib-iconbtn ib-lp-plus" aria-label="Open branch or folder" aria-expanded={open} onClick={() => setOpen((was) => !was)} data-local-open="">
          <Icon name="plus" size={15} />
        </button>
      </Tip>
      {open && (
        <OpenLocalPicker
          anchor={button}
          phone={phone}
          projectNames={projectNames}
          onClose={close}
          onOpen={(what) => {
            setOpen(false);
            onOpen(what);
          }}
        />
      )}
    </>
  );
}

type Step = { kind: 'projects' } | { kind: 'refs'; project: string } | { kind: 'folder'; from: 'projects' | 'refs' };

type Row = { key: string; kind: 'project'; project: string; name: string; counts: string } | { key: string; kind: 'work'; work: InboxLocalWork } | { key: string; kind: 'other' };

const OTHER = '~other';

/** Where the picker floats: under the heading, from its left edge, over the pane beside the list (a phone: the whole screen). */
function useSpot(anchor: React.RefObject<HTMLElement | null>, phone: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (phone) return;
    const measure = () => {
      const head = anchor.current?.closest<HTMLElement>('.ib-pr-foldhead') ?? anchor.current;
      if (!head) return;
      const rect = head.getBoundingClientRect();
      const view = head.ownerDocument.defaultView ?? window;
      const top = rect.bottom + 4;
      const width = Math.max(280, Math.min(440, view.innerWidth - rect.left - 12));
      const next: CSSProperties = { position: 'fixed', top, left: rect.left, width, maxHeight: Math.max(200, Math.min(480, view.innerHeight - top - 12)) };
      setStyle((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, phone]);
  return style;
}

/** A row's words that say what is in it: "uncommitted", its commits, or "same as main". Null: git couldn't count. */
function whatOf(work: InboxLocalWork): { words: string; same: boolean } | null {
  if (work.kind === 'folder' && work.uncommitted) return { words: 'uncommitted', same: false };
  if (inboxLocalSameAsBase(work)) return { words: `same as ${work.base ?? 'main'}`, same: true };
  return typeof work.ahead === 'number' ? { words: plural(work.ahead, 'commit'), same: false } : null;
}

/** `text` with the first place it holds `query` in bold (case aside). */
function Hit({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + query.length)}</b>
      {text.slice(at + query.length)}
    </>
  );
}

function OpenLocalPicker({ anchor, phone, projectNames, onClose, onOpen }: { anchor: React.RefObject<HTMLButtonElement | null>; phone: boolean; projectNames: ReadonlyMap<string, string>; onClose: () => void; onOpen: (open: LocalOpen) => void }) {
  const [projects, setProjects] = useState<InboxLocalRefProjectsAnswer | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [refs, setRefs] = useState<{ project: string; answer: InboxLocalRefsAnswer | null; failed: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [hlKey, setHlKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const spot = useSpot(anchor, phone);
  const nameOf = (id: string) => projectNames.get(id) ?? id;

  useEffect(() => {
    const controller = new AbortController();
    readLocalRefProjects(controller.signal).then(
      (answer) => {
        const list = Array.isArray(answer?.projects) ? answer : { projects: [] };
        setProjects(list);
        // One project: its step at once.
        setStep(list.projects.length === 1 ? { kind: 'refs', project: list.projects[0]!.project_id } : { kind: 'projects' });
      },
      () => {
        if (!controller.signal.aborted) {
          setProjects({ projects: [] });
          setStep({ kind: 'projects' });
        }
      },
    );
    return () => controller.abort();
  }, []);
  const refsOf = step?.kind === 'refs' ? step.project : null;
  useEffect(() => {
    if (!refsOf) return;
    setRefs(null);
    const controller = new AbortController();
    readLocalRefs(refsOf, controller.signal).then(
      (answer) => setRefs({ project: refsOf, answer: Array.isArray(answer?.folders) && Array.isArray(answer?.branches) ? answer : null, failed: false }),
      () => !controller.signal.aborted && setRefs({ project: refsOf, answer: null, failed: true }),
    );
    return () => controller.abort();
  }, [refsOf]);
  // Out of it: closed. The + itself toggles it.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose, anchor]);
  useEffect(() => {
    if (step?.kind !== 'folder') inputRef.current?.focus({ preventScroll: true });
  }, [step]);

  const skipped = projects?.projects.length === 1;
  const another = projects?.another_folder === true;
  const words = query.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    if (!step || step.kind === 'folder') return [];
    const otherRow: Row[] = another && (!words || 'another folder'.includes(words)) ? [{ key: OTHER, kind: 'other' }] : [];
    if (step.kind === 'projects') {
      const list = (projects?.projects ?? []).filter((p) => !words || nameOf(p.project_id).toLowerCase().includes(words));
      return [
        ...list.map((p) => ({
          key: `p:${p.project_id}`,
          kind: 'project' as const,
          project: p.project_id,
          name: nameOf(p.project_id),
          counts: [p.folders > 0 ? plural(p.folders, 'folder') : null, plural(p.branches, 'branch', 'branches')].filter(Boolean).join(' · '),
        })),
        ...otherRow,
      ];
    }
    const answer = refs?.project === step.project ? refs.answer : null;
    const match = (work: InboxLocalWork) => !words || inboxLocalWorkLabel(work).toLowerCase().includes(words) || (inboxLocalFolderQuiet(work) ?? '').toLowerCase().includes(words);
    const work = [...(answer?.folders ?? []).filter(match), ...(answer?.branches ?? []).filter(match)].map((item) => ({ key: inboxLocalWorkKey(item), kind: 'work' as const, work: item }));
    return [...work, ...(skipped ? otherRow : [])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, projects, refs, words, another, skipped, projectNames]);
  const found = rows.findIndex((row) => row.key === hlKey);
  const hl = rows.length === 0 ? -1 : found >= 0 ? found : 0;
  const optionId = (i: number) => `ib-lp-${uid}-${i}`;
  useLayoutEffect(() => {
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);

  const toStep = (next: Step) => {
    setQuery('');
    setHlKey(null);
    setStep(next);
  };
  const choose = (row: Row) => {
    if (row.kind === 'project') toStep({ kind: 'refs', project: row.project });
    else if (row.kind === 'other') setStep({ kind: 'folder', from: step?.kind === 'refs' ? 'refs' : 'projects' });
    else if (row.work.kind === 'folder') onOpen({ project: row.work.project_id, branch: null, folder: row.work.folder ?? '' });
    else onOpen({ project: row.work.project_id, branch: row.work.branch });
  };
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || step?.kind === 'folder') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      setHlKey(rows[(hl + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]!.key);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (hl >= 0 && rows[hl]) choose(rows[hl]);
    }
  };

  const host = anchor.current?.closest('.pn-inbox') ?? document.body;
  if (step?.kind === 'folder') {
    // "Another folder…": New message's folder opener as it is; the folder it starts in opens as a review.
    return createPortal(
      <div className="ib-cp-picker ib-cp-folders ib-lp-picker" ref={ref} style={spot} data-local-picker="folder" data-phone={phone ? '' : undefined}>
        <HomeFolderBrowser
          machine={{ id: null, name: null, home: projects?.home ?? null }}
          phone={phone}
          // Back to the list it was opened from: the one project's step when the projects step is skipped.
          onBack={() => toStep(step.from === 'refs' && skipped ? { kind: 'refs', project: projects!.projects[0]!.project_id } : { kind: 'projects' })}
          onPick={(folder, _name, how) => {
            // A folder that isn't there yet ("Create … and start") has nothing to review.
            if (how === 'start') onOpen({ project: '', branch: null, folder });
          }}
        />
      </div>,
      host,
    );
  }
  const inProject = step?.kind === 'refs' ? step.project : null;
  const placeholder = inProject ? 'Branch or folder' : 'Project';
  const answer = inProject && refs?.project === inProject ? refs : null;
  const folderRows = rows.filter((row) => row.kind === 'work' && row.work.kind === 'folder');
  const branchRows = rows.filter((row) => row.kind === 'work' && row.work.kind === 'branch');
  const now = Date.now();
  let at = 0;
  const option = (row: Row) => {
    const i = at++;
    const on = i === hl;
    const common = {
      id: optionId(i),
      role: 'option',
      'aria-selected': on,
      onPointerMove: () => !on && setHlKey(row.key),
      onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
      onClick: () => choose(row),
    } as const;
    if (row.kind === 'project') {
      return (
        <div key={row.key} {...common} aria-label={`${row.name}, ${row.counts}`} className={`ib-cp-opt ib-lp-opt${on ? ' ib-hl' : ''}`} data-local-pick-project={row.project}>
          <Icon name="folder" size={15} />
          <span className="ib-lp-op" dir="auto">
            <Hit text={row.name} query={words} />
          </span>
          <span className="ib-lp-r">{row.counts}</span>
        </div>
      );
    }
    if (row.kind === 'other') {
      return (
        <Fragment key={row.key}>
          {rows.length > 1 && <div className="ib-cp-cap-line" role="presentation" />}
          <div {...common} aria-label="Another folder" className={`ib-cp-opt ib-lp-opt ib-cp-other${on ? ' ib-hl' : ''}`} data-local-pick-other="">
            <Icon name="folder" size={15} />
            <span className="ib-lp-op">Another folder…</span>
          </div>
        </Fragment>
      );
    }
    const work = row.work;
    const title = inboxLocalWorkLabel(work);
    const quiet = inboxLocalFolderQuiet(work);
    const what = whatOf(work);
    const age = reviewAge(work.at, now);
    const label = [title, quiet, what?.words, relativeWords(work.at, now)].filter(Boolean).join(', ');
    return (
      <div key={row.key} {...common} aria-label={label} className={`ib-cp-opt ib-lp-opt${phone ? ' ib-lp-two' : ''}${what?.same ? ' ib-lp-same' : ''}${on ? ' ib-hl' : ''}`} data-local-pick={row.key} data-local-kind={work.kind}>
        <Icon name={work.kind === 'folder' ? 'folder' : 'gitBranch'} size={15} />
        {phone ? (
          <span className="ib-lp-stk">
            <span className="ib-lp-op" dir="auto">
              <Hit text={title} query={words} />
            </span>
            {(quiet || what) && <span className="ib-lp-of">{[quiet, what?.words].filter(Boolean).join(' · ')}</span>}
          </span>
        ) : (
          <>
            <span className="ib-lp-op" dir="auto">
              <Hit text={title} query={words} />
            </span>
            {quiet && (
              <span className="ib-lp-of" dir="auto">
                {quiet}
              </span>
            )}
          </>
        )}
        <span className="ib-lp-r">
          {!phone && what && <span className={what.same ? 'ib-lp-dim' : undefined}>{what.words}</span>}
          <span className="ib-lp-age">{age}</span>
        </span>
      </div>
    );
  };
  const back = inProject && !skipped ? () => toStep({ kind: 'projects' }) : null;
  return createPortal(
    <div className="ib-cp-picker ib-lp-picker" ref={ref} style={spot} data-local-picker={inProject ? 'refs' : 'projects'} data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={back ?? onClose} data-local-picker-back="">
            <Icon name="chevL" size={16} />
            {back ? 'Projects' : 'Reviews'}
          </button>
          <span dir="auto">{inProject ? nameOf(inProject) : 'Open'}</span>
        </div>
      )}
      <div className="ib-cp-filter">
        {!phone && back ? (
          <button type="button" className="ib-lp-back" onClick={back} data-local-picker-back="">
            <Icon name="chevL" size={14} />
            <span dir="auto">{nameOf(inProject!)}</span>
          </button>
        ) : (
          <Icon name="search" size={14} />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-lp-list-${uid}`}
          aria-activedescendant={hl >= 0 ? optionId(hl) : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-local-picker-filter=""
        />
      </div>
      <div className="ib-cp-list ib-lp-list" role="listbox" id={`ib-lp-list-${uid}`} aria-label={inProject ? 'Branch or folder' : 'Projects'}>
        {answer?.failed && (
          <div className="ib-cp-none" role="status">
            The branches could not be read.
          </div>
        )}
        {inProject ? (
          <>
            {folderRows.length > 0 && (
              <div className="ib-cp-cap" aria-hidden="true">
                Folders <span className="ib-n">{formatCount(folderRows.length)}</span>
              </div>
            )}
            {folderRows.map(option)}
            {branchRows.length > 0 && (
              <div className="ib-cp-cap" aria-hidden="true">
                Branches <span className="ib-n">{formatCount(branchRows.length)}</span>
              </div>
            )}
            {branchRows.map(option)}
            {rows.filter((row) => row.kind === 'other').map(option)}
          </>
        ) : (
          rows.map(option)
        )}
      </div>
    </div>,
    host,
  );
}

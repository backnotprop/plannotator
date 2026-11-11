import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { parseInboxGitUrl } from '@plannotator/core/inbox-git-url';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';
import { FolderPath } from './ToPicker';
import {
  HOME_FOLDER_START,
  cleanPastedPath,
  cloneAt,
  folderBrowserView,
  folderRefusalWords,
  homeRelative,
  needsNameRead,
  placeOf,
  splitFolderPath,
  folderName,
  type CloneTargetRead,
  type FolderDrive,
  type FolderRead,
  type FolderRow,
} from './homeFolders';

export interface HomeFolderMachine {
  id: string | null;
  name: string | null;
  asleep?: boolean;
  home?: string | null;
  drives?: readonly FolderDrive[] | null;
  finder?: boolean;
}

type Read = { path: string; retry: number; answer: FolderRead } | { path: string; retry: number; error: string; code: string | null };

const READ_DEBOUNCE_MS = 150;

function useFolderRead(path: string | null, machineId: string | null, asleep: boolean, retry = 0): Read | null {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    if (asleep || path === null) return;
    const controller = new AbortController();
    let live = true;
    const timer = setTimeout(() => {
      inboxApi.homeFolders(path, machineId, controller.signal, retry > 0).then(
        (answer) => {
          if (!live) return;
          const nearest = answer.nearest && typeof answer.nearest.path === 'string' && Array.isArray(answer.nearest.folders) ? { path: answer.nearest.path, folders: answer.nearest.folders } : null;
          setRead({
            path,
            retry,
            answer: {
              exists: answer.exists === true,
              ...(answer.state ? { state: answer.state } : {}),
              folders: Array.isArray(answer.folders) ? answer.folders : [],
              ...(Array.isArray(answer.locked) ? { locked: answer.locked } : {}),
              ...(typeof answer.writable === 'boolean' ? { writable: answer.writable } : {}),
              nearest,
              blocked: answer.blocked ?? null,
              ...(answer.start === false ? { start: false as const } : {}),
              ...(Array.isArray(answer.nostart) ? { nostart: answer.nostart } : {}),
            },
          });
        },
        (cause) => {
          if (!live) return;
          setRead({
            path,
            retry,
            error: cause instanceof InboxApiError ? folderRefusalWords(cause.code ?? null, cause.message) : "The folders couldn't be read.",
            code: cause instanceof InboxApiError ? (cause.code ?? null) : null,
          });
        },
      );
    }, READ_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, machineId, asleep, retry]);
  return asleep || path === null || !read || read.path !== path || read.retry !== retry ? null : read;
}

function useSettled(key: string | null, ms: number): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setSettled(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && settled === key;
}

const quietDrives = new Set<string>();
const quietKey = (machineId: string | null, drivePath: string) => `${machineId ?? ''}\n${drivePath}`;

const READING_SHOWN_MS = 700;

function useCloneTarget(at: string | null, url: string | null, machineId: string | null, asleep: boolean): CloneTargetRead | null {
  const [target, setTarget] = useState<{ key: string; read: CloneTargetRead | null } | null>(null);
  const key = at !== null && url ? `${url}\n${at}` : null;
  useEffect(() => {
    if (asleep || key === null) return;
    const controller = new AbortController();
    let live = true;
    inboxApi.cloneTarget(url!, at!, machineId, controller.signal).then(
      (answer) => live && setTarget({ key, read: { into: at!, path: answer.path, name: answer.name, state: answer.state, taken: answer.taken, writable: answer.writable !== false } }),
      () => live && setTarget({ key, read: null }),
    );
    return () => {
      live = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, machineId, asleep]);
  return target && target.key === key ? target.read : null;
}

function rowAria(row: FolderRow): string {
  switch (row.kind) {
    case 'start':
      return `Start in ${row.name}, ${row.path}`;
    case 'create':
      return `Create ${row.name} and start, a new folder at ${row.path}`;
    case 'fix':
      return `Go to ${row.path.replace(/\/$/, '')}, the path with ${row.name} in place of ${row.from}`;
    case 'noaccess':
      return `${row.name}, no access, can't be opened`;
    case 'cloneHere':
      return `Clone ${row.repo} here, into ${row.path}${row.taken ? `. ${row.taken} is another folder` : ''}`;
    case 'cloneStart':
      return `Start in ${row.name}, ${row.path}, already cloned`;
    case 'cloneInto':
      return `Clone into ${row.name} and start, ${row.path}`;
    default:
      return `${row.name}, ${row.path}`;
  }
}

export function HomeFolderBrowser({
  machine,
  onPick,
  onBack,
  initialPath = HOME_FOLDER_START,
  phone = false,
  onTyped,
  clone = null,
  onGitUrl,
}: {
  machine: HomeFolderMachine;
  onPick: (folder: string, name: string, how: 'start' | 'create' | 'clone') => void;
  onBack: () => void;
  initialPath?: string;
  phone?: boolean;
  onTyped?: (typed: string) => void;
  clone?: { url: string; repo: string } | null;
  onGitUrl?: (url: string) => void;
}) {
  const [typed, setTypedState] = useState(initialPath);
  const setTyped = (next: string) => {
    if (!clone && onGitUrl && parseInboxGitUrl(next)?.kind === 'repo') {
      onGitUrl(next.trim());
      return;
    }
    setTypedState(next);
    onTyped?.(next);
  };
  const shown = homeRelative(typed.trim(), machine.home ?? null);
  const { parent, tail } = splitFolderPath(shown);
  const asleep = machine.asleep === true;
  const drives = machine.drives ?? [];
  const here = placeOf(shown, drives);
  const atHome = shown.startsWith('~');
  const refused = parent.split('/').some((segment) => segment.startsWith('.'));
  const [retry, setRetry] = useState(0);
  const [, setQuietSeen] = useState(0);
  const quietHere = here !== null && quietDrives.has(quietKey(machine.id, here.path));
  const read = useFolderRead(refused || quietHere ? null : parent, machine.id, asleep, retry);
  const ok = read && 'answer' in read ? read.answer : null;
  const nameRead = useFolderRead(needsNameRead(ok, tail) ? `${parent === '~' ? '~' : parent === '/' ? '' : parent}/${tail}` : null, machine.id, asleep, retry);
  const slow = quietHere || (!!read && 'error' in read && read.code === 'folder_slow');
  useEffect(() => {
    if (!here || !read) return;
    const key = quietKey(machine.id, here.path);
    const was = quietDrives.has(key);
    if ('error' in read && read.code === 'folder_slow') quietDrives.add(key);
    else if ('answer' in read) quietDrives.delete(key);
    if (was !== quietDrives.has(key)) setQuietSeen((n) => n + 1);
  }, [read, here, machine.id]);
  const placesRef = useRef<HTMLDivElement>(null);
  const placeOn = atHome ? 'home' : (here?.path ?? null);
  useEffect(() => {
    if (placeOn === null) return;
    const button = placesRef.current?.querySelector<HTMLElement>(`[data-home-folders-place="${CSS.escape(placeOn)}"]`);
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [placeOn]);
  const [more, setMore] = useState({ before: false, after: false });
  const measurePlaces = () => {
    const row = placesRef.current;
    if (!row) return;
    const before = row.scrollLeft > 1;
    const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setMore((was) => (was.before === before && was.after === after ? was : { before, after }));
  };
  useEffect(() => {
    const row = placesRef.current;
    if (!row) return;
    measurePlaces();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measurePlaces);
    observer.observe(row);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drives.length]);
  const tryAgain = () => {
    if (here) quietDrives.delete(quietKey(machine.id, here.path));
    setRetry((n) => n + 1);
  };
  const reading = useSettled(!asleep && !refused && !quietHere && !read ? `${retry}\n${parent}` : null, READING_SHOWN_MS);
  const [finding, setFinding] = useState(false);
  const okName = nameRead && 'answer' in nameRead ? nameRead.answer : null;
  const target = useCloneTarget(clone ? cloneAt(shown, ok, okName) : null, clone?.url ?? null, machine.id, asleep);
  const view = asleep
    ? { note: null, rows: [] as FolderRow[], after: null }
    : folderBrowserView({ typed: shown, read: ok, nameRead: okName, error: quietHere ? `${here!.name} isn't responding.` : read && 'error' in read ? read.error : null, clone: clone ? { repo: clone.repo, target } : null });
  const rows = view.rows;
  const rowsKey = rows.map((row) => `${row.kind}>${row.path}`).join('\n');

  const [hl, setHl] = useState(0);
  useLayoutEffect(() => setHl(0), [rowsKey]);
  const at = rows.length === 0 ? -1 : Math.min(hl, rows.length - 1);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-hfb-${uid}-${i}`;
  useLayoutEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const goTo = (path: string) => {
    setTyped(path);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const choose = (row: FolderRow) => {
    if (row.kind === 'start' || row.kind === 'cloneStart') onPick(row.path, row.name, 'start');
    else if (row.kind === 'create') onPick(row.path, row.name, 'create');
    else if (row.kind === 'cloneHere' || row.kind === 'cloneInto') onPick(row.path, row.name, 'clone');
    else if (row.kind === 'fix') goTo(row.path);
    else if (row.kind === 'folder') goTo(`${row.path}/`);
  };

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (rows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHl((at + step + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.target === inputRef.current) {
      const row = at >= 0 ? rows[at] : undefined;
      if (row?.kind === 'folder') {
        event.preventDefault();
        event.stopPropagation();
        goTo(`${row.path}/`);
      }
      return;
    }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      if ((event.target as Element).closest?.('button')) return;
      event.preventDefault();
      event.stopPropagation();
      if (at >= 0 && rows[at]) choose(rows[at]);
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const raw = event.clipboardData?.getData('text') ?? '';
    if (!raw) return;
    event.preventDefault();
    if (!clone && onGitUrl && parseInboxGitUrl(raw)?.kind === 'repo') {
      onGitUrl(raw.trim());
      return;
    }
    const input = event.currentTarget;
    const clean = cleanPastedPath(raw, machine.home ?? null);
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    goTo(start === 0 && end === input.value.length ? clean : input.value.slice(0, start) + clean + input.value.slice(end));
  };

  const chooseInFinder = () => {
    if (finding) return;
    setFinding(true);
    inboxApi.chooseFolder().then(
      (answer) => {
        setFinding(false);
        if (answer.path) goTo(`${homeRelative(answer.path.replace(/\/+$/, ''), machine.home ?? null).replace(/\/+$/, '')}/`);
        else inputRef.current?.focus();
      },
      () => setFinding(false),
    );
  };
  const placesRow = (drives.length > 0 || machine.finder === true) && !clone && (
    <div className="ib-hfb-places" data-home-folders-places="" ref={placesRef} onScroll={measurePlaces} data-more-before={more.before ? '' : undefined} data-more-after={more.after ? '' : undefined}>
      {drives.length > 0 && (
        <div className="ib-seg ib-seg-sm" role="radiogroup" aria-label="Places">
          <button type="button" className="ib-seg-o" role="radio" aria-checked={atHome} data-on={atHome ? '' : undefined} onClick={() => goTo(HOME_FOLDER_START)} data-home-folders-place="home">
            <Icon name="folder" size={14} />
            Home
          </button>
          {drives.map((drive) => {
            const on = here?.path === drive.path;
            const quiet = quietDrives.has(quietKey(machine.id, drive.path));
            return (
              <button
                key={drive.path}
                type="button"
                className="ib-seg-o"
                role="radio"
                aria-checked={on}
                aria-label={`${drive.name}${drive.network ? ', network drive' : ''}${quiet ? ", isn't responding" : ''}`}
                data-on={on ? '' : undefined}
                onClick={() => goTo(`${drive.path}/`)}
                data-home-folders-place={drive.path}
                data-quiet={quiet ? '' : undefined}
              >
                <Icon name={drive.network ? 'globe' : 'drive'} size={14} />
                {drive.name}
                {quiet && <span className="ib-hfb-quiet"> · isn't responding</span>}
              </button>
            );
          })}
        </div>
      )}
      {machine.finder === true && (
        <button type="button" className="ib-lnk ib-hfb-finder" disabled={finding} onClick={chooseInFinder} data-home-folders-finder="">
          <Icon name="external" size={14} />
          {finding ? 'Waiting for Finder…' : 'Choose in Finder…'}
        </button>
      )}
    </div>
  );

  const where = clone ? (
    <>
      Clone <b dir="auto">{clone.repo}</b>
      {machine.name && (
        <>
          {' '}
          on <b dir="auto">{machine.name}</b>
        </>
      )}
    </>
  ) : machine.name ? (
    <>
      A folder on <b dir="auto">{machine.name}</b>
    </>
  ) : (
    'A folder'
  );

  const lead = (row: FolderRow) =>
    row.kind === 'start' || row.kind === 'fix' || row.kind === 'cloneHere' || row.kind === 'cloneStart' || ((row.kind === 'create' || row.kind === 'cloneInto') && !row.quiet);
  const icon = (row: FolderRow) =>
    row.kind === 'start' || row.kind === 'cloneStart'
      ? 'check'
      : row.kind === 'create'
        ? 'folderPlus'
        : row.kind === 'cloneHere' || row.kind === 'cloneInto'
          ? 'gitBranch'
          : row.kind === 'fix'
            ? 'arrowRight'
            : row.kind === 'noaccess'
              ? 'lock'
              : 'folder';
  const twoLine = (row: FolderRow) => phone && (row.kind === 'create' || row.kind === 'cloneHere' || row.kind === 'cloneInto' || row.kind === 'cloneStart');
  const words = (row: FolderRow) => {
    switch (row.kind) {
      case 'start':
        return (
          <>
            Start in <b>{row.name}</b>
          </>
        );
      case 'create':
        return (
          <>
            Create <b>{row.name}</b> and start
          </>
        );
      case 'fix':
        return (
          <>
            Go to <b>{row.path.replace(/\/$/, '')}</b>
          </>
        );
      case 'cloneHere':
        return (
          <>
            Clone <b>{row.repo}</b> here
          </>
        );
      case 'cloneStart':
        return (
          <>
            Start in <b>{row.name}</b>
            <span className="ib-cp-trust"> · already cloned</span>
          </>
        );
      case 'cloneInto':
        return (
          <>
            Clone into <b>{row.name}</b> and start
          </>
        );
      default:
        return row.name;
    }
  };
  const place = (row: FolderRow) => (row.kind === 'fix' ? '' : row.kind === 'noaccess' ? 'no access' : row.path);

  return (
    <div className="ib-hfb" data-home-folders={machine.id ?? 'self'} data-home-folders-clone={clone ? clone.repo : undefined} data-asleep={asleep ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onBack} data-home-folders-back="">
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>{clone ? 'Clone into' : 'Another folder'}</span>
        </div>
      )}
      {phone ? (
        (machine.name || clone) && (
          <div className="ib-hfb-head">
            <span>{where}</span>
          </div>
        )
      ) : (
        <div className="ib-hfb-head">
          <button type="button" className="ib-hfb-back" aria-label="Back to the list" onClick={onBack} data-home-folders-back="">
            <Icon name="chevL" size={15} />
          </button>
          <span>{where}</span>
        </div>
      )}
      {placesRow}
      <div className="ib-cp-filter ib-hfb-field">
        <Icon name="folder" size={14} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-hfb-list-${uid}`}
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          aria-label={clone ? `Folder to clone ${clone.repo} into${machine.name ? `, on ${machine.name}` : ''}` : machine.name ? `A folder on ${machine.name}` : 'A folder'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onPaste={onPaste}
          data-home-folders-path=""
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-hfb-list-${uid}`} aria-label="Folders">
        {asleep && (
          <div className="ib-cp-none" role="status" data-home-folders-note="asleep">
            {machine.name ?? 'This computer'} is asleep
          </div>
        )}
        {reading && (
          <div className="ib-cp-none ib-cp-checking" role="status" data-home-folders-note="reading">
            <span className="ib-run-spin" aria-hidden="true" />
            Reading {here?.name ?? (parent === '~' ? 'your home folder' : folderName(parent))}…
          </div>
        )}
        {view.note && (
          <div className="ib-cp-none ib-hfb-note" role="status" data-home-folders-note={slow ? 'slow' : 'line'}>
            {view.note}
            {slow && (
              <>
                {' '}
                <button type="button" className="ib-lnk" onMouseDown={(event) => event.preventDefault()} onClick={tryAgain} data-home-folders-retry="">
                  Try again
                </button>
              </>
            )}
          </div>
        )}
        {rows.map((row, i) => (
          <Fragment key={`${row.kind}:${row.path}`}>
            <div
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              aria-disabled={row.kind === 'noaccess' ? 'true' : undefined}
              aria-label={rowAria(row)}
              className={`ib-cp-opt ib-cp-fopt${lead(row) ? ' ib-hfb-start' : ''}${(row.kind === 'create' || row.kind === 'cloneInto') && row.quiet ? ' ib-hfb-quiet' : ''}${row.kind === 'noaccess' ? ' ib-hfb-noaccess' : ''}${twoLine(row) ? ' ib-hfb-two' : ''}${i === at ? ' ib-hl' : ''}`}
              data-home-folder-row={row.kind}
              data-home-folder-start={row.kind === 'start' ? row.path : undefined}
              data-home-folder-create={row.kind === 'create' ? row.path : undefined}
              data-home-folder-clone={row.kind === 'cloneHere' || row.kind === 'cloneInto' ? row.path : undefined}
              data-home-folder-option={row.kind === 'folder' || row.kind === 'noaccess' ? row.name : undefined}
              onPointerMove={() => i !== at && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(row)}
            >
              <Icon name={icon(row)} size={15} />
              <span className="ib-cp-op" dir="auto">
                {words(row)}
                {twoLine(row) && <span className="ib-hfb-sub">{row.path}</span>}
              </span>
              {place(row) ? row.kind === 'noaccess' ? <span className="ib-hfb-noaccess-word">no access</span> : <FolderPath path={place(row)} /> : <span />}
              <span className="ib-cp-check" aria-hidden="true" />
            </div>
            {view.after && view.after.at === i + 1 && (
              <div className="ib-hfb-after" aria-hidden="true" data-home-folders-after="">
                {view.after.text}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

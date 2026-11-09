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
  normalizeFolderPath,
  splitFolderPath,
  type CloneTargetRead,
  type FolderRead,
  type FolderRow,
} from './homeFolders';

/**
 * "Another folder on <machine>…" (remote launch, approval addendum "existing folders"): a folder under one machine's
 * home, typed or picked one level at a time. A header ("‹ A folder on Mac mini"), a path field that starts at `~/`,
 * and under it the folders of the typed path's parent that start with what is typed after its last slash (read
 * through `inboxApi.homeFolders`, this computer's route or the machine's forward, a moment after typing stops; an
 * answer for a path no longer typed is dropped). Picking a folder goes into it; when the field names a folder that is
 * there, "✓ Start in <name>" leads, and picking it calls `onPick`. Create a folder (approval "launch-create-clone",
 * A1-A12, the rules in `folderBrowserView`): a name that isn't there offers "Create <name> and start" (last and quiet
 * while a folder still starts with it), a typo one level up "Go to <path>", and a file, a folder that can't be opened
 * or written, a hidden one or one outside home is said in one line. An asleep machine is never read ("Mac mini is
 * asleep"), so nothing unverified can be picked. A pasted path is cleaned here (B1-B3), as the server refuses `\`.
 *
 * Clone into another folder (approval "launch-create-clone", C14-C15c, `clone`): the same browser, headed "Clone <repo>
 * on <machine>". A folder that is there is where the clone goes ("Clone <repo> here", into the repo's name or the next
 * free one, as that machine answers), home too; a new name becomes the clone's own folder ("Clone into <name> and
 * start"). A git URL typed or pasted in the folder field (B5) goes back to the list as that machine's clone row
 * (`onGitUrl`).
 *
 * The menu's keys only: ↑ ↓ walk the rows, Enter picks one, Escape (or the back arrow) is `onBack`.
 *
 * Nothing about compose in here: compose's folder menu hosts it, and any other screen that needs a folder under home
 * can. Its host draws the box around it (the menu's `.ib-cp-picker`, which is also what lays it out as a phone sheet).
 */
export interface HomeFolderMachine {
  /** A linked machine's id; null: this computer (`GET /api/inbox/launch/folders` here). */
  id: string | null;
  /** Its name for the words ("A folder on Mac mini"); null: no machine words at all ("A folder"). */
  name: string | null;
  /** Offline: nothing is read and nothing can be picked. */
  asleep?: boolean;
  /** Its home folder, so a pasted full path reads as `~/…`; null when not known. */
  home?: string | null;
}

/** The read for one path: the listing's answer, or why there is none. */
type Read = { path: string; answer: FolderRead } | { path: string; error: string };

/** How long typing settles before the folders are read. */
const READ_DEBOUNCE_MS = 150;

/** One read of the listing for `path` (null: none), a moment after it settles; an answer for an older path is dropped. */
function useFolderRead(path: string | null, machineId: string | null, asleep: boolean): Read | null {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    if (asleep || path === null) return;
    const controller = new AbortController();
    let live = true;
    const timer = setTimeout(() => {
      inboxApi.homeFolders(path, machineId, controller.signal).then(
        (answer) => {
          if (!live) return;
          const nearest = answer.nearest && typeof answer.nearest.path === 'string' && Array.isArray(answer.nearest.folders) ? { path: answer.nearest.path, folders: answer.nearest.folders } : null;
          setRead({
            path,
            answer: {
              exists: answer.exists === true,
              ...(answer.state ? { state: answer.state } : {}),
              folders: Array.isArray(answer.folders) ? answer.folders : [],
              ...(Array.isArray(answer.locked) ? { locked: answer.locked } : {}),
              ...(typeof answer.writable === 'boolean' ? { writable: answer.writable } : {}),
              nearest,
              blocked: answer.blocked ?? null,
            },
          });
        },
        (cause) => {
          if (!live) return;
          setRead({ path, error: cause instanceof InboxApiError ? folderRefusalWords(cause.code ?? null, cause.message) : "The folders couldn't be read." });
        },
      );
    }, READ_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, machineId, asleep]);
  return asleep || path === null || !read || read.path !== path ? null : read;
}

/** Where a clone into `at` goes on that machine (null: not read yet, or no folder to clone into). */
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

/** A row's words, for its label and for VoiceOver (G1: the full name, then its place). */
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
  /**
   * The folder picked, as the server takes it (`~/code/billing-api`), its own name, and what the Send does there:
   * start in it, make it first (Create), or clone the repo into it (`clone` mode).
   */
  onPick: (folder: string, name: string, how: 'start' | 'create' | 'clone') => void;
  onBack: () => void;
  initialPath?: string;
  /** A phone's sheet: its top bar ("‹ Back  Another folder") is drawn here, and paths are left out of the rows. */
  phone?: boolean;
  /** The path as typed, on every change (its host keeps it, so the browser reopens there: D2). */
  onTyped?: (typed: string) => void;
  /** Clone into another folder: the URL as pasted and the repo's name. */
  clone?: { url: string; repo: string } | null;
  /** A git URL typed or pasted in the folder field (B5): its host shows that machine's clone row instead. */
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
  // Outside home or hidden: said in one line (A11), never read.
  const refused = !normalizeFolderPath(shown).startsWith('~') || parent.split('/').some((segment) => segment.startsWith('.'));
  const read = useFolderRead(refused ? null : parent, machine.id, asleep);
  const ok = read && 'answer' in read ? read.answer : null;
  // A name typed that is none of the folders read: the full path is read too (a file? a folder that can't be opened?).
  const nameRead = useFolderRead(needsNameRead(ok, tail) ? `${parent === '~' ? '~' : parent}/${tail}` : null, machine.id, asleep);
  const okName = nameRead && 'answer' in nameRead ? nameRead.answer : null;
  const target = useCloneTarget(clone ? cloneAt(shown, ok, okName) : null, clone?.url ?? null, machine.id, asleep);
  const view = asleep
    ? { note: null, rows: [] as FolderRow[], after: null }
    : folderBrowserView({ typed: shown, read: ok, nameRead: okName, error: read && 'error' in read ? read.error : null, clone: clone ? { repo: clone.repo, target } : null });
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

  /** The field reads `path`, the caret at its end (into a folder, or a fixed typo). */
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
    // Tab in the path field on a highlighted folder fills it in, as a shell does (G3, q-5e334740): the field reads
    // `<folder>/`, ready for the next name. Anything else highlighted, or none, and Shift+Tab: focus moves as usual.
    if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.target === inputRef.current) {
      const row = at >= 0 ? rows[at] : undefined;
      if (row?.kind === 'folder') {
        event.preventDefault();
        event.stopPropagation();
        goTo(`${row.path}/`);
      }
      return;
    }
    // ⌘↵ stays the dialog's Send.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      if ((event.target as Element).closest?.('button')) return;
      event.preventDefault();
      event.stopPropagation();
      if (at >= 0 && rows[at]) choose(rows[at]);
    }
  };

  // A pasted path, as the person meant it: quotes, `file://` and Terminal's escapes go, a full path in home reads `~/…`.
  const onPaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const raw = event.clipboardData?.getData('text') ?? '';
    if (!raw) return;
    event.preventDefault();
    // A git URL pasted here (B5): that machine's clone row, in the list.
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
  /** A phone hides the path column: these rows' place goes on a second line (G5, G6). */
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
  // The place in the path column: none for Go to (its words are the path); "no access" for a folder that can't be opened.
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
        {view.note && (
          <div className="ib-cp-none ib-hfb-note" role="status" data-home-folders-note="line">
            {view.note}
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
                {/* A phone hides the path column: a new folder's or a clone's place goes on a second line (G5, G6). */}
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

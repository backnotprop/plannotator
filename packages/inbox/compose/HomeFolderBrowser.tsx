import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';
import { FolderPath } from './ToPicker';
import { HOME_FOLDER_START, folderChild, folderName, folderSuggestions, missingFolderLine, namedFolder, shownFolderPath, splitFolderPath } from './homeFolders';

/**
 * "Another folder on <machine>…" (remote launch, approval addendum "existing folders"): a folder under one machine's
 * home, typed or picked one level at a time. A header ("‹ A folder on Mac mini"), a path field that starts at `~/`,
 * and under it the folders of the typed path's parent that start with what is typed after its last slash (read
 * through `inboxApi.homeFolders`, this computer's route or the machine's forward, a moment after typing stops; an
 * answer for a path no longer typed is dropped). Picking a folder goes into it; when the field names a folder that is
 * there, "✓ Start in <name>" leads, and picking it calls `onPick`. A path that isn't there says so; an asleep machine
 * is never read ("Mac mini is asleep"), so nothing unverified can be picked.
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
}

/** The read for one parent path: its names, or why there are none. */
type Read = { parent: string; exists: boolean; folders: string[] } | { parent: string; error: string };

/** How long typing settles before the folders are read. */
const READ_DEBOUNCE_MS = 150;

type Row = { kind: 'start'; path: string } | { kind: 'folder'; name: string };

export function HomeFolderBrowser({
  machine,
  onPick,
  onBack,
  initialPath = HOME_FOLDER_START,
  phone = false,
}: {
  machine: HomeFolderMachine;
  /** The folder picked, as the server takes it (`~/code/billing-api`), and its own name. */
  onPick: (folder: string, name: string) => void;
  onBack: () => void;
  initialPath?: string;
  /** A phone's sheet: its top bar ("‹ Back  Another folder") is drawn here, and paths are left out of the rows. */
  phone?: boolean;
}) {
  const [typed, setTyped] = useState(initialPath);
  const { parent, tail } = splitFolderPath(typed);
  const [read, setRead] = useState<Read | null>(null);
  const asleep = machine.asleep === true;

  useEffect(() => {
    if (asleep) return;
    const controller = new AbortController();
    let live = true;
    const timer = setTimeout(() => {
      inboxApi.homeFolders(parent, machine.id, controller.signal).then(
        (answer) => {
          if (live) setRead({ parent, exists: answer.exists === true, folders: Array.isArray(answer.folders) ? answer.folders : [] });
        },
        (cause) => {
          if (!live) return;
          setRead({ parent, error: cause instanceof InboxApiError ? cause.message : "The folders couldn't be read." });
        },
      );
    }, READ_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [parent, machine.id, asleep]);

  // Only the read for the path as typed now: an older one is never shown under a newer path.
  const current = !asleep && read && read.parent === parent ? read : null;
  const names = current && !('error' in current) && current.exists ? folderSuggestions(current.folders, tail) : [];
  const start = current && !('error' in current) ? namedFolder(current, tail) : null;
  const missing = !!current && !('error' in current) && (!current.exists || (tail !== '' && names.length === 0));
  const rows: Row[] = [...(start ? [{ kind: 'start' as const, path: start }] : []), ...names.map((name) => ({ kind: 'folder' as const, name }))];
  const rowsKey = rows.map((row) => (row.kind === 'start' ? `>${row.path}` : row.name)).join('\n');

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

  /** Into a folder: the field names it with a slash, so its own folders are read. */
  const descend = (name: string) => {
    setTyped(`${folderChild(parent, name)}/`);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const choose = (row: Row) => (row.kind === 'start' ? onPick(row.path, folderName(row.path)) : descend(row.name));

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
    // ⌘↵ stays the dialog's Send.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      if ((event.target as Element).closest?.('button')) return;
      event.preventDefault();
      event.stopPropagation();
      if (at >= 0 && rows[at]) choose(rows[at]);
    }
  };

  const where = machine.name ? (
    <>
      A folder on <b dir="auto">{machine.name}</b>
    </>
  ) : (
    'A folder'
  );

  return (
    <div className="ib-hfb" data-home-folders={machine.id ?? 'self'} data-asleep={asleep ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onBack} data-home-folders-back="">
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>Another folder</span>
        </div>
      )}
      {phone ? (
        machine.name && (
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
          aria-label={machine.name ? `A folder on ${machine.name}` : 'A folder'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          data-home-folders-path=""
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-hfb-list-${uid}`} aria-label="Folders">
        {asleep && (
          <div className="ib-cp-none" role="status" data-home-folders-note="asleep">
            {machine.name ?? 'This computer'} is asleep
          </div>
        )}
        {rows.map((row, i) =>
          row.kind === 'start' ? (
            <div
              key={`start:${row.path}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              aria-label={`Start in ${folderName(row.path)}, ${row.path}`}
              className={`ib-cp-opt ib-cp-fopt ib-hfb-start${i === at ? ' ib-hl' : ''}`}
              data-home-folder-start={row.path}
              onPointerMove={() => i !== at && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(row)}
            >
              <Icon name="check" size={15} />
              <span className="ib-cp-op" dir="auto">
                Start in <b>{folderName(row.path)}</b>
              </span>
              <FolderPath path={row.path} />
              <span className="ib-cp-check" aria-hidden="true" />
            </div>
          ) : (
            <div
              key={`folder:${row.name}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              aria-label={`${row.name}, ${folderChild(parent, row.name)}`}
              className={`ib-cp-opt ib-cp-fopt${i === at ? ' ib-hl' : ''}`}
              data-home-folder-option={row.name}
              onPointerMove={() => i !== at && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(row)}
            >
              <Icon name="folder" size={15} />
              <span className="ib-cp-op" dir="auto">
                {row.name}
              </span>
              <FolderPath path={folderChild(parent, row.name)} />
              <span className="ib-cp-check" aria-hidden="true" />
            </div>
          ),
        )}
        {missing && (
          <div className="ib-cp-none ib-hfb-note" role="status" data-home-folders-note="missing">
            {missingFolderLine(machine.name, shownFolderPath(typed))}
          </div>
        )}
        {current && 'error' in current && (
          <div className="ib-cp-none ib-hfb-note" role="status" data-home-folders-note="error">
            {current.error}
          </div>
        )}
      </div>
    </div>
  );
}

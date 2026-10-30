import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fuzzySearchPaths, type FuzzyPathMatch } from '@plannotator/shared/fuzzy-path';
import { REPO_FILES_SEARCH_ENDPOINT } from '@plannotator/shared/repo-files';
import { altKey } from '@plannotator/ui/utils/platform';
import type { DiffFile } from '../types';
import type { RepoFilesState } from '../hooks/useRepoFiles';

const RESULT_LIMIT = 50;
const SERVER_DEBOUNCE_MS = 80;

export interface GoToFileProps {
  onClose: () => void;
  /** Open a file. `side`: in a tab of its own beside the current one. */
  onOpen: (path: string, options: { side: boolean }) => void;
  files: readonly DiffFile[];
  repo: RepoFilesState;
  /** The session lists no repository (a static patch, Perforce): changed files only. */
  repoSupported: boolean;
  recentPaths: readonly string[];
  snapshotId?: string;
  fetchImpl?: typeof fetch;
}

interface Row {
  path: string;
  positions: readonly number[];
  group?: 'recent' | 'changed';
}

const STATUS_LETTER: Record<DiffFile['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
const STATUS_CLASS: Record<DiffFile['status'], string> = {
  added: 'text-success',
  deleted: 'text-destructive',
  renamed: 'text-warning',
  modified: 'text-primary',
};

/** The matched characters of a name, marked. */
function Marked({ text, offset, positions }: { text: string; offset: number; positions: ReadonlySet<number> }) {
  const parts: React.ReactNode[] = [];
  let run = '';
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(runMarked ? <mark key={key} className="bg-transparent text-primary font-semibold">{run}</mark> : <span key={key}>{run}</span>);
    run = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const marked = positions.has(offset + i);
    if (marked !== runMarked) {
      flush(i);
      runMarked = marked;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

/**
 * Go to File (⌘P / Ctrl+P; approved design record "review-explorer", step 3):
 * a fuzzy search over every file of the repository at the revision the diff
 * reads. The browser searches a listing it holds; a listing too large to send
 * (or not loaded yet) is searched on the server. Changed files carry their
 * badge and win ties; with nothing typed, the files opened last, then the
 * changed files. Enter opens the file in the preview tab; Alt+Enter keeps it
 * in a tab beside the current one.
 */
export const GoToFile: React.FC<GoToFileProps> = ({
  onClose,
  onOpen,
  files,
  repo,
  repoSupported,
  recentPaths,
  snapshotId,
  fetchImpl = fetch,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [serverMatches, setServerMatches] = useState<{ query: string; matches: FuzzyPathMatch[] } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const changed = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const changedSet = useMemo(() => new Set(changed.keys()), [changed]);
  const localPaths = repo.status === 'ready' ? repo.paths : null;
  const lowerPaths = useMemo(() => localPaths?.map((path) => path.toLowerCase()), [localPaths]);
  // Searched on the server: a lazy listing, or one still loading.
  const searchOnServer = repoSupported && !localPaths && repo.status !== 'unavailable' && repo.status !== 'error';

  // Focus goes back where it came from when the palette closes without
  // opening a file (Escape, a click outside).
  const returnFocusRef = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  const close = () => {
    onClose();
    const back = returnFocusRef.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!searchOnServer || !query.trim() || !snapshotId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ snapshot: snapshotId, q: query, limit: String(RESULT_LIMIT) });
      fetchImpl(`${REPO_FILES_SEARCH_ENDPOINT}?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? 'Search failed');
          setServerMatches({ query, matches: body.matches });
          setServerError(null);
        })
        .catch((error: unknown) => {
          if ((error as { name?: string })?.name === 'AbortError') return;
          setServerError(error instanceof Error ? error.message : 'Search failed');
        });
    }, SERVER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchImpl, query, searchOnServer, snapshotId]);

  const rows: Row[] = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      const seen = new Set<string>();
      const recent = recentPaths.filter((path) => !seen.has(path) && seen.add(path)).slice(0, 8)
        .map((path): Row => ({ path, positions: [], group: 'recent' }));
      const rest = files.filter((file) => !seen.has(file.path)).slice(0, 30)
        .map((file): Row => ({ path: file.path, positions: [], group: 'changed' }));
      return [...recent, ...rest];
    }
    if (localPaths) {
      return fuzzySearchPaths(localPaths, trimmed, { limit: RESULT_LIMIT, preferred: changedSet, lowerPaths });
    }
    if (searchOnServer) return serverMatches?.query === query ? serverMatches.matches : [];
    // Nothing listed: the changed files only.
    return fuzzySearchPaths(files.map((file) => file.path), trimmed, { limit: RESULT_LIMIT });
  }, [changedSet, files, localPaths, lowerPaths, query, recentPaths, searchOnServer, serverMatches]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-goto-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const total = repo.status === 'ready' ? repo.total : null;
  const scopeNote = !repoSupported
    ? 'Changed files only: this review has no repository to list'
    : total != null
      ? `${total.toLocaleString('en-US')} files · changed ones marked`
      : repo.status === 'unavailable' || repo.status === 'error'
        ? 'Changed files only'
        : 'Listing the repository…';

  const open = (index: number, side: boolean) => {
    const row = rows[index];
    if (!row) return;
    onOpen(row.path, { side });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(active, event.altKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  };

  let lastGroup: Row['group'] | null = null;
  const content = (
    <div className="fixed inset-0 z-[90]" data-go-to-file-root>
      <div className="absolute inset-0 bg-background/40" onMouseDown={close} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to File"
        data-go-to-file
        onKeyDown={onKeyDown}
        className="absolute left-1/2 top-[8vh] -translate-x-1/2 w-[min(680px,calc(100vw-32px))] rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border/60">
          <svg className="w-4 h-4 text-muted-foreground flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to File…"
            className="flex-1 min-w-0 bg-transparent border-0 shadow-none outline-none focus:outline-none focus:ring-0 text-sm placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            data-go-to-file-input
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Files" className="max-h-[min(420px,60vh)] overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground" data-go-to-file-empty>
              {serverError
                ? serverError
                : query.trim()
                  ? searchOnServer && serverMatches?.query !== query ? 'Searching…' : `No file matches “${query.trim()}”`
                  : 'Type to search every file'}
            </div>
          )}
          {rows.map((row, index) => {
            const slash = row.path.lastIndexOf('/');
            const name = row.path.slice(slash + 1);
            const dir = slash >= 0 ? row.path.slice(0, slash) : '';
            const positions = new Set(row.positions);
            const file = changed.get(row.path);
            const heading = row.group && row.group !== lastGroup
              ? row.group === 'recent' ? 'Recently opened' : 'Changed files'
              : null;
            lastGroup = row.group ?? null;
            return (
              <React.Fragment key={row.path}>
                {heading && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70" role="presentation">
                    {heading}
                  </div>
                )}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-goto-index={index}
                  data-goto-path={row.path}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => open(index, event.altKey)}
                  className={`flex items-center gap-2 mx-1 px-2 h-8 rounded-md cursor-pointer text-[13px] ${index === active ? 'bg-primary/15' : ''}`}
                >
                  {file ? (
                    <span className={`w-4 text-center text-[10px] font-semibold flex-shrink-0 ${STATUS_CLASS[file.status]}`} data-goto-status={STATUS_LETTER[file.status]}>
                      {STATUS_LETTER[file.status]}
                    </span>
                  ) : (
                    <svg className="w-4 h-4 text-muted-foreground/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" />
                    </svg>
                  )}
                  <span className="truncate flex-shrink-0 max-w-[60%]"><Marked text={name} offset={slash + 1} positions={positions} /></span>
                  <span className="truncate text-muted-foreground text-xs min-w-0"><Marked text={dir} offset={0} positions={positions} /></span>
                  <span className="flex-1" />
                  {file && (file.additions > 0 || file.deletions > 0) && (
                    <span className="font-mono text-[11px] flex-shrink-0">
                      {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="text-destructive ml-1">-{file.deletions}</span>}
                    </span>
                  )}
                  {index === active && (
                    <kbd className="text-[10px] font-mono px-1 rounded border border-border/60 text-muted-foreground flex-shrink-0">↵</kbd>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="flex items-center gap-3 px-3 h-8 border-t border-border/60 text-[11px] text-muted-foreground">
          <span><kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> move</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">{altKey}</kbd> <kbd className="font-mono">↵</kbd> open to the side</span>
          <span className="flex-1" />
          <span data-go-to-file-scope>{scopeNote}</span>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
};

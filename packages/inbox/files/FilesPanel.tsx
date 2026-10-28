/**
 * The files panel beside an open file or the Artifacts grid (approval
 * "inbox-files-tabs"): "Filter files", then two sections in one scroll, each
 * under a header the panel draws (the tree's `scrollParent`): the thread's
 * Artifacts, and the project folder named by its folder.
 *
 * The folder lists like VS Code's explorer (owner, 2026-10-27): everything
 * but `.git`, git-ignored entries dimmed, `.env` files and other contents the
 * server refuses locked (listed, never opened; a click says why). Folders
 * load one level at a time (the tree's `loadChildren`). Change marks (M, A,
 * U) show only while the quiet "changes" toggle is on (`showChanges`); they
 * count from the commit the thread started on, plus uncommitted work
 * (packages/server/inbox-files.ts `inboxFilesChangeBase`). While the toggle is
 * on, the folders above each change are listed (still closed) so their dot
 * shows.
 *
 * The tree's own keys stay in the tree; the Inbox's `j`/`k` skip a focused
 * `[role="tree"]`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readInboxAttachmentKind, type InboxAttachmentKind } from '@plannotator/core/inbox-types';
import { FILE_TREE_ROOT, FileTree, FileTreeStore, type FileTreeBadge, type FileTreeIconInfo } from '@plannotator/ui/components/file-tree';
import { inboxApi, InboxApiError, type ProjectChanges, type ProjectListing } from '../api';
import { artifactKey, type Artifact, type FileArtifact } from '../artifacts';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';
import { guessProjectFileKind } from './projectFiles';

export function fileKindIcon(kind: InboxAttachmentKind | string): IconName {
  const k = readInboxAttachmentKind(kind);
  if (k === 'video') return 'film';
  if (k === 'image') return 'photo';
  if (k === 'code') return 'code';
  if (k === 'file' || k === 'pdf') return 'cube';
  return 'doc';
}

/** Where the quiet changes toggle sits (rendered for the owner to choose; one prop, `showChanges`, either way). */
export type ChangesToggleAt = 'header' | 'chip' | 'tools';

/** Why a locked row does not open, in the window's words (the server sends only the reason). */
export const LOCK_WORDS: Record<'dotenv' | 'hidden' | 'outside', string> = {
  dotenv: 'Not opened here: .env files may hold secrets',
  hidden: 'Not opened here: hidden, and git tracks nothing in it',
  outside: 'Not opened here: it leads outside the project folder',
};

const CHANGE_TONE: Record<string, FileTreeBadge['tone']> = { M: 'modified', A: 'added', U: 'untracked', D: 'deleted', R: 'renamed' };
const CHANGE_WORD: Record<string, string> = { M: 'Modified', A: 'Added', U: 'Untracked', D: 'Deleted', R: 'Renamed' };
/** Folders listed so a change's dot shows, at most. */
const CHANGE_FOLDERS_MAX = 300;
/** How often the folders on screen are listed again while the panel shows (a file an agent writes appears). */
const RELIST_MS = 5000;
const CHANGES_MS = 15000;

/** Every folder above a path, top first (`a/b/c.ts` → `a`, `a/b`). */
export function foldersAbove(path: string): string[] {
  const out: string[] = [];
  for (let cut = path.indexOf('/'); cut > 0; cut = path.indexOf('/', cut + 1)) out.push(path.slice(0, cut));
  return out;
}

/** The folders to list so every change's row exists, by depth, capped. */
export function changeFolders(changes: Readonly<Record<string, string>>, max = CHANGE_FOLDERS_MAX): string[][] {
  const seen = new Set<string>();
  for (const path of Object.keys(changes)) {
    for (const dir of foldersAbove(path)) {
      if (seen.size >= max) break;
      seen.add(dir);
    }
  }
  const byDepth: string[][] = [];
  for (const dir of seen) {
    const depth = dir.split('/').length - 1;
    (byDepth[depth] ??= []).push(dir);
  }
  return byDepth.filter(Boolean);
}

/** One listed level as tree paths (a folder ends in `/`). */
export function listingPaths(listing: Pick<ProjectListing, 'dir' | 'entries'>): string[] {
  const prefix = listing.dir ? `${listing.dir}/` : '';
  return listing.entries.map((e) => `${prefix}${e.name}${e.kind === 'dir' ? '/' : ''}`);
}

export interface FilesPanelProps {
  threadId: string;
  /** The thread's artifacts in thread order, or null while they load. */
  artifacts: readonly Artifact[] | null;
  /** Comments waiting for a Send, by a file's path (an attachment's realpath, a project file's relative path). */
  counts: ReadonlyMap<string, number>;
  /** The file on screen (`att_…` or `pf:…`). */
  openId: string | null;
  onOpenArtifact: (artifact: Artifact) => void;
  onOpenProjectFile: (path: string) => void;
  /** A locked row was asked to open: the window says why (a toast). */
  onBlocked: (words: string) => void;
  showChanges: boolean;
  onShowChanges: (on: boolean) => void;
  changesAt: ChangesToggleAt;
  /** Bumped to move focus into the filter (the tab row's +). */
  focusFilter?: number;
  /** Called once the filter took that focus, so a remount (another tab) does not take it again. */
  onFilterFocused?: () => void;
}

interface ProjectState {
  root: ProjectListing['root'] | null;
  error: string | null;
  loaded: boolean;
}

/** The project folder: a lazy tree over the Files routes, with its locks, ignored rows and (toggle on) change marks. */
function useProjectTree(threadId: string, showChanges: boolean, counts: ReadonlyMap<string, number>, visible: boolean) {
  const meta = useRef(new Map<string, { locked: ProjectListing['entries'][number]['locked']; ignored: boolean }>());
  const [state, setState] = useState<ProjectState>({ root: null, error: null, loaded: false });
  const [changes, setChanges] = useState<ProjectChanges | null>(null);
  const applyRef = useRef<() => void>(() => undefined);
  const take = useCallback((listing: ProjectListing) => {
    const prefix = listing.dir ? `${listing.dir}/` : '';
    for (const e of listing.entries) meta.current.set(`${prefix}${e.name}`, { locked: e.locked, ignored: e.ignored });
  }, []);
  const tree = useMemo(
    () =>
      new FileTreeStore([], {
        loadChildren: async (dir) => {
          const listing = await inboxApi.files(threadId, dir);
          take(listing);
          // The new rows' locks and dims, once the store has added them.
          window.setTimeout(() => applyRef.current(), 0);
          return listingPaths(listing);
        },
      }),
    [threadId, take],
  );
  const applyBadges = useCallback(() => {
    const badges = new Map<string, FileTreeBadge>();
    for (const [path, m] of meta.current) {
      if (m.locked) badges.set(path, { locked: LOCK_WORDS[m.locked] });
      else if (m.ignored) badges.set(path, { dimmed: true });
    }
    for (const [path, n] of counts) {
      if (path.startsWith('/')) continue;
      badges.set(path, { ...badges.get(path), count: n });
    }
    if (showChanges && changes) {
      for (const [path, mark] of Object.entries(changes.changes)) {
        badges.set(path, { ...badges.get(path), letter: mark, tone: CHANGE_TONE[mark], label: CHANGE_WORD[mark] });
      }
    }
    tree.setBadges(badges);
  }, [tree, counts, showChanges, changes]);
  applyRef.current = applyBadges;

  // The root level, then every listed level again while the panel shows (what an agent writes appears).
  useEffect(() => {
    let gone = false;
    meta.current.clear();
    setState({ root: null, error: null, loaded: false });
    inboxApi.files(threadId, '').then(
      (listing) => {
        if (gone) return;
        take(listing);
        tree.setPaths(listingPaths(listing));
        setState({ root: listing.root, error: null, loaded: true });
      },
      (cause) => {
        if (gone) return;
        setState({ root: null, error: cause instanceof InboxApiError && cause.code === 'files_no_folder' ? 'No project folder' : 'The folder could not be read', loaded: true });
      },
    );
    return () => {
      gone = true;
    };
  }, [threadId, tree, take]);

  useEffect(() => {
    if (!visible || !state.root) return;
    let busy = false;
    const relist = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const dirs = ['', ...[...tree.expandedPaths()].filter((d) => tree.isLoaded(d))];
        for (const dir of dirs) {
          const listing = await inboxApi.files(threadId, dir).catch(() => null);
          if (!listing) continue;
          take(listing);
          const now = new Set(listingPaths(listing).map((p) => p.replace(/\/$/, '')));
          const model = tree.model;
          const at = dir ? model.find(dir) : FILE_TREE_ROOT;
          if (dir && at <= FILE_TREE_ROOT) continue;
          const had = model.childrenOf(at).map((id) => model.pathOf(id));
          const gone = had.filter((p) => !now.has(p));
          const added = listingPaths(listing).filter((p) => !had.includes(p.replace(/\/$/, '')));
          if (gone.length) tree.remove(gone);
          if (added.length) tree.add(added);
        }
        applyBadges();
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void relist(), RELIST_MS);
    const onFocus = () => void relist();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [visible, state.root, threadId, tree, take, applyBadges]);

  // Change marks: read while the toggle is on; the folders above each change are listed so their dots show.
  useEffect(() => {
    if (!showChanges || !state.root?.git) {
      setChanges(null);
      return;
    }
    let gone = false;
    const read = async () => {
      if (document.hidden) return;
      const next = await inboxApi.filesChanged(threadId).catch(() => null);
      if (gone || !next) return;
      for (const level of changeFolders(next.changes)) {
        await Promise.all(level.filter((dir) => !tree.isLoaded(dir) && tree.model.find(dir) > 0).map((dir) => tree.load(dir).catch(() => undefined)));
        if (gone) return;
      }
      setChanges(next);
    };
    void read();
    const timer = visible ? window.setInterval(() => void read(), CHANGES_MS) : 0;
    return () => {
      gone = true;
      if (timer) window.clearInterval(timer);
    };
  }, [showChanges, state.root, threadId, tree, visible]);

  useEffect(() => {
    applyBadges();
  }, [applyBadges, state.loaded]);

  return { tree, state, changes };
}

function SectionHeader({ open, onToggle, title, count, tip, actions, id }: { open: boolean; onToggle: () => void; title: ReactNode; count?: number | null; tip?: string; actions?: ReactNode; id: string }) {
  const button = (
    <button type="button" className="ib-ftsec-tg" aria-expanded={open} onClick={onToggle} id={id}>
      <Icon name="chevR" size={14} className="ib-ftsec-chev" />
      <span className="ib-ftsec-t">{title}</span>
      {count != null && <span className="ib-ftsec-n">{count}</span>}
    </button>
  );
  return (
    <div className="ib-ftsec-h">
      {tip ? <Tip content={tip}>{button}</Tip> : button}
      {actions && <span className="ib-ftsec-acts">{actions}</span>}
    </div>
  );
}

/** The quiet toggle, in each of its placements: the same state, the same words. */
export function ChangesToggle({ on, onChange, at, base, count }: { on: boolean; onChange: (on: boolean) => void; at: ChangesToggleAt; base?: ProjectChanges['base'] | null; count?: number | null }) {
  const since = base?.commit ? `the commit this thread started on (${base.commit.slice(0, 7)})` : 'this thread started';
  const tip = on ? `Hide changes` : `Show changes since ${since}, plus uncommitted work`;
  if (at === 'chip') {
    return (
      <Tip content={tip}>
        <button type="button" className={`ib-ftchip${on ? ' ib-on' : ''}`} aria-pressed={on} onClick={() => onChange(!on)} data-files-changes="chip">
          <Icon name="changed" size={13} />
          <span>Changes</span>
          {on && count != null && <span className="ib-ftchip-n">{count}</span>}
        </button>
      </Tip>
    );
  }
  return (
    <Tip content={tip}>
      <button type="button" className={`ib-iconbtn ib-ftchanges${at === 'header' ? ' ib-sm' : ''}`} aria-pressed={on} aria-label="Changes" onClick={() => onChange(!on)} data-files-changes={at}>
        <Icon name="changed" size={at === 'header' ? 15 : 16} />
        {on && count != null && <span className="ib-ftchanges-n">{count}</span>}
      </button>
    </Tip>
  );
}

export function FilesPanel(props: FilesPanelProps) {
  const { threadId, artifacts, counts, openId, onOpenArtifact, onOpenProjectFile, onBlocked, showChanges, onShowChanges, changesAt } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [openSecs, setOpenSecs] = useState({ art: true, proj: true });
  const project = useProjectTree(threadId, showChanges, counts, true);

  // The Artifacts section: one row per artifact, keyed by its id, named by its file.
  const fileArtifacts = useMemo(() => (artifacts ?? []).filter((a): a is FileArtifact => a.type === 'file'), [artifacts]);
  const byKey = useMemo(() => new Map((artifacts ?? []).map((a) => [artifactKey(a), a])), [artifacts]);
  const artTree = useMemo(
    () => new FileTreeStore([], { displayName: (key) => { const a = byKey.get(key); return a ? (a.type === 'file' ? a.attachment.name : a.guide.title || 'Guided review') : key; } }),
    [byKey],
  );
  useEffect(() => {
    artTree.setPaths((artifacts ?? []).map(artifactKey));
    const badges = new Map<string, FileTreeBadge>();
    for (const a of fileArtifacts) {
      const n = counts.get(a.attachment.path) ?? 0;
      if (n > 0) badges.set(a.attachment.id, { count: n });
    }
    artTree.setBadges(badges);
  }, [artTree, artifacts, fileArtifacts, counts]);

  useEffect(() => {
    artTree.setFilter(filter);
    project.tree.setFilter(filter);
  }, [filter, artTree, project.tree]);
  useEffect(() => {
    if (!props.focusFilter) return;
    filterRef.current?.focus();
    props.onFilterFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusFilter]);

  const artIcon = useCallback(
    (info: FileTreeIconInfo) => {
      const a = byKey.get(info.path);
      return <Icon name={!a ? 'doc' : a.type === 'guide' ? 'book' : fileKindIcon(a.attachment.kind)} size={14} />;
    },
    [byKey],
  );
  const projIcon = useCallback((info: FileTreeIconInfo) => (info.isDir ? null : <Icon name={fileKindIcon(guessProjectFileKind(info.name))} size={14} />), []);

  const openPath = openId?.startsWith('pf:') ? openId.slice(3) : null;
  const changeCount = project.changes ? Object.keys(project.changes.changes).length : null;
  const root = project.state.root;
  const toggle = <ChangesToggle on={showChanges} onChange={onShowChanges} at={changesAt} base={project.changes?.base ?? null} count={changeCount} />;

  return (
    <aside className="ib-ftree" aria-label="Files" data-files-panel="">
      <div className="ib-ftfilter">
        <Icon name="search" size={14} />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              e.stopPropagation();
              setFilter('');
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          spellCheck={false}
          autoComplete="off"
          data-files-filter=""
        />
      </div>
      {changesAt === 'chip' && root?.git && <div className="ib-ftchiprow">{toggle}</div>}
      <div className="ib-ftscroll" ref={scroller}>
        {(artifacts?.length ?? 0) > 0 && (
          <>
            <SectionHeader id={`ib-ft-art-${threadId}`} open={openSecs.art} onToggle={() => setOpenSecs((s) => ({ ...s, art: !s.art }))} title="Artifacts" count={artifacts!.length} />
            {openSecs.art && (
              <FileTree
                tree={artTree}
                scrollParent={scroller}
                label="Artifacts"
                selectedPath={openId && byKey.has(openId) ? openId : null}
                onOpen={(key) => {
                  const a = byKey.get(key);
                  if (a) onOpenArtifact(a);
                }}
                renderIcon={artIcon}
              />
            )}
          </>
        )}
        <SectionHeader
          id={`ib-ft-proj-${threadId}`}
          open={openSecs.proj}
          onToggle={() => setOpenSecs((s) => ({ ...s, proj: !s.proj }))}
          title={root?.name ?? 'Project folder'}
          tip={root ? `${root.name}${root.branch ? ` · ${root.branch}` : ''}` : undefined}
          actions={
            root ? (
              <>
                {changesAt === 'header' && root.git && toggle}
                <Tip content="Collapse folders">
                  <button type="button" className="ib-iconbtn ib-sm" aria-label="Collapse folders" onClick={() => project.tree.collapseAll()} data-files-collapse="">
                    <Icon name="collapseAll" size={14} />
                  </button>
                </Tip>
              </>
            ) : null
          }
        />
        {openSecs.proj &&
          (project.state.error ? (
            <div className="ib-ftline" data-files-error="">{project.state.error}</div>
          ) : !project.state.loaded ? (
            <div className="ib-ftline">Reading the folder…</div>
          ) : (
            <FileTree
              tree={project.tree}
              scrollParent={scroller}
              label={root?.name ?? 'Project folder'}
              selectedPath={openPath}
              onOpen={onOpenProjectFile}
              onBlocked={(path) => onBlocked(project.tree.badgeOf(path)?.locked ?? 'Not opened here')}
              renderIcon={projIcon}
              labels={{ markedBelow: 'Has changes', loading: 'Loading' }}
            />
          ))}
        {showChanges && project.changes?.truncated && <div className="ib-ftline">Too many changes to mark them all</div>}
      </div>
    </aside>
  );
}

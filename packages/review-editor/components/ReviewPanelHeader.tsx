/**
 * The top of the code review sidebar (approved design records
 * "review-sidebar-aligned" and, for the tabs and the sentence,
 * "review-sidebar-header", variant "sentence"): every control one click away.
 *
 *  1. Go to file, a quiet field (⌘P).
 *  2. Tree / Commits as underlined tabs (icons under 200 px),
 *     with the panel's one line under them.
 *  3. The comparison read as one sentence whose words are the controls:
 *     "All changes ⌄ since main ⌄". Each word opens its existing menu (the
 *     diff type, the base). A long base keeps its start and end
 *     ("feature/very-l…ame-for-a-stack"); the full name is the trigger's title.
 *
 * Changes N / All files N and the All files listing's state are `ScopeSwitch`,
 * the lead of the list's sticky tools row.
 *
 * One component for the three panels (FileTree, SectionsPanel, CommitsPanel),
 * fed one model built by App, so nothing moves between views.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, FileSearch, FolderTree, GitCommitHorizontal } from 'lucide-react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { isMac } from '@plannotator/ui/utils/platform';
import { formatShortcutBindingTokens, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';
import type { AvailableBranches, CompareTargetPickerCopy, DiffOption, RecentCommit } from '@plannotator/shared/types';
import type { TreeScope } from '../hooks/useTreeScope';
import type { RepoFilesState } from '../hooks/useRepoFiles';
import { BaseBranchPicker } from './BaseBranchPicker';
import { DiffTypePicker, displayRef } from './DiffTypePicker';

export type ReviewPanelView = 'commits' | 'tree';

type ReadyRepo = Extract<RepoFilesState, { status: 'ready' }>;

export interface ReviewPanelHeaderModel {
  /** The view on screen. */
  view: ReviewPanelView;
  /** Offer Commits (git-local and jj sessions). */
  showCommits: boolean;
  onSelectView: (view: ReviewPanelView) => void;
  /** Changes | All files. Choosing a scope from Commits goes to the tree. */
  scope?: { value: TreeScope; onSelect: (scope: TreeScope) => void; changed: number; all?: number };
  /** The All files listing once it is ready, for the live dot. */
  repo?: ReadyRepo | null;
  /** The diff type menu (the tree view). */
  diff?: {
    options: DiffOption[];
    active: string;
    onSelect: (id: string) => void;
    loading?: boolean;
    activeBase?: string | null;
    hasBasePicker: boolean;
  };
  /** The compare target, when the active diff reads one. */
  base?: {
    availableBranches: AvailableBranches;
    selectedBase: string;
    detectedBase: string;
    onSelectBase: (base: string) => void;
    disabled?: boolean;
    copy: CompareTargetPickerCopy;
    recentCommits?: RecentCommit[];
  };
  onGoToFile?: () => void;
  /** A diff search is on: the list shows results from the changes only, so
   *  Changes | All files steps aside until it ends. */
  searching?: boolean;
}

const VIEW_META: Record<ReviewPanelView, { label: string; title: string; Icon: React.FC<{ className?: string }> }> = {
  tree: { label: 'Tree', title: 'Tree view', Icon: FolderTree },
  commits: { label: 'Commits', title: 'Commit history: click a commit to review its diff', Icon: GitCommitHorizontal },
};

/** Below this the view tabs become icons and the scope reads "All". */
export const NARROW_HEADER_WIDTH = 200;
/** Below this Go to File drops its keys. */

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background';

const formatCount = (count: number) => count.toLocaleString('en-US');

function relativeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** "1 added, 1 edited": what changed on disk since the diff was taken. */
function onDiskSummary(repo: ReadyRepo): string {
  const counts = { A: 0, M: 0, D: 0 };
  for (const change of Object.values(repo.onDisk)) counts[change] += 1;
  return [
    counts.A > 0 ? `${counts.A} added` : null,
    counts.M > 0 ? `${counts.M} edited` : null,
    counts.D > 0 ? `${counts.D} deleted` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export const PARTIAL_LISTING_TEXT = 'Part of the repository is listed (the platform stopped early).';

/** "Live · updated 45s ago · 1 added, 1 edited", for the dot's tooltip. */
function useLiveTooltip(repo: ReadyRepo | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!repo?.live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [repo?.live, repo?.updatedAt]);
  if (!repo) return null;
  if (!repo.live) return repo.truncated ? PARTIAL_LISTING_TEXT : null;
  const changes = onDiskSummary(repo);
  return `Live · updated ${relativeAge(now - repo.updatedAt)}${changes ? ` · ${changes}` : ''}`;
}

/**
 * The listing's state as a dot after the All files count: green while live,
 * an amber ring for a partial listing. Decoration only: the words are the
 * tooltip, the status line under the row (partial) and the polite status
 * region (live), so the button's name stays "All files N".
 */
const LiveDot: React.FC<{ repo: ReadyRepo | null | undefined; className?: string }> = ({ repo, className = 'inline-flex items-center' }) => {
  const text = useLiveTooltip(repo);
  if (!repo || !text) return null;
  return (
    <Tooltip content={text} side="bottom">
      <span className={className} aria-hidden="true" data-repo-listing-dot={repo.live ? 'live' : 'partial'}>
        <span className={`w-1.5 h-1.5 rounded-full ${repo.live ? 'bg-success' : 'border border-warning'}`} />
      </span>
    </Tooltip>
  );
};

/**
 * What a screen reader hears about the live listing: said when it turns live
 * and when the files changed on disk change, never on the 15 s age tick.
 */
const LiveStatus: React.FC<{ repo: ReadyRepo | null | undefined }> = ({ repo }) => {
  const text = repo?.live ? `All files is live${onDiskSummary(repo) ? `: ${onDiskSummary(repo)} on disk since the diff` : ''}.` : '';
  return (
    <span className="sr-only" role="status" aria-live="polite" data-repo-listing-status={repo?.live ? 'live' : undefined}>
      {text}
    </span>
  );
};

/** `aria-keyshortcuts` wants key names ("Meta+P"), not the keycaps drawn. */
export function ariaKeyShortcut(binding: string, mac: boolean = isMac): string {
  return binding
    .split('+')
    .map((key) => (key === 'Mod' ? (mac ? 'Meta' : 'Control') : key))
    .join('+');
}

/** The sentence's words for the active diff: a noun and, when a base applies, the word before it. */
export function diffWords(model: Pick<ReviewPanelHeaderModel, 'view' | 'diff' | 'base'>): {
  noun: string;
  connector: string | null;
} {
  const id = model.diff?.active;
  const option = model.diff?.options.find((o) => o.id === id);
  if (!model.base) {
    // No base in the sentence: the option's own words say everything.
    if (id === 'since-base' && model.diff?.activeBase) return { noun: `All changes since ${displayRef(model.diff.activeBase)}`, connector: null };
    return { noun: option?.label ?? 'Changes', connector: null };
  }
  switch (id) {
    case 'since-base':
      return { noun: 'All changes', connector: 'since' };
    case 'merge-base':
      return { noun: 'Committed changes', connector: 'since' };
    case 'branch':
      return { noun: 'Branch diff', connector: 'against' };
    case 'jj-line':
      return { noun: option?.label ?? 'Line of work', connector: 'from' };
    default:
      return { noun: option?.label ?? 'Changes', connector: 'vs' };
  }
}

/** The base word's monospace advance at 11.5px (0.6em, every mono face in the stack). */
const BASE_CHAR_PX = 6.9;
/** What the base word cannot use of the panel: the row's padding and its chevron. */
const BASE_CHROME_PX = 44;

/**
 * A long ref keeps its start and end ("feature/very-l…ame-for-a-stack"): the
 * end is what tells stacked branches apart. Sized for the base word on a line
 * of its own in a panel `width` px wide; short refs come back whole.
 */
export function middleTruncateRef(base: string, width: number): string {
  const ref = displayRef(base);
  const max = Math.max(8, Math.floor((width - BASE_CHROME_PX) / BASE_CHAR_PX));
  if (ref.length <= max) return ref;
  const head = Math.ceil((max - 1) * 0.45);
  const tail = max - 1 - head;
  return `${ref.slice(0, head)}…${ref.slice(ref.length - tail)}`;
}


const GoToFileButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts.goToFile)[0] ?? '';
  const keys = formatShortcutBindingTokens(binding);
  const label = keys.length > 0 ? `Go to file (${keys.join('')})` : 'Go to file';
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label="Go to File…"
        aria-keyshortcuts={binding ? ariaKeyShortcut(binding) : undefined}
        data-go-to-file-button=""
        className={`ml-auto -mr-1 h-6 w-6 flex flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--sidebar-fill)] hover:text-foreground transition-colors ${FOCUS}`}
      >
        <FileSearch className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  );
};

const Chevron: React.FC<{ loading?: boolean }> = ({ loading }) =>
  loading ? (
    <span
      className="w-3 h-3 flex-shrink-0 rounded-full border border-muted-foreground border-t-transparent animate-spin"
      aria-hidden="true"
    />
  ) : (
    <ChevronDown className="w-3 h-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
  );

/** Choosing a scope from Commits goes to the tree. */
function selectScope(model: ReviewPanelHeaderModel, scope: TreeScope) {
  if (!model.scope) return;
  if (model.view !== 'tree') model.onSelectView('tree');
  model.scope.onSelect(scope);
}

/** The scope shown as on (Commits shows none). */
function shownScope(model: ReviewPanelHeaderModel): TreeScope | null {
  if (!model.scope || model.view === 'commits' || model.searching) return null;
  return model.scope.value;
}

/** The views a session offers, in tab order. */
function panelViews(model: ReviewPanelHeaderModel): ReviewPanelView[] {
  return [
    'tree',
    ...(model.showCommits ? (['commits'] as const) : []),
  ];
}

/** The id of the region the view tabs control: the panel's list, below the line. */
export const REVIEW_PANEL_BODY_ID = 'review-panel-body';

/**
 * The tab panel attributes for the list under the header: a tab panel
 * labelled by the chosen tab when the header draws tabs, nothing otherwise
 * (no header, or a session with one view).
 */
export function reviewPanelBodyProps(model: ReviewPanelHeaderModel | undefined): {
  id?: string;
  role?: 'tabpanel';
  'aria-labelledby'?: string;
} {
  if (!model || panelViews(model).length < 2) return {};
  return { id: REVIEW_PANEL_BODY_ID, role: 'tabpanel', 'aria-labelledby': `review-panel-tab-${model.view}` };
}

/**
 * Each view is its own panel component, so choosing a tab unmounts the
 * header that holds it. The tab chosen is remembered here and the same tab in
 * the new panel's header takes focus when it mounts: focus stays on the tab.
 */
let pendingTabFocus: ReviewPanelView | null = null;

/**
 * Tree / Git status / Commits as underlined tabs with real tab markup
 * (tablist / tab / aria-selected / aria-controls). The keys are the standard
 * tabs pattern, handled inside the tablist only (never a page shortcut): the
 * chosen tab is the one Tab stop; Left and Right move focus between the tabs,
 * wrapping; Enter or Space chooses the focused tab (manual activation: a view
 * switch can load a diff, so an arrow never switches by itself). The tabs'
 * track is the panel's one line: above it stays the same on every tab, below
 * it belongs to the tab.
 */
const ViewTabs: React.FC<{ model: ReviewPanelHeaderModel; views: ReviewPanelView[]; narrow: boolean; trailing?: React.ReactNode }> = ({ model, views, narrow, trailing }) => {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (pendingTabFocus === null) return;
    const target = pendingTabFocus;
    pendingTabFocus = null;
    if (target !== model.view) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-panel-view="${target}"]`)?.focus({ preventScroll: true });
  }, [model.view]);

  const choose = (view: ReviewPanelView) => {
    if (view === model.view) return;
    pendingTabFocus = view;
    model.onSelectView(view);
    // The new panel mounts in this same update. A switch the app refused
    // must not pull focus onto a tab later, when the view changes by another
    // route: the wish lasts one frame.
    requestAnimationFrame(() => {
      if (pendingTabFocus === view) pendingTabFocus = null;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tabs = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    tabs[(current + step + tabs.length) % tabs.length]?.focus();
  };

  return (
    <div className="-mx-2 px-4 flex items-center shadow-[inset_0_-1px_0_var(--sidebar-line)]" data-panel-tabs-row="">
    <div
      ref={listRef}
      role="tablist"
      aria-label="Panel view"
      data-panel-view-switch=""
      onKeyDown={onKeyDown}
      className="flex items-center gap-4"
    >
      {views.map((view) => {
        const active = model.view === view;
        const meta = VIEW_META[view];
        const tab = (
          <button
            key={view}
            type="button"
            role="tab"
            id={`review-panel-tab-${view}`}
            aria-selected={active}
            aria-controls={REVIEW_PANEL_BODY_ID}
            aria-label={narrow ? meta.label : undefined}
            tabIndex={active ? 0 : -1}
            title={narrow ? undefined : meta.title}
            data-panel-view={view}
            onClick={() => choose(view)}
            className={`relative h-7 flex items-center rounded-sm text-[13px] font-medium whitespace-nowrap transition-colors ${FOCUS} ${
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {narrow ? <meta.Icon className="w-3.5 h-3.5" aria-hidden="true" /> : meta.label}
            {active && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground" />}
          </button>
        );
        return narrow ? (
          <Tooltip key={view} content={meta.label} side="bottom">
            {tab}
          </Tooltip>
        ) : (
          tab
        );
      })}
    </div>
      {trailing}
    </div>
  );
};

/**
 * The top of the panel (approved design record "review-sidebar-aligned";
 * the tabs and sentence from "review-sidebar-header", variant "sentence").
 * Containers start on the panel's 8 px edge, content on 16, labels on 34:
 *
 *  1. Go to file, a quiet field (⌘P).
 *  2. Tree / Git status / Commits, and the panel's one line under them.
 *  3. The comparison as one sentence: "All changes ⌄ since main ⌄".
 *
 * Changes N / All files moved down to the list's sticky tools row
 * (`ScopeSwitch`, drawn by the panel through `PanelControlsRow`).
 */
export const ReviewPanelHeader: React.FC<{ model: ReviewPanelHeaderModel; width: number }> = ({ model, width }) => {
  const narrow = width < NARROW_HEADER_WIDTH;
  const views = panelViews(model);
  const { noun, connector } = diffWords(model);
  const showSentence = model.view !== 'commits' && (!!model.diff || !!model.base);
  const goToFile = model.onGoToFile ? <GoToFileButton onClick={model.onGoToFile} /> : null;
  const token = `inline-flex min-w-0 max-w-full items-center gap-0.5 rounded px-1 -mx-0.5 py-0.5 min-h-6 font-medium text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px] hover:bg-[var(--sidebar-fill)] hover:decoration-transparent transition-colors disabled:opacity-50 disabled:cursor-wait ${FOCUS}`;

  return (
    <div className="flex-shrink-0 flex flex-col px-2 pt-1" data-review-panel-header="">
      <div>
        {views.length > 1 ? (
          <ViewTabs model={model} views={views} narrow={narrow} trailing={goToFile} />
        ) : (
          <div className="-mx-2 px-4 h-7 flex items-center shadow-[inset_0_-1px_0_var(--sidebar-line)]">
            <span className="text-[13px] font-medium text-muted-foreground">Files</span>
            {goToFile}
          </div>
        )}
      </div>
      {showSentence ? (
        <div className="mt-1 px-2 text-[13px] leading-6 text-muted-foreground flex flex-wrap items-center gap-x-1" data-panel-sentence="">
          {model.diff ? (
            <DiffTypePicker
              options={model.diff.options}
              activeDiffType={model.diff.active}
              onSelect={model.diff.onSelect}
              isLoading={model.diff.loading}
              hasBasePicker={model.diff.hasBasePicker}
              activeBase={model.diff.activeBase}
              trigger={{
                className: token,
                ariaLabel: `Changes shown: ${noun}`,
                content: (
                  <>
                    <span className="truncate">{noun}</span>
                    <Chevron loading={model.diff.loading} />
                  </>
                ),
              }}
            />
          ) : (
            <span className="text-foreground font-medium">{noun}</span>
          )}
          {connector && <span>{connector}</span>}
          {model.base && connector && (
            <span className="flex min-w-0 max-w-full">
              <BaseBranchPicker
                {...model.base}
                trigger={{
                  className: `${token.replace('max-w-full ', '')} font-mono text-[11.5px]`,
                  ariaLabel: `${model.base.copy.triggerTitlePrefix}: ${model.base.selectedBase}`,
                  content: (
                    <>
                      <span className="truncate" data-base-ref>{middleTruncateRef(model.base.selectedBase, width)}</span>
                      <Chevron />
                    </>
                  ),
                }}
              />
            </span>
          )}
        </div>
      ) : (
        <div className="h-1" aria-hidden="true" />
      )}
    </div>
  );
};

/**
 * Changes N / All files, the lead of the list's sticky tools row: two pills,
 * the chosen one a quiet grey fill. All files keeps its count in its name and
 * tooltip, not on screen, and its live dot sits at its top corner: that way
 * the pills and the three tools fit on one line at the default 256 px in
 * either scope, and switching scope never moves the list. While All files is
 * on, its listing's state follows: the live dot, a visible line for a partial
 * listing, and a polite status region for a live one. Draws nothing when the
 * panel shows no scope (Commits, a search, a session without All files).
 */
export interface ScopeProgress {
  viewed: number;
  total: number;
  staged: number;
  showViewed: boolean;
}

function progressTitle(progress: ScopeProgress): string {
  const parts: string[] = [];
  if (progress.showViewed) parts.push(progress.viewed >= progress.total && progress.total > 0 ? `All ${progress.total} viewed` : `${progress.viewed} of ${progress.total} viewed`);
  if (progress.staged > 0) parts.push(`${progress.staged} staged`);
  return parts.join(' · ');
}

export const ScopeSwitch: React.FC<{ model: ReviewPanelHeaderModel; width: number; progress?: ScopeProgress }> = ({ model, width, progress }) => {
  const scope = shownScope(model);
  if (!scope || !model.scope) {
    if (!progress || !progressTitle(progress)) return null;
    return (
      <span className="px-2 text-[12px] tabular-nums text-muted-foreground" data-review-progress-caption="">
        {progressTitle(progress)}
      </span>
    );
  }
  const narrow = width < NARROW_HEADER_WIDTH;
  const listing = scope === 'all' ? model.repo : null;
  const pill = (active: boolean) =>
    `h-6 flex items-center gap-1 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors ${FOCUS} ${
      active ? 'bg-[var(--sidebar-fill-strong)] text-foreground' : 'text-muted-foreground hover:bg-[var(--sidebar-fill)] hover:text-foreground'
    }`;
  const changed = model.scope.changed;
  const all = model.scope.all;
  return (
    <div className="min-w-0" data-tree-scope-row="">
      <div className="flex min-w-0 items-center" role="group" aria-label="Files shown in the tree" data-tree-scope-switch="">
        <button
          type="button"
          aria-pressed={scope === 'changes'}
          onClick={() => selectScope(model, 'changes')}
          data-tree-scope="changes"
          title={progress && progressTitle(progress) ? `The files this review changes: ${progressTitle(progress)}` : 'The files this review changes'}
          className={`flex-shrink-0 px-1.5 ${pill(scope === 'changes')}`}
        >
          <span>Changes</span>
          {progress?.showViewed ? (
            <span
              className={`tabular-nums text-[12px] font-normal ${progress.total > 0 && progress.viewed >= progress.total ? 'text-success' : 'text-muted-foreground'}`}
              data-panel-viewed-controls=""
              data-review-progress-caption=""
            >
              {progress.viewed}/{formatCount(progress.total)}
            </span>
          ) : changed !== undefined && <span className="tabular-nums text-[12px] font-normal text-muted-foreground">{formatCount(changed)}</span>}
          {progress && progress.staged > 0 && <span className="sr-only" data-panel-staged-count="">{progress.staged} staged</span>}
        </button>
        <button
          type="button"
          aria-pressed={scope === 'all'}
          onClick={() => selectScope(model, 'all')}
          data-tree-scope="all"
          title={`Every file of the repository at the revision the diff reads${all !== undefined ? ` (${formatCount(all)} files)` : ''}`}
          className={`relative min-w-0 pl-1.5 pr-2.5 ${pill(scope === 'all')}`}
        >
          <span className="truncate">{narrow ? 'All' : 'All files'}</span>
          {all !== undefined && <span className="sr-only">{formatCount(all)}</span>}
          {scope === 'all' && <LiveDot repo={model.repo} className="absolute top-1 right-1 flex" />}
        </button>
      </div>
      {listing && !listing.live && listing.truncated && (
        <p className="pt-1 px-2 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" data-repo-listing-status="partial">
          <span className="w-1.5 h-1.5 flex-shrink-0 rounded-full border border-warning" aria-hidden="true" />
          <span>{PARTIAL_LISTING_TEXT}</span>
        </p>
      )}
      <LiveStatus repo={listing} />
    </div>
  );
};

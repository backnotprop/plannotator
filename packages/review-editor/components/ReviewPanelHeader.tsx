/**
 * The top of the code review sidebar (approved design record
 * "review-sidebar-header", variant "sentence"): three rows, every control one
 * click away.
 *
 *  1. Tree / Git status / Commits as text tabs (icons under 200 px).
 *  2. The comparison read as one sentence whose words are the controls:
 *     "All changes ⌄ since main ⌄". Each word opens its existing menu (the
 *     diff type, the base). A long base keeps its start and end
 *     ("feature/very-l…ame-for-a-stack"); the full name is the trigger's title.
 *  3. Changes N / All files N, the All files listing's live dot, and Go to File.
 *
 * One component for the three panels (FileTree, SectionsPanel, CommitsPanel),
 * fed one model built by App, so nothing moves between views.
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, FolderTree, GitCommitHorizontal, Layers3, Search } from 'lucide-react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { isMac } from '@plannotator/ui/utils/platform';
import { formatShortcutBindingTokens, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';
import type { AvailableBranches, CompareTargetPickerCopy, DiffOption, RecentCommit } from '@plannotator/shared/types';
import type { TreeScope } from '../hooks/useTreeScope';
import type { RepoFilesState } from '../hooks/useRepoFiles';
import { BaseBranchPicker } from './BaseBranchPicker';
import { DiffTypePicker, displayRef } from './DiffTypePicker';

export type ReviewPanelView = 'sections' | 'commits' | 'tree';

type ReadyRepo = Extract<RepoFilesState, { status: 'ready' }>;

export interface ReviewPanelHeaderModel {
  /** The view on screen. */
  view: ReviewPanelView;
  /** Offer Git status (a session with since-base sections). */
  showSections: boolean;
  /** Offer Commits (git-local and jj sessions). */
  showCommits: boolean;
  onSelectView: (view: ReviewPanelView) => void;
  /** Changes | All files. Choosing a scope from Git status or Commits goes to the tree. */
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
  sections: { label: 'Git status', title: 'Git status view (Committed / Changes / Untracked)', Icon: Layers3 },
  commits: { label: 'Commits', title: 'Commit history: click a commit to review its diff', Icon: GitCommitHorizontal },
};

/** Below this the view tabs become icons and the scope reads "All". */
export const NARROW_HEADER_WIDTH = 200;
/** Below this Go to File drops its keys. */
const GO_TO_FILE_KEYS_WIDTH = 210;

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
const LiveDot: React.FC<{ repo: ReadyRepo | null | undefined }> = ({ repo }) => {
  const text = useLiveTooltip(repo);
  if (!repo || !text) return null;
  return (
    <Tooltip content={text} side="bottom">
      <span className="inline-flex items-center" aria-hidden="true" data-repo-listing-dot={repo.live ? 'live' : 'partial'}>
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
  const id = model.view === 'sections' ? 'since-base' : model.diff?.active;
  const option = model.diff?.options.find((o) => o.id === id);
  if (!model.base) {
    // No base in the sentence: the option's own words say everything.
    if (id === 'since-base' && model.view === 'sections') return { noun: 'All changes', connector: null };
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

const GoToFileButton: React.FC<{ onClick: () => void; showKeys: boolean }> = ({ onClick, showKeys }) => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts.goToFile)[0] ?? '';
  const keys = formatShortcutBindingTokens(binding);
  return (
    <Tooltip content={<span>Go to File <span className="opacity-70">{keys.join('')}</span></span>} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label="Go to File…"
        aria-keyshortcuts={binding ? ariaKeyShortcut(binding) : undefined}
        data-go-to-file-button
        className={`flex-shrink-0 flex items-center gap-1 h-7 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ${FOCUS}`}
      >
        <Search className="w-3.5 h-3.5" aria-hidden="true" />
        {showKeys && (
          <kbd className="font-mono text-[10px] px-1 rounded bg-muted/70 border border-border/50" aria-hidden="true">
            {keys.join('')}
          </kbd>
        )}
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

/** Choosing All files from Git status goes to the tree; Changes is already on there. */
function selectScope(model: ReviewPanelHeaderModel, scope: TreeScope) {
  if (!model.scope) return;
  if (model.view === 'sections' && scope === 'changes') return;
  if (model.view !== 'tree') model.onSelectView('tree');
  model.scope.onSelect(scope);
}

/** The scope shown as on (Git status counts as Changes; Commits shows none). */
function shownScope(model: ReviewPanelHeaderModel): TreeScope | null {
  if (!model.scope || model.view === 'commits' || model.searching) return null;
  return model.view === 'sections' ? 'changes' : model.scope.value;
}

export const ReviewPanelHeader: React.FC<{ model: ReviewPanelHeaderModel; width: number }> = ({ model, width }) => {
  const narrow = width < NARROW_HEADER_WIDTH;
  const views: ReviewPanelView[] = [
    'tree',
    ...(model.showSections ? (['sections'] as const) : []),
    ...(model.showCommits ? (['commits'] as const) : []),
  ];
  const scope = shownScope(model);
  const { noun, connector } = diffWords(model);
  const showScopeRow = !!scope || !!model.onGoToFile;
  const showSentence = model.view !== 'commits' && (!!model.diff || !!model.base || model.view === 'sections');
  const token = `inline-flex min-w-0 max-w-full items-center gap-0.5 rounded px-1 -mx-0.5 py-0.5 font-medium text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px] hover:bg-muted hover:decoration-transparent transition-colors disabled:opacity-50 disabled:cursor-wait ${FOCUS}`;

  /* The comparison, read as one sentence. */
  const sentence = showSentence ? (
    <div className={`px-3 pt-2 ${showScopeRow ? 'pb-1.5' : 'pb-2'} text-xs leading-6 text-muted-foreground flex flex-wrap items-center gap-x-1`} data-panel-sentence>
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
  ) : null;

  /* Changes / All files and Go to File. */
  const scopeRow = showScopeRow ? (
    <div
      className={`px-2 pb-2 ${showSentence ? '' : 'pt-2'} flex items-center gap-1`}
      data-tree-scope-row
    >
      {scope && model.scope && (
        <div className="flex min-w-0 items-center gap-0.5" role="group" aria-label="Files shown in the tree">
          {(['changes', 'all'] as const).map((key) => {
            const active = scope === key;
            const count = key === 'changes' ? model.scope!.changed : model.scope!.all;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => selectScope(model, key)}
                data-tree-scope={key}
                title={key === 'changes' ? 'The files this review changes' : 'Every file of the repository at the revision the diff reads'}
                className={`min-w-0 flex items-center ${narrow ? 'gap-1 px-1.5' : 'gap-1.5 px-2'} h-6 rounded-full text-xs whitespace-nowrap transition-colors ${FOCUS} ${
                  active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="truncate">{key === 'changes' ? 'Changes' : narrow ? 'All' : 'All files'}</span>
                {count !== undefined && (
                  <span className={`tabular-nums font-mono text-[11px] ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                    {formatCount(count)}
                  </span>
                )}
                {key === 'all' && active && <LiveDot repo={model.repo} />}
              </button>
            );
          })}
        </div>
      )}
      {model.onGoToFile && (
        <span className="ml-auto flex">
          <GoToFileButton onClick={model.onGoToFile} showKeys={width >= GO_TO_FILE_KEYS_WIDTH} />
        </span>
      )}
    </div>
  ) : null;

  // The listing's state in words, for All files while it is on: a visible line
  // when only part of the repository is listed; for a live listing the
  // tooltip on the dot and a polite status region.
  const listing = scope === 'all' ? model.repo : null;
  const partialLine =
    listing && !listing.live && listing.truncated ? (
      <p className="px-3 pb-2 -mt-1 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" data-repo-listing-status="partial">
        <span className="w-1.5 h-1.5 flex-shrink-0 rounded-full border border-warning" aria-hidden="true" />
        <span>{PARTIAL_LISTING_TEXT}</span>
      </p>
    ) : null;

  return (
    <div className="flex-shrink-0" data-review-panel-header>
      {/* View tabs: text with an underline, the panel's top level. */}
      <div
        className="px-2 flex items-stretch gap-0.5 border-b border-border/50"
        style={{ height: 'var(--panel-header-h)' }}
        role={views.length > 1 ? 'group' : undefined}
        aria-label={views.length > 1 ? 'Panel view' : undefined}
      >
        {views.length === 1 ? (
          <span className="px-1 self-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Files</span>
        ) : (
          views.map((view) => {
            const active = model.view === view;
            const meta = VIEW_META[view];
            const button = (
              <button
                key={view}
                type="button"
                onClick={() => model.onSelectView(view)}
                aria-pressed={active}
                aria-label={meta.label}
                title={narrow ? undefined : meta.title}
                data-panel-view={view}
                className={`relative min-w-0 truncate px-2 text-xs transition-colors ${FOCUS} focus-visible:ring-inset focus-visible:ring-offset-0 ${
                  active ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {narrow ? (
                  <span className="flex items-center h-full">
                    <meta.Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                ) : (
                  meta.label
                )}
                {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden="true" />}
              </button>
            );
            return narrow ? (
              <Tooltip key={view} content={meta.label} side="bottom">
                {button}
              </Tooltip>
            ) : (
              button
            );
          })
        )}
      </div>

      {(showSentence || showScopeRow) && (
        <div className="border-b border-border/50">
          {sentence}
          {scopeRow}
          {partialLine}
          {scope && <LiveStatus repo={listing} />}
        </div>
      )}
    </div>
  );
};

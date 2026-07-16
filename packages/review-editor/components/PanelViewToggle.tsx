import React from 'react';

export type ReviewPanelView = 'sections' | 'commits' | 'tree';

/**
 * View switcher for the left review panel — Git status ⇄ Commits ⇄ Tree.
 * Rendered in the SAME header position in every view so the control never
 * moves under the user. Segments a session can't offer (e.g. Git status on a
 * repo with no resolvable base, Commits outside a plain git session) are
 * omitted rather than disabled; Tree is always available.
 */
export const PanelViewToggle: React.FC<{
  view: ReviewPanelView;
  onSelect: (view: ReviewPanelView) => void;
  /** Offer the Git status segment (default true). */
  showSections?: boolean;
  /** Offer the Commits segment (default false — git-local sessions opt in). */
  showCommits?: boolean;
}> = ({ view, onSelect, showSections = true, showCommits = false }) => {
  const segment = (key: ReviewPanelView, label: string, title: string) => (
    <button
      onClick={() => onSelect(key)}
      className={`px-1 py-0.5 rounded-sm text-xs leading-none whitespace-nowrap transition-colors ${
        view === key ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
      }`}
      title={title}
      aria-pressed={view === key}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center bg-muted/50 rounded p-0.5 flex-shrink-0" role="group" aria-label="Panel view">
      {showSections && segment('sections', 'Git status', 'Git status view (Committed / Changes / Untracked)')}
      {segment('tree', 'Tree', 'Tree view')}
      {showCommits && segment('commits', 'Commits', 'Commit history — click a commit to review its diff')}
    </div>
  );
};

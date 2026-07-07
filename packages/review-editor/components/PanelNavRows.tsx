import React from 'react';

/**
 * Nav rows shared by the left panel's two views (FileTree, SectionsPanel).
 * One source so the rows render identically — same order, same icons, same
 * counts — in both views.
 */

/** Shared shell for the panel action rows (PR overview, Semantic diff, All files). */
export function SidebarActionRow({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors mb-0.5 ${
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

export function SemanticDiffRow({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <SidebarActionRow active={active} onClick={onClick}>
      <span className="w-3.5 h-3.5 flex flex-shrink-0 items-center justify-center" aria-hidden="true">∆</span>
      <span>Semantic diff</span>
    </SidebarActionRow>
  );
}

export function AllFilesRow({
  active,
  onClick,
  additions,
  deletions,
  afterLabel,
}: {
  active: boolean;
  onClick: () => void;
  additions: number;
  deletions: number;
  /** Optional control rendered right after the label (e.g. the tree view's
   * expand/collapse-all-folders toggle). */
  afterLabel?: React.ReactNode;
}) {
  return (
    <SidebarActionRow active={active} onClick={onClick}>
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.878V6a2.25 2.25 0 012.25-2.25h7.5A2.25 2.25 0 0118 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 004.5 9v.878m13.5-3A2.25 2.25 0 0119.5 9v.878m-13.5 0A2.25 2.25 0 003 12v3a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 15v-3a2.25 2.25 0 00-2.25-2.25m-13.5 0h13.5" />
      </svg>
      <span>All files</span>
      {afterLabel}
      <span className="ml-auto text-[10px] tabular-nums opacity-60">
        <span className="text-green-500">+{additions}</span>{' '}
        <span className="text-red-500">-{deletions}</span>
      </span>
    </SidebarActionRow>
  );
}


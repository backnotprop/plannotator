import React from 'react';
import { useDiffCountColors } from '../hooks/useDiffCountColors';

/**
 * Nav rows shared by the left panel's two views (FileTree, SectionsPanel).
 * One source so the rows render identically — same order, same icons, same
 * counts — in both views.
 */

/** Shared shell for the panel action rows (PR overview, Semantic diff, All changes). */
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

export function CallFlowRow({
  active,
  onClick,
  count,
  loading,
  error,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <SidebarActionRow
      active={active}
      onClick={onClick}
      title={error ? 'Call flow setup needs attention' : 'Trace how changed calls affect entry paths'}
    >
      <span className="w-3.5 h-3.5 flex flex-shrink-0 items-center justify-center font-mono" aria-hidden="true">⑂</span>
      <span>Call flow</span>
      <span
        className={`ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] tabular-nums ${error ? 'text-warning' : 'text-muted-foreground'}`}
      >
        {error ? (
          <><span aria-hidden="true">!</span><span className="sr-only">Call flow setup needs attention</span></>
        ) : loading ? (
          <><span aria-hidden="true">…</span><span className="sr-only">Call flow setup in progress</span></>
        ) : count ?? '—'}
      </span>
    </SidebarActionRow>
  );
}

/**
 * Opens every change of the review in one scrolling view. Named "All changes"
 * so it never reads as the "All files" scope (the whole repository) in the
 * header above it. The +/- counts keep 4.5:1 on every surface of the row in
 * every palette (`useDiffCountColors`).
 */
export function AllChangesRow({
  active,
  onClick,
  additions,
  deletions,
}: {
  active: boolean;
  onClick: () => void;
  additions: number;
  deletions: number;
}) {
  const colors = useDiffCountColors();
  return (
    <SidebarActionRow active={active} onClick={onClick} title="Every change of this review in one view">
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.878V6a2.25 2.25 0 012.25-2.25h7.5A2.25 2.25 0 0118 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 004.5 9v.878m13.5-3A2.25 2.25 0 0119.5 9v.878m-13.5 0A2.25 2.25 0 003 12v3a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 15v-3a2.25 2.25 0 00-2.25-2.25m-13.5 0h13.5" />
      </svg>
      <span className="min-w-0 truncate">All changes</span>
      <span className="ml-auto flex-shrink-0 whitespace-nowrap text-[10px] tabular-nums font-normal" data-all-changes-counts>
        <span className={colors ? undefined : 'text-success'} style={colors ? { color: colors.additions } : undefined}>
          +{additions}
        </span>{' '}
        <span className={colors ? undefined : 'text-destructive'} style={colors ? { color: colors.deletions } : undefined}>
          -{deletions}
        </span>
      </span>
    </SidebarActionRow>
  );
}

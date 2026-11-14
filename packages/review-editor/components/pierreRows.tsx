import React from 'react';
import type { FileTreeRowPart, FileTreeRowParts, GitStatusEntry } from '@pierre/trees';
import type { DiffFile } from '../types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { useReviewStateOptional } from '../dock/ReviewStateContext';

export interface SectionEntry {
  group: 'committed' | 'changes' | 'untracked';
  staged: boolean;
}

export interface FileRowState {
  viewedFiles: ReadonlySet<string>;
  showViewedControls: boolean;
  stagedFiles: ReadonlySet<string>;
  stagingFile?: string | null;
  onStageFile?: (path: string) => void;
  getSectionEntry?: (path: string) => SectionEntry | undefined;
  annotationCounts: ReadonlyMap<string, number>;
  markdownPreviewedPaths?: ReadonlySet<string>;
  threadCount?: (path: string) => number;
}

export const ROW_ICONS = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<symbol id="pn-stage-plus" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-viewed-off" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.25"/></symbol>
<symbol id="pn-viewed-on" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-staged-dot" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" fill="currentColor"/></symbol>
<symbol id="pn-thread" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-code" viewBox="0 0 24 24"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-test" viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-generated" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-docs" viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
</svg>`;

const icon = (name: string, size: number) => ({ name, width: size, height: size, viewBox: '0 0 24 24' });
const STAGE_ICON = icon('pn-stage-plus', 10);
const UNVIEWED_ICON = icon('pn-viewed-off', 12);
const VIEWED_ICON = icon('pn-viewed-on', 14);
const STAGED_ICON = icon('pn-staged-dot', 14);
const EYE_ICON = icon('pn-eye', 12);
const THREAD_ICON = icon('pn-thread', 12);

export const GROUP_ICONS: Record<string, FileTreeRowPart> = {
  code: { icon: icon('pn-kind-code', 12) },
  test: { icon: icon('pn-kind-test', 12) },
  docs: { icon: icon('pn-kind-docs', 12) },
  generated: { icon: icon('pn-kind-generated', 12) },
};

const GIT_STATUS: Record<string, GitStatusEntry['status']> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
  binary: 'modified',
};

export function gitStatusFor(file: DiffFile, getSectionEntry?: (path: string) => SectionEntry | undefined): GitStatusEntry['status'] {
  if (getSectionEntry?.(file.path)?.group === 'untracked') return 'untracked';
  return GIT_STATUS[file.status] ?? 'modified';
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

export function countParts(additions: number, deletions: number, quiet: boolean): (FileTreeRowPart | null)[] {
  return [
    additions > 0 ? { text: `+${additions}`, color: quiet ? undefined : 'var(--success)' } : null,
    deletions > 0 ? { text: `-${deletions}`, color: quiet ? undefined : 'var(--destructive)' } : null,
  ];
}

export function stageColumnShown(state: Pick<FileRowState, 'getSectionEntry' | 'stagedFiles'>, showStageControls: boolean): boolean {
  return showStageControls && (state.getSectionEntry != null || state.stagedFiles.size > 0);
}

export function countColumns(widestAdd: number, widestDel: number, withBadge: boolean): string {
  const col = (n: number) => `minmax(calc(${String(n).length + 1}ch + 2px), max-content)`;
  return `${withBadge ? 'max-content ' : ''}${col(widestAdd)} ${col(widestDel)}`;
}

export function withoutBadge(parts: FileTreeRowParts | null, withBadge: boolean): FileTreeRowParts | null {
  if (withBadge || !parts?.trail) return parts;
  return { ...parts, trail: parts.trail.slice(1) };
}

export function hasBadge(file: DiffFile, p: FileRowState): boolean {
  return (p.annotationCounts.get(file.path) ?? 0) > 0 || (p.threadCount?.(file.path) ?? 0) > 0 || !!p.markdownPreviewedPaths?.has(file.path);
}

export function fileRowParts(file: DiffFile, p: FileRowState, withStage: boolean): FileTreeRowParts {
  const isViewed = p.viewedFiles.has(file.path);
  const isStaged = p.stagedFiles.has(file.path);
  const section = p.getSectionEntry?.(file.path);
  const sinceBase = p.getSectionEntry != null;
  const stageable = sinceBase && !!p.onStageFile && section != null && section.group !== 'committed';
  const lead: (FileTreeRowPart | null)[] = [];
  if (p.showViewedControls) {
    lead.push({
      id: 'viewed',
      icon: isViewed ? VIEWED_ICON : UNVIEWED_ICON,
      pressed: isViewed,
      label: isViewed ? `${file.path}: viewed, unmark` : `Mark ${file.path} as viewed`,
      title: isViewed ? 'Viewed, click to unmark' : 'Mark as viewed',
    });
  }
  if (withStage) {
    if (p.stagingFile === file.path) lead.push({ id: 'staging', text: '…', disabled: true, title: 'Staging' });
    else if (isStaged && stageable) lead.push({ id: 'unstage', icon: STAGED_ICON, label: `Unstage ${file.path}`, title: 'Staged, click to unstage' });
    else if (isStaged) lead.push({ id: 'staged', icon: STAGED_ICON, disabled: true, title: 'Staged (git add)' });
    else if (stageable) lead.push({ id: 'stage', icon: STAGE_ICON, label: `Stage ${file.path}`, title: 'Stage file (git add)' });
    else lead.push(null);
  }
  const notes = p.annotationCounts.get(file.path) ?? 0;
  const previewed = p.markdownPreviewedPaths?.has(file.path);
  const threads = p.threadCount?.(file.path) ?? 0;
  return {
    muted: isViewed && p.showViewedControls,
    title: file.oldPath ? `${file.path} (renamed from ${file.oldPath})` : file.path,
    lead,
    trail: [
      threads > 0
        ? { icon: THREAD_ICON, text: String(threads), title: `${threads} open ${threads === 1 ? 'thread' : 'threads'}` }
        : notes > 0
          ? { text: String(notes), title: `${notes} annotation${notes === 1 ? '' : 's'}`, color: 'var(--primary)' }
          : previewed
            ? { icon: EYE_ICON, title: 'Shown rendered' }
            : null,
      ...countParts(file.additions, file.deletions, false),
    ],
  };
}

export const TreeRowMenu: React.FC<{
  path: string;
  repoRoot?: string | null;
  close: () => void;
  anchor: { left: number; bottom: number };
}> = ({ path, repoRoot, close, anchor }) => {
  const name = path.split('/').pop() ?? path;
  const openToSide = useReviewStateOptional()?.onOpenToSide;
  const choose = (text: string) => {
    void copyTextToClipboard(text);
    close();
  };
  return (
    <div role="menu" className="review-tree-menu" style={{ position: 'fixed', left: anchor.left, top: anchor.bottom }}>
      {openToSide && (
        <button
          type="button"
          role="menuitem"
          data-tree-open-to-side=""
          onClick={() => {
            openToSide(path);
            close();
          }}
        >
          Open to the side
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => choose(path)}>Copy path</button>
      <button type="button" role="menuitem" onClick={() => choose(name)}>Copy filename</button>
      {repoRoot && (
        <button type="button" role="menuitem" onClick={() => choose(`${repoRoot.replace(/\/$/, '')}/${path}`)}>
          Copy full path
        </button>
      )}
    </div>
  );
};

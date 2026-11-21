import React from 'react';
import { plural, shortCount } from '@plannotator/ui/utils/countFormat';
import type { FileTreeRowPart, FileTreeRowParts, GitStatusEntry } from '@pierre/trees';
import type { DiffFile } from '../types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { useReviewStateOptional } from '../dock/ReviewStateContext';

interface SectionEntry {
  group: 'committed' | 'changes' | 'untracked';
  staged: boolean;
}

export interface FileRowState {
  viewedFiles: ReadonlySet<string>;
  showViewedControls: boolean;
  getSectionEntry?: (path: string) => SectionEntry | undefined;
  annotationCounts: ReadonlyMap<string, number>;
  markdownPreviewedPaths?: ReadonlySet<string>;
  threadCount?: (path: string) => number;
}

export const ROW_ICONS = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<symbol id="pn-thread" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-code" viewBox="0 0 24 24"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-test" viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-generated" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-docs" viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
</svg>`;

const icon = (name: string, size: number) => ({ name, width: size, height: size, viewBox: '0 0 24 24' });
const EYE_ICON = icon('pn-eye', 12);
const THREAD_ICON = icon('pn-thread', 12);

export const GROUP_ICONS: Record<string, FileTreeRowPart> = {
  code: { icon: icon('pn-kind-code', 14) },
  test: { icon: icon('pn-kind-test', 14) },
  docs: { icon: icon('pn-kind-docs', 14) },
  generated: { icon: icon('pn-kind-generated', 14) },
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

export function countParts(additions: number, deletions: number): FileTreeRowPart[] {
  const parts: FileTreeRowPart[] = [];
  if (additions > 0) parts.push({ text: `+${shortCount(additions)}`, title: `${plural(additions, 'line')} added`, color: 'var(--success)' });
  if (deletions > 0) parts.push({ text: `−${shortCount(deletions)}`, title: `${plural(deletions, 'line')} removed`, color: 'var(--destructive)' });
  return parts;
}

export function folderLineCounts(files: readonly DiffFile[]): Map<string, { additions: number; deletions: number }> {
  const out = new Map<string, { additions: number; deletions: number }>();
  for (const file of files) {
    for (const dir of ancestorsOf(file.path)) {
      const counts = out.get(dir) ?? { additions: 0, deletions: 0 };
      counts.additions += file.additions;
      counts.deletions += file.deletions;
      out.set(dir, counts);
    }
  }
  return out;
}

export function notePart(path: string, p: FileRowState): FileTreeRowPart | null {
  const threads = p.threadCount?.(path) ?? 0;
  if (threads > 0) return { icon: THREAD_ICON, text: shortCount(threads), title: plural(threads, 'open thread') };
  const notes = p.annotationCounts.get(path) ?? 0;
  if (notes > 0) return { text: shortCount(notes), title: plural(notes, 'comment'), color: 'var(--primary)' };
  if (p.markdownPreviewedPaths?.has(path)) return { icon: EYE_ICON, title: 'Shown rendered' };
  return null;
}

export function fileRowParts(file: DiffFile, p: FileRowState, mark: FileTreeRowPart | null = notePart(file.path, p)): FileTreeRowParts {
  return {
    muted: p.showViewedControls && p.viewedFiles.has(file.path),
    title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
    trail: [...(mark ? [mark] : []), ...countParts(file.additions, file.deletions)],
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

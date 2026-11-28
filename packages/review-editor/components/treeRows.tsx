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
  /** The effective staged set (`useGitAdd`'s `stagedFiles`); absent: rows draw no Staged mark. */
  stagedFiles?: ReadonlySet<string>;
  getSectionEntry?: (path: string) => SectionEntry | undefined;
  annotationCounts: ReadonlyMap<string, number>;
  markdownPreviewedPaths?: ReadonlySet<string>;
  threadCount?: (path: string) => number;
  /**
   * A host's mark before a file's icon (the Inbox's PR page: the risk bars, `RISK_BARS_PARTS`). Its `label` is added to
   * the row's title, the row's only description a screen reader reads. Absent: no lead, as before.
   */
  fileLead?: (path: string) => FileTreeRowPart | null;
}

export const ROW_ICONS = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<symbol id="pn-thread" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-code" viewBox="0 0 24 24"><path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-test" viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-generated" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-kind-docs" viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="pn-risk-high" viewBox="0 0 10 12"><g fill="currentColor" shape-rendering="crispEdges"><rect x="0" y="6" width="2" height="6"/><rect x="4" y="3" width="2" height="9"/><rect x="8" y="0" width="2" height="12"/></g></symbol>
<symbol id="pn-risk-medium" viewBox="0 0 10 12"><g fill="currentColor" shape-rendering="crispEdges"><rect x="0" y="6" width="2" height="6"/><rect x="4" y="3" width="2" height="9"/><rect x="8" y="0" width="2" height="12" fill-opacity=".3"/></g></symbol>
<symbol id="pn-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
</svg>`;

const icon = (name: string, size: number) => ({ name, width: size, height: size, viewBox: '0 0 24 24' });
const EYE_ICON = icon('pn-eye', 12);
const THREAD_ICON = icon('pn-thread', 12);
/**
 * A mark, not a button (staging is done from the file's header or the A key);
 * drawn as All files draws its on-disk dot. Its hover title is its only text
 * alternative: the row is a `treeitem` named by the file name, so an
 * `aria-label` on this role-less span would never be read.
 */
const STAGED_PART: FileTreeRowPart = { text: '\u25cf', title: 'Staged', color: 'var(--primary)' };

/**
 * The risk bars before a file's icon (approval "review-risk-bars"): three bars 2px wide, 2px apart, 6, 9 and 12px
 * tall, all filled for High, two for Medium (the third faint), in `currentColor`: the host gives the part its `color`
 * (the Inbox's orange-red, `useRiskLead`). A mark, not a button (`disabled`, so the lane draws no button); its `label`
 * goes into the row's title. Laid out over the indent left of the icon (`treeLook`), so no row moves. The diff's mark
 * (the Inbox's riskBarsMarks.ts) draws the same bars.
 */
const RISK_ICON = { width: 10, height: 12, viewBox: '0 0 10 12' };
export const RISK_BARS_PARTS: Record<'high' | 'medium', FileTreeRowPart> = {
  high: { id: 'risk', disabled: true, icon: { name: 'pn-risk-high', ...RISK_ICON }, title: 'High risk', label: 'High risk' },
  medium: { id: 'risk', disabled: true, icon: { name: 'pn-risk-medium', ...RISK_ICON }, title: 'Medium risk', label: 'Medium risk' },
};

/**
 * Whether a host's lead marks a file at the tree's root (no folder row above it): there the indent left of the icon is
 * only the row's padding, so the tree makes room for the mark (treeLook's `data-lead-room`).
 */
export function leadAtRoot(rootFiles: Iterable<string>, fileLead: FileRowState['fileLead']): boolean {
  if (!fileLead) return false;
  for (const path of rootFiles) if (fileLead(path)) return true;
  return false;
}

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
  const lead = p.fileLead?.(file.path) ?? null;
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return {
    muted: p.showViewedControls && p.viewedFiles.has(file.path),
    title: lead?.label ? `${title} · ${lead.label}` : title,
    ...(lead ? { lead: [lead] } : {}),
    trail: [
      ...(mark ? [mark] : []),
      ...(p.stagedFiles?.has(file.path) ? [STAGED_PART] : []),
      ...countParts(file.additions, file.deletions),
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

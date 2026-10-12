import { useCallback, useMemo, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { useReviewMarkdownPreviewShortcuts } from '@plannotator/ui/shortcuts';
import { isTypingTarget } from './useReviewSearch';
import type { DiffFile } from '../types';
import {
  isMarkdownPreviewFile,
  markdownViewsFor,
  nextMarkdownView,
  parseMarkdownFileView,
  resolveMarkdownView,
  type MarkdownFileView,
} from '../utils/markdownPreview';

export type { MarkdownFileView } from '../utils/markdownPreview';

/**
 * The view Markdown files start in, remembered across reviews in a cookie
 * (cookie-only, never a server config write). Deliberately not a
 * settings-registry entry: the registry is bundled into the portable
 * guides.show viewer.
 */
export const MARKDOWN_VIEW_COOKIE = 'plannotator-markdown-view';
/** The earlier "Preview .md" switch: `true` reads once as Changes. */
export const LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE = 'plannotator-markdown-preview-all';

/**
 * The remembered starting view. An old "Preview .md" cookie that was on is
 * carried over as Changes (and rewritten under the new name) the first time.
 */
export function readStartingMarkdownView(): MarkdownFileView {
  const remembered = parseMarkdownFileView(storage.getItem(MARKDOWN_VIEW_COOKIE));
  if (remembered) return remembered;
  const legacy = storage.getItem(LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE);
  if (legacy === null) return 'source';
  const migrated: MarkdownFileView = legacy === 'true' ? 'changes' : 'source';
  writeStartingMarkdownView(migrated);
  return migrated;
}

function writeStartingMarkdownView(view: MarkdownFileView): void {
  storage.setItem(MARKDOWN_VIEW_COOKIE, view);
  storage.removeItem(LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE);
}

/** Which rendered view a previewed file shows: the rendered diff or the whole document. */
export type MarkdownPreviewView = 'diff' | 'whole';

export function renderedViewOf(view: MarkdownFileView): MarkdownPreviewView {
  return view === 'read' ? 'whole' : 'diff';
}

/** The file view a comment made in a rendered view lives in. */
export function fileViewOfRendered(view: MarkdownPreviewView): MarkdownFileView {
  return view === 'whole' ? 'read' : 'changes';
}

/**
 * Everything the review surfaces need to know about Markdown views. Absent
 * from review state when the server did not advertise
 * `markdownPreviewSupported` (or has no full file contents to show), so no
 * view control renders at all.
 */
export interface MarkdownPreviewController {
  /** True when this file offers rendered views (by name; before any fetch). */
  isPreviewable: (file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) => boolean;
  /** The views this file offers (added / deleted: Source and Read). */
  viewsFor: (file: Pick<DiffFile, 'status' | 'patch'>) => readonly MarkdownFileView[];
  /** The view a file shows: its own when set by hand, else the starting view. */
  viewOf: (path: string) => MarkdownFileView;
  /** True when the file shows a rendered view (Changes or Read). */
  isPreviewed: (path: string) => boolean;
  /**
   * The person picked a view for a file (the header menu, `P`): the file
   * keeps it, and it becomes the starting view for every Markdown file not
   * set by hand, in this review and the next.
   */
  choose: (path: string, view: MarkdownFileView) => void;
  /**
   * Navigation needs a view (a search hit in Source, a comment that lives in
   * a rendered view): this file only, nothing remembered.
   */
  show: (path: string, view: MarkdownFileView) => void;
  /** `P`: the next view of this file (Source -> Changes -> Read -> Source). */
  cycle: (path: string) => void;
  /** The view files not set by hand start in. */
  startingView: MarkdownFileView;
  /** Whether this review has any Markdown file. */
  hasMarkdownFiles: boolean;
  /** Paths of the review's files currently shown rendered. */
  previewedPaths: ReadonlySet<string>;
}

/**
 * Per-file views set by hand live for the session; the starting view for
 * everything else is the last view the person picked, remembered (cookie).
 */
export function useMarkdownPreview(options: {
  files: readonly DiffFile[];
  /** Server advert AND full file contents behind the diff. */
  supported: boolean;
}): MarkdownPreviewController | undefined {
  const { files, supported } = options;
  const [startingView, setStartingView] = useState<MarkdownFileView>(() => readStartingMarkdownView());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, MarkdownFileView>>(() => new Map());

  // Markdown files by path (the first, for a duplicate display path).
  const markdownFiles = useMemo(() => {
    const map = new Map<string, DiffFile>();
    for (const file of files) {
      if (!map.has(file.path) && isMarkdownPreviewFile(file)) map.set(file.path, file);
    }
    return map;
  }, [files]);

  const viewOf = useCallback((path: string): MarkdownFileView => {
    const file = markdownFiles.get(path);
    if (!file) return 'source';
    return resolveMarkdownView(overrides.get(path) ?? startingView, markdownViewsFor(file));
  }, [markdownFiles, overrides, startingView]);

  const setOverride = useCallback((path: string, view: MarkdownFileView) => {
    setOverrides((current) => {
      if (current.get(path) === view) return current;
      const next = new Map(current);
      next.set(path, view);
      return next;
    });
  }, []);

  const choose = useCallback((path: string, view: MarkdownFileView) => {
    setOverride(path, view);
    setStartingView(view);
    writeStartingMarkdownView(view);
  }, [setOverride]);

  const cycle = useCallback((path: string) => {
    const file = markdownFiles.get(path);
    if (!file) return;
    choose(path, nextMarkdownView(viewOf(path), markdownViewsFor(file)));
  }, [markdownFiles, viewOf, choose]);

  const previewedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const path of markdownFiles.keys()) {
      if (viewOf(path) !== 'source') set.add(path);
    }
    return set;
  }, [markdownFiles, viewOf]);

  const isPreviewed = useCallback((path: string) => previewedPaths.has(path), [previewedPaths]);
  const isPreviewable = useCallback(
    (file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) => isMarkdownPreviewFile(file),
    [],
  );

  return useMemo(
    () => (supported
      ? {
          isPreviewable,
          viewsFor: markdownViewsFor,
          viewOf,
          isPreviewed,
          choose,
          show: setOverride,
          cycle,
          startingView,
          hasMarkdownFiles: markdownFiles.size > 0,
          previewedPaths,
        }
      : undefined),
    [supported, isPreviewable, viewOf, isPreviewed, choose, setOverride, cycle, startingView, markdownFiles, previewedPaths],
  );
}

/**
 * `P` shows the current Markdown file in its next view (Source -> Changes ->
 * Read). Never while typing, while the surface is not a diff, or for a file
 * that is not Markdown.
 */
export function useMarkdownPreviewKeys(options: {
  controller: MarkdownPreviewController | undefined;
  /** The file `P` acts on: the open file, or the one at the top of All files. */
  targetPath: string | null;
  files: readonly DiffFile[];
  /** False while the surface on screen is not a diff (the guide, a panel). */
  enabled: boolean;
}): void {
  const { controller, targetPath, files, enabled } = options;
  useReviewMarkdownPreviewShortcuts({
    handlers: {
      cycleMarkdownView: {
        when: (event) => {
          if (!controller || !enabled || event.defaultPrevented || isTypingTarget(event.target) || !targetPath) return false;
          const file = files.find((candidate) => candidate.path === targetPath);
          return !!file && controller.isPreviewable(file);
        },
        handle: (event) => {
          event.preventDefault();
          if (targetPath) controller?.cycle(targetPath);
        },
      },
    },
  });
}

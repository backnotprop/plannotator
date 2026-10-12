import { useCallback, useMemo, useRef, useState } from 'react';
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

/** Why a file's view cannot change while it holds the edit session. */
export const MARKDOWN_VIEW_EDITING_REASON = 'Finish editing first';

/**
 * True when a key event comes from somewhere the person types. Reads
 * composedPath()[0]: at window level `event.target` is retargeted to a shadow
 * host, so a keystroke in the Pierre editor's contenteditable (edit sessions)
 * would otherwise look like a key pressed on the page.
 */
export function isTypingKeyEvent(event: KeyboardEvent): boolean {
  const origin = (event.composedPath?.()[0] ?? event.target) as EventTarget | null;
  return isTypingTarget(origin) || (origin as HTMLElement | null)?.tagName === 'SELECT';
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
   * a rendered view): this file only, nothing remembered. Like a pick, it
   * pins the file: it keeps that view when a later pick moves the others.
   */
  show: (path: string, view: MarkdownFileView) => void;
  /** Why this file's view cannot change right now (it holds the edit session), else null. */
  lockReason: (path: string) => string | null;
  /** The file the edit session holds (All files), or null: its view is locked. */
  setEditingFile: (path: string | null) => void;
  /**
   * All files registers how to find the Markdown file `P` should act on (the
   * file under focus or the pointer, else the top-most Markdown file in view).
   */
  registerViewTarget: (resolve: (() => string | null) | null) => void;
  resolveViewTarget: () => string | null;
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
  const [editingFile, setEditingFileState] = useState<string | null>(null);
  const viewTargetRef = useRef<(() => string | null) | null>(null);
  const lockReason = useCallback(
    (path: string) => (editingFile !== null && path === editingFile ? MARKDOWN_VIEW_EDITING_REASON : null),
    [editingFile],
  );

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
  const viewOfRef = useRef(viewOf);
  viewOfRef.current = viewOf;

  // Locking a file pins the view it shows now, so a pick on another file
  // (which moves every file not set by hand) cannot move it mid-edit.
  const setEditingFile = useCallback((path: string | null) => {
    if (path !== null && markdownFiles.has(path)) {
      const pinned = viewOfRef.current(path);
      setOverrides((current) => {
        if (current.get(path) === pinned) return current;
        const next = new Map(current);
        next.set(path, pinned);
        return next;
      });
    }
    setEditingFileState(path);
  }, [markdownFiles]);

  const setOverride = useCallback((path: string, view: MarkdownFileView) => {
    if (lockReason(path)) return;
    setOverrides((current) => {
      if (current.get(path) === view) return current;
      const next = new Map(current);
      next.set(path, view);
      return next;
    });
  }, [lockReason]);

  const choose = useCallback((path: string, view: MarkdownFileView) => {
    if (lockReason(path)) return;
    setOverride(path, view);
    setStartingView(view);
    writeStartingMarkdownView(view);
  }, [setOverride, lockReason]);

  const registerViewTarget = useCallback((resolve: (() => string | null) | null) => {
    viewTargetRef.current = resolve;
  }, []);
  const resolveViewTarget = useCallback(() => viewTargetRef.current?.() ?? null, []);

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
          lockReason,
          setEditingFile,
          registerViewTarget,
          resolveViewTarget,
          cycle,
          startingView,
          hasMarkdownFiles: markdownFiles.size > 0,
          previewedPaths,
        }
      : undefined),
    [supported, isPreviewable, viewOf, isPreviewed, choose, setOverride, lockReason, setEditingFile, registerViewTarget, resolveViewTarget, cycle, startingView, markdownFiles, previewedPaths],
  );
}

/**
 * `P` shows the current Markdown file in its next view (Source -> Changes ->
 * Read). Never while typing, while the surface is not a diff, or for a file
 * that is not Markdown.
 */
export function useMarkdownPreviewKeys(options: {
  controller: MarkdownPreviewController | undefined;
  /** The file `P` acts on: the open file, or (a resolver, read at key time) the
   *  Markdown file the person is looking at in All files. */
  targetPath: string | null | (() => string | null);
  files: readonly DiffFile[];
  /** False while the surface on screen is not a diff (the guide, a panel). */
  enabled: boolean;
  /** `P` on a file whose view is locked (it holds the edit session): say why. */
  onLocked?: (reason: string) => void;
}): void {
  const { controller, targetPath, files, enabled, onLocked } = options;
  useReviewMarkdownPreviewShortcuts({
    handlers: {
      cycleMarkdownView: {
        when: (event) => {
          if (!controller || !enabled || event.defaultPrevented || isTypingKeyEvent(event)) return false;
          const path = typeof targetPath === 'function' ? targetPath() : targetPath;
          if (!path) return false;
          const file = files.find((candidate) => candidate.path === path);
          return !!file && controller.isPreviewable(file);
        },
        handle: (event) => {
          event.preventDefault();
          const path = typeof targetPath === 'function' ? targetPath() : targetPath;
          if (!path || !controller) return;
          const locked = controller.lockReason(path);
          if (locked) onLocked?.(locked);
          else controller.cycle(path);
        },
      },
    },
  });
}

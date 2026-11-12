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

export const MARKDOWN_VIEW_COOKIE = 'plannotator-markdown-view';
export const LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE = 'plannotator-markdown-preview-all';

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

/** Reads composedPath()[0]: at window level `target` is retargeted to a shadow host, hiding the Pierre editor's contenteditable. */
export function isTypingKeyEvent(event: KeyboardEvent): boolean {
  const origin = (event.composedPath?.()[0] ?? event.target) as EventTarget | null;
  return isTypingTarget(origin) || (origin as HTMLElement | null)?.tagName === 'SELECT';
}

export type MarkdownPreviewView = 'diff' | 'whole';

export function renderedViewOf(view: MarkdownFileView): MarkdownPreviewView {
  return view === 'read' ? 'whole' : 'diff';
}

export function fileViewOfRendered(view: MarkdownPreviewView): MarkdownFileView {
  return view === 'whole' ? 'read' : 'changes';
}

export interface MarkdownPreviewController {
  isPreviewable: (file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) => boolean;
  viewsFor: (file: Pick<DiffFile, 'status' | 'patch'>) => readonly MarkdownFileView[];
  viewOf: (path: string) => MarkdownFileView;
  isPreviewed: (path: string) => boolean;
  choose: (path: string, view: MarkdownFileView) => void;
  show: (path: string, view: MarkdownFileView) => void;
  /** Why this file's view cannot change right now (it holds the edit session), else null. */
  lockReason: (path: string) => string | null;
  setEditingFile: (path: string | null) => void;
  registerViewTarget: (resolve: (() => string | null) | null) => void;
  resolveViewTarget: () => string | null;
  cycle: (path: string) => void;
  startingView: MarkdownFileView;
  hasMarkdownFiles: boolean;
  previewedPaths: ReadonlySet<string>;
}

export function useMarkdownPreview(options: {
  files: readonly DiffFile[];
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

export function useMarkdownPreviewKeys(options: {
  controller: MarkdownPreviewController | undefined;
  targetPath: string | null | (() => string | null);
  files: readonly DiffFile[];
  enabled: boolean;
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

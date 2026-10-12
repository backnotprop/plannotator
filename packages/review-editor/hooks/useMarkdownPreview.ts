import { useCallback, useMemo, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { useReviewMarkdownPreviewShortcuts } from '@plannotator/ui/shortcuts';
import { isTypingTarget } from './useReviewSearch';
import type { DiffFile } from '../types';
import { isMarkdownPreviewFile, isMarkdownPreviewOn } from '../utils/markdownPreview';

/**
 * The "Preview .md" switch, remembered across reviews in a cookie (cookie-only,
 * never a server config write). Deliberately not a settings-registry entry:
 * the registry is bundled into the portable guides.show viewer.
 */
export const MARKDOWN_PREVIEW_ALL_COOKIE = 'plannotator-markdown-preview-all';

export function readMarkdownPreviewAll(): boolean {
  return storage.getItem(MARKDOWN_PREVIEW_ALL_COOKIE) === 'true';
}

function writeMarkdownPreviewAll(on: boolean): void {
  storage.setItem(MARKDOWN_PREVIEW_ALL_COOKIE, String(on));
}

/** Which view a previewed file shows: the rendered diff or the whole new version. */
export type MarkdownPreviewView = 'diff' | 'whole';

/**
 * Everything the review surfaces need to know about Markdown previews. Absent
 * from review state when the server did not advertise `markdownPreviewSupported`
 * (or has no full file contents to show), so no preview UI renders at all.
 */
export interface MarkdownPreviewController {
  /** True when this file offers a preview (by name; before any fetch). */
  isPreviewable: (file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) => boolean;
  /** The file's effective state: its own choice, else the switch for all. */
  isPreviewed: (path: string) => boolean;
  setFilePreview: (path: string, on: boolean) => void;
  toggleFile: (path: string) => void;
  /** The "Preview .md" switch (every Markdown file). */
  all: boolean;
  /** Press the switch: flips it and resets every file to it. */
  toggleAll: () => void;
  /** Whether this review has any Markdown file (the switch hides otherwise). */
  hasMarkdownFiles: boolean;
  /** Paths of the review's files currently shown as a preview. */
  previewedPaths: ReadonlySet<string>;
  /** Rendered diff or whole new version, remembered for the session. */
  view: MarkdownPreviewView;
  setView: (view: MarkdownPreviewView) => void;
}

/**
 * Per-file preview choices live for the session; the switch for every
 * Markdown file is remembered (cookie). A file's own choice wins until the
 * switch is pressed again, which resets every file to it.
 */
export function useMarkdownPreview(options: {
  files: readonly DiffFile[];
  /** Server advert AND full file contents behind the diff. */
  supported: boolean;
}): MarkdownPreviewController | undefined {
  const { files, supported } = options;
  const [all, setAll] = useState<boolean>(() => readMarkdownPreviewAll());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [view, setView] = useState<MarkdownPreviewView>('diff');

  const markdownPaths = useMemo(
    () => new Set(files.filter((file) => isMarkdownPreviewFile(file)).map((file) => file.path)),
    [files],
  );

  const isPreviewed = useCallback(
    (path: string) => markdownPaths.has(path) && isMarkdownPreviewOn(path, overrides, all),
    [markdownPaths, overrides, all],
  );

  const setFilePreview = useCallback((path: string, on: boolean) => {
    setOverrides((current) => {
      if (current.get(path) === on) return current;
      const next = new Map(current);
      next.set(path, on);
      return next;
    });
  }, []);

  const toggleFile = useCallback((path: string) => {
    setFilePreview(path, !isMarkdownPreviewOn(path, overrides, all));
  }, [overrides, all, setFilePreview]);

  const toggleAll = useCallback(() => {
    setAll((current) => {
      const next = !current;
      writeMarkdownPreviewAll(next);
      return next;
    });
    setOverrides(new Map());
  }, []);

  const previewedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const path of markdownPaths) {
      if (isMarkdownPreviewOn(path, overrides, all)) set.add(path);
    }
    return set;
  }, [markdownPaths, overrides, all]);

  const isPreviewable = useCallback(
    (file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>) => isMarkdownPreviewFile(file),
    [],
  );

  return useMemo(
    () => (supported
      ? {
          isPreviewable,
          isPreviewed,
          setFilePreview,
          toggleFile,
          all,
          toggleAll,
          hasMarkdownFiles: markdownPaths.size > 0,
          previewedPaths,
          view,
          setView,
        }
      : undefined),
    [supported, isPreviewable, isPreviewed, setFilePreview, toggleFile, all, toggleAll, markdownPaths, previewedPaths, view],
  );
}

/**
 * `P` switches the current Markdown file between Source and Preview;
 * `Shift+P` presses the "Preview .md" switch. Never while typing, while the
 * surface is not a diff, or for a file that is not Markdown.
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
  const usable = (event: KeyboardEvent) =>
    !!controller && enabled && !event.defaultPrevented && !isTypingTarget(event.target);
  useReviewMarkdownPreviewShortcuts({
    handlers: {
      toggleFilePreview: {
        when: (event) => {
          if (!usable(event) || !targetPath) return false;
          const file = files.find((candidate) => candidate.path === targetPath);
          return !!file && !!controller?.isPreviewable(file);
        },
        handle: (event) => {
          event.preventDefault();
          if (targetPath) controller?.toggleFile(targetPath);
        },
      },
      toggleAllPreviews: {
        when: (event) => usable(event) && !!controller?.hasMarkdownFiles,
        handle: (event) => {
          event.preventDefault();
          controller?.toggleAll();
        },
      },
    },
  });
}

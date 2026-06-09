import React, { useMemo, useRef } from 'react';
import { getSingularPatch } from '@pierre/diffs';
import type { CodeViewItem, CodeViewOptions } from '@pierre/diffs';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { usePierreTheme } from '../hooks/usePierreTheme';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder } from '../utils/buildFileTree';

/**
 * AllFilesCodeView (migration phase P1)
 *
 * Renders every changed file through ONE Pierre `CodeView` inside a single
 * scroll container, replacing the legacy per-file `FileDiff` list
 * (`AllFilesDiffView`). Gated behind the `allFilesCodeView` config flag.
 *
 * P1 scope is intentionally minimal: static item data via `getSingularPatch`,
 * uncontrolled `initialItems`, the built-in Pierre header, current theme +
 * diff display options, split/unified, wrap/scroll, indicators, line numbers,
 * and hunk separators. No custom header, no annotations, no toolbar, no
 * file-content augmentation — those land in later phases.
 *
 * Props mirror the subset of `AllFilesDiffView`'s surface that P1 consumes so
 * the dock panel can swap between the two views cleanly. Behavioral props that
 * P1 does not yet wire (annotations, AI, staging, viewed, code-nav, etc.) are
 * accepted-and-ignored at the panel boundary rather than threaded through here.
 */
interface AllFilesCodeViewProps {
  files: DiffFile[];
  diffStyle: 'split' | 'unified';
  diffOverflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  expandUnchanged?: boolean;
  fontFamily?: string;
  fontSize?: string;
}

export const AllFilesCodeView: React.FC<AllFilesCodeViewProps> = ({
  files,
  diffStyle,
  diffOverflow,
  diffIndicators,
  lineDiffType,
  disableLineNumbers,
  disableBackground,
  expandUnchanged,
  fontFamily,
  fontSize,
}) => {
  // showFileHeader: true keeps Pierre's built-in header title visible. The hook
  // defaults to false (the legacy DiffViewer/AllFilesDiffView render their OWN
  // external FileHeader and WANT Pierre's title hidden via injected unsafeCSS:
  // `[data-diffs-header] [data-title] { display: none }`). P1 has no external
  // header — it relies on Pierre's built-in header to label each file — so that
  // title-hiding rule must NOT be injected, otherwise every file renders with
  // its name hidden (and renames show only the old name + arrow).
  const pierreTheme = usePierreTheme({ fontFamily, fontSize, showFileHeader: true });
  const viewerRef = useRef<CodeViewHandle<undefined> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Order items by the current visual file-tree order — same ordering the
  // legacy all-files view uses, so the two surfaces present files identically.
  const visualOrder = useMemo(() => {
    const tree = buildFileTree(files);
    return getVisualFileOrder(tree);
  }, [files]);

  // One diff item per file. id is the file path (path-based, stable) and is
  // preserved exactly — workspace-prefixed paths keep their prefix so future
  // phases can resolve them back to /api/file-content and /api/git-add.
  // fileDiff.cacheKey is seeded from the path so worker highlighting (added in
  // a later phase) can cache by a stable per-file key.
  //
  // `initialItems` is computed once on mount (uncontrolled CodeView, the
  // Diffshub pattern); later item changes will go through the imperative ref
  // API in subsequent phases.
  const initialItems = useMemo<CodeViewItem<undefined>[]>(() => {
    return visualOrder.map((index) => {
      const file = files[index];
      const fileDiff = getSingularPatch(file.patch);
      fileDiff.cacheKey = file.path;
      return {
        id: file.path,
        type: 'diff',
        fileDiff,
        version: 0,
      };
    });
    // Build once from the initial file set; CodeView owns items after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pass-through allowlist only (CODE_VIEW_DIFF_OPTION_KEYS). hunkSeparators is
  // a CodeView-level option (set below, not per-item), and unsafeCSS carries
  // the shared Pierre shadow-DOM theme — now applied once to the single CodeView
  // scroll model instead of N FileDiff instances.
  const options = useMemo<CodeViewOptions<undefined>>(
    () => ({
      themeType: pierreTheme.type,
      unsafeCSS: pierreTheme.css,
      ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
      diffStyle,
      overflow: diffOverflow,
      diffIndicators,
      lineDiffType,
      disableLineNumbers,
      disableBackground,
      expandUnchanged,
      enableLineSelection: true,
      enableGutterUtility: true,
      hunkSeparators: 'line-info',
      stickyHeaders: true,
    }),
    [
      pierreTheme.type,
      pierreTheme.css,
      pierreTheme.syntaxTheme,
      diffStyle,
      diffOverflow,
      diffIndicators,
      lineDiffType,
      disableLineNumbers,
      disableBackground,
      expandUnchanged,
    ],
  );

  return (
    <CodeView<undefined>
      ref={viewerRef}
      containerRef={scrollRef}
      className="h-full overflow-auto"
      initialItems={initialItems}
      options={options}
    />
  );
};

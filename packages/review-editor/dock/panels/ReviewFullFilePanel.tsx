import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { CodeView, type CodeViewHandle, type CodeViewItem, type LineAnnotation } from '@pierre/diffs/react';
import type { CodeViewLineSelection } from '@pierre/diffs';
import type { SelectedLineRange as PierreSelectedLineRange } from '@pierre/diffs';

import { useReviewState } from '../ReviewStateContext';
import {
  getReviewFullFilePanelFilePath,
  getReviewFullFilePanelLine,
  type ReviewFullFilePanelParams,
} from '../reviewPanelTypes';
import { usePierreTheme } from '../../hooks/usePierreTheme';
import { useWorkerPoolThemeSync } from '../../workerPool';
import { ToolbarHost, type ToolbarHostHandle } from '../../components/ToolbarHost';
import { InlineAnnotation } from '../../components/InlineAnnotation';
import { lineAnnotationMetadata } from '../../utils/annotationDisplay';
import { annotationMatchesPrScope } from '../../utils/annotationScope';
import { hashString } from '../../utils/hashString';
import { detectLanguage } from '../../utils/detectLanguage';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';


/**
 * Map a DOM node inside Pierre's rendered code to its 1-based line number.
 * Ported from CodeFilePopout, which solves the same problem on the annotate
 * side: Pierre's own drag gesture does not surface a range on a CodeView file
 * item, so a multi-line selection has to be read back off the DOM selection.
 */
function lineNumberFromNode(node: Node | null): number | null {
  let current: Node | null = node;
  if (current?.nodeType === Node.TEXT_NODE) current = current.parentNode;
  while (current) {
    if (current instanceof HTMLElement) {
      const line = current.closest('[data-line]')?.getAttribute('data-line');
      if (line) {
        const parsed = Number(line);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }
    current = current.parentNode;
  }
  return null;
}

/** Pierre renders into a shadow root, which owns its own selection. */
function pierreSelection(root: HTMLElement | null): Selection | null {
  const shadowRoot = root?.querySelector('diffs-container')?.shadowRoot;
  const shadowSelection = (
    shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null
  )?.getSelection?.();
  return shadowSelection && !shadowSelection.isCollapsed ? shadowSelection : window.getSelection();
}

/**
 * Full-file viewer panel (design doc phase 1).
 *
 * Renders ONE Pierre `CodeViewFileItem`. That is what buys virtualization,
 * shared worker-pool highlighting, line selection and line annotations for
 * free — the same machinery the diff surfaces use — so a 10k-line file costs
 * the viewport, not the file.
 *
 * Content comes from /api/review-file: the live working tree, deliberately
 * without a snapshot guard (see the endpoint comment). Annotations authored
 * here are ordinary CodeAnnotations, so they join the one review feedback
 * stream rather than a second channel.
 */
export const ReviewFullFilePanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  // Double read: updateParameters does not always flow into props.params
  // synchronously (the same reason ReviewDiffPanel reads both).
  const filePath =
    getReviewFullFilePanelFilePath(props.params) ??
    getReviewFullFilePanelFilePath(props.api.getParameters<ReviewFullFilePanelParams>());
  const targetLine =
    getReviewFullFilePanelLine(props.params) ??
    getReviewFullFilePanelLine(props.api.getParameters<ReviewFullFilePanelParams>());

  const [content, setContent] = useState<{ forPath: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isActive, setIsActive] = useState<boolean>(props.api.isActive);
  const toolbarHostRef = useRef<ToolbarHostHandle>(null);
  // A multi-line drag ends with a selection event AND a click on the release
  // line. Without this window the click reopens the composer on that single
  // line and the range the user just dragged is silently lost. Same guard
  // CodeFilePopout uses on the annotate side.
  const suppressLineClickUntilRef = useRef(0);
  // Pierre repaints a drag-selection only in CONTROLLED mode: a defined
  // `selectedLines` plus a change handler. Uncontrolled, a range drag paints
  // nothing and never reaches the composer.
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const codeViewRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const pierreTheme = usePierreTheme();
  useWorkerPoolThemeSync(pierreTheme.syntaxTheme);

  // Focus arbitration (design doc risk 1): ToolbarHost drafts live in
  // module-level maps keyed by filePath, so a full-file panel and a diff panel
  // both claiming isFocused for one path would corrupt draft handoff on a
  // last-write-wins basis. Only the ACTIVE dock panel ever claims it.
  useEffect(() => {
    setIsActive(props.api.isActive);
    const disposable = props.api.onDidActiveChange((event) => setIsActive(event.isActive));
    return () => disposable.dispose();
  }, [props.api]);

  // --- content ------------------------------------------------------------
  useEffect(() => {
    if (!filePath) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/review-file?path=${encodeURIComponent(filePath)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { content?: string; error?: string }
          | null;
        if (!res.ok) throw new Error(data?.error || `Could not open ${filePath}`);
        return data?.content ?? '';
      })
      .then((text) => {
        setContent({ forPath: filePath, text });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not open file');
        setLoading(false);
      });
    return () => controller.abort();
  }, [filePath]);

  const contents = content?.forPath === filePath ? content.text : '';

  // --- annotations --------------------------------------------------------
  const fileAnnotations = useMemo(() => {
    if (!filePath) return [];
    return state.allAnnotations.filter(
      (a) =>
        a.filePath === filePath &&
        (a.scope ?? 'line') === 'line' &&
        annotationMatchesPrScope(a, state.prMetadata?.url, state.prDiffScope),
    );
  }, [state.allAnnotations, filePath, state.prMetadata, state.prDiffScope]);

  const lineAnnotations = useMemo(
    (): LineAnnotation<DiffAnnotationMetadata>[] =>
      fileAnnotations.map((ann) => ({
        lineNumber: ann.lineEnd,
        metadata: lineAnnotationMetadata(ann),
      })),
    [fileAnnotations],
  );

  // Pierre 1.3.2 identity hazard: it compares nothing but cacheKey, so the key
  // must be content-derived or a second file rendered at the same path is
  // silently served the first one's cached render.
  const items = useMemo((): CodeViewItem<DiffAnnotationMetadata>[] => {
    if (!filePath || !contents) return [];
    return [
      {
        id: filePath,
        type: 'file',
        file: {
          name: filePath,
          contents,
          cacheKey: `${filePath}#file#${hashString(contents)}`,
        },
        annotations: lineAnnotations,
      },
    ];
  }, [filePath, contents, lineAnnotations]);

  // Reveal the requested line once the file has rendered.
  useEffect(() => {
    if (!targetLine || !filePath || !contents) return;
    const timer = setTimeout(() => {
      codeViewRef.current?.scrollTo({
        type: 'line',
        id: filePath,
        lineNumber: targetLine,
        align: 'center',
      });
    }, 50);
    return () => clearTimeout(timer);
  }, [targetLine, filePath, contents]);

  // --- selection gestures -------------------------------------------------
  // Everything here is the "new" side: this surface shows the working tree.
  const handleSelectedLinesChange = useCallback(
    (selection: { id: string; range: PierreSelectedLineRange } | null) => {
      setSelectedLines(selection);
      if (!selection) {
        toolbarHostRef.current?.handleLineSelectionEnd(null);
        return;
      }
      const start = Math.min(selection.range.start, selection.range.end);
      const end = Math.max(selection.range.start, selection.range.end);
      if (start !== end) {
        suppressLineClickUntilRef.current = Date.now() + 300;
      }
      toolbarHostRef.current?.handleLineSelectionEnd({ start, end, side: 'additions' });
    },
    [],
  );

  // CodeView's callback type is an overload spanning file AND diff items, so
  // the handler is typed on the narrow shape both overloads supply.
  const handleLineClick = useCallback(
    (lineProps: { lineNumber: number }) => {
      if (Date.now() < suppressLineClickUntilRef.current) return;
      toolbarHostRef.current?.openLineAnnotation({
        start: lineProps.lineNumber,
        end: lineProps.lineNumber,
        side: 'additions',
      });
    },
    [],
  );

  /**
   * Turn a browser text selection spanning several lines into a line-range
   * annotation. Without this, dragging across code selects text and nothing
   * else happens — the reviewer's range is lost.
   */
  const openRangeFromTextSelection = useCallback(() => {
    const selection = pierreSelection(surfaceRef.current);
    if (!selection || selection.isCollapsed) return;
    const anchor = lineNumberFromNode(selection.anchorNode);
    const focus = lineNumberFromNode(selection.focusNode);
    if (anchor == null || focus == null || anchor === focus) return;
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    suppressLineClickUntilRef.current = Date.now() + 300;
    setSelectedLines({ id: filePath ?? '', range: { start, end } });
    toolbarHostRef.current?.handleLineSelectionEnd({ start, end, side: 'additions' });
    selection.removeAllRanges?.();
  }, [filePath]);

  const handleAddAnnotation = useCallback<typeof state.onAddAnnotation>(
    (type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta, selectionSnippet) => {
      if (!filePath) return;
      state.onAddAnnotationForFile(
        filePath,
        type,
        text,
        suggestedCode,
        originalCode,
        conventionalLabel,
        decorations,
        tokenMeta,
        selectionSnippet,
      );
    },
    [filePath, state.onAddAnnotationForFile],
  );

  const language = filePath ? detectLanguage(filePath) : undefined;

  const renderAnnotation = useCallback(
    (annotation: { metadata?: DiffAnnotationMetadata }) => {
      const metadata = annotation.metadata;
      if (!metadata) return null;
      return (
        <InlineAnnotation
          metadata={metadata}
          language={language}
          isSelected={state.selectedAnnotationId === metadata.annotationId}
          onSelect={state.onSelectAnnotation}
          onEdit={(id) => {
            const ann = state.allAnnotations.find((a) => a.id === id);
            if (ann) toolbarHostRef.current?.startEdit(ann);
          }}
          onDelete={state.onDeleteAnnotation}
        />
      );
    },
    [
      language,
      state.selectedAnnotationId,
      state.onSelectAnnotation,
      state.onDeleteAnnotation,
      state.allAnnotations,
    ],
  );

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        No file selected
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative" data-testid="full-file-panel">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 text-xs text-foreground/80 flex-shrink-0">
        <span className="font-mono truncate" data-testid="full-file-path">
          {filePath}
        </span>
        <span className="text-muted-foreground flex-shrink-0" data-testid="full-file-badge">
          Full file
        </span>
        {contents && (
          <span className="text-muted-foreground flex-shrink-0" data-testid="full-file-lines">
            {contents.split('\n').length} lines
          </span>
        )}
      </div>

      <div
        ref={surfaceRef}
        className="flex-1 min-h-0"
        onMouseUp={() => requestAnimationFrame(openRangeFromTextSelection)}
      >
        {error ? (
          <div
            className="h-full flex items-center justify-center text-xs text-destructive px-4 text-center"
            data-testid="full-file-error"
          >
            {error}
          </div>
        ) : loading && !contents ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            Loading {filePath}…
          </div>
        ) : (
          <CodeView<DiffAnnotationMetadata>
            ref={codeViewRef}
            items={items}
            // Containment mirrors AllFilesCodeView (and Pierre's own production
            // wrapper): CodeView virtualizes against ITS OWN scroll container,
            // so without overflow-y-auto here nothing scrolls and the virtual
            // window never advances past the first screen of lines.
            className="relative h-full overflow-y-auto overflow-x-clip overscroll-contain [contain:strict] [overflow-anchor:none] [will-change:scroll-position] [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style]"
            selectedLines={selectedLines}
            onSelectedLinesChange={handleSelectedLinesChange}
            renderAnnotation={renderAnnotation}
            options={{
              themeType: pierreTheme.type,
              unsafeCSS: pierreTheme.css,
              ...(pierreTheme.syntaxTheme && { theme: pierreTheme.syntaxTheme }),
              disableFileHeader: true,
              overflow: 'scroll',
              enableLineSelection: true,
              lineHoverHighlight: 'line',
              onLineClick: handleLineClick,
            }}
          />
        )}
      </div>

      <ToolbarHost
        ref={toolbarHostRef}
        // No patch on this surface: every snippet comes from file contents.
        patch=""
        fileContent={contents}
        filePath={filePath}
        isFocused={isActive}
        onLineSelection={state.onLineSelection}
        onAddAnnotation={handleAddAnnotation}
        onEditAnnotation={state.onEditAnnotation}
      />
    </div>
  );
};

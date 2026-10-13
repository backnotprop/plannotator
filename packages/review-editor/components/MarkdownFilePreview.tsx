import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation, Block, CodeAnnotation, ImageAttachment, MarkdownPreviewAnchor } from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { LocalLinkContext, type LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { PlanCleanDiffView, type PlanDiffSide } from '@plannotator/ui/components/plan-diff/PlanCleanDiffView';
import { useAnnotationHighlighter, type AnnotationRestoreReport } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { buildHeadingSlugMap } from '@plannotator/ui/utils/slugify';
import type { DiffFileStatus } from '../types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { useFileContents, type UseFileContentsResult } from '../hooks/useFileContents';
import { fileViewOfRendered, renderedViewOf, type MarkdownPreviewView } from '../hooks/useMarkdownPreview';
import {
  MARKDOWN_PREVIEW_SIZE_LIMIT,
  REMOTE_IMAGE_HELD_TITLE,
  isExternalImageSource,
  isRemoteImageSource,
  markdownPreviewImageUrl,
  markdownPreviewSides,
  markdownPreviewSourcePath,
  resolveReviewRelativePath,
  utf8ByteLength,
} from '../utils/markdownPreview';

// Mermaid and Graphviz fences render as code here, never as diagrams: the
// single-file review build inlines every dynamic import, so importing a
// diagram engine anywhere in the review app (even lazily) puts the Mermaid and
// Graphviz runtimes in every review's page. Owner decision (approval record,
// 2026-10-12 amendment): performance wins. tests/entry-assets.test.ts guards it.

export interface MarkdownFilePreviewProps {
  filePath: string;
  oldPath?: string;
  status?: DiffFileStatus;
  patch: string;
  /** Contents the caller already fetched (the single-file view shares its
   *  diff's fetch). Absent: the preview fetches them itself (all files). */
  contents?: UseFileContentsResult;
  /** For the preview's own fetch. */
  reviewBase?: string;
  reviewSnapshotId?: string;
  /** Snapshot the image route is bound to. */
  imageSnapshotId?: string;
  /** Whether the server reads images for this review (static patch / P4: no). */
  imagesAvailable?: boolean;
  /** Every file path in this review: a link to one of them opens it. */
  reviewFilePaths?: ReadonlySet<string>;
  onOpenReviewFile?: (filePath: string) => void;
  variant: 'single' | 'all-files';
  /** All files: the card's height changed (re-measure the virtualized item). */
  onHeightChange?: () => void;
  /** The view to show and its setter (the single-file view passes both; in
   *  All files the file's view comes from review state). */
  view?: MarkdownPreviewView;
  onViewChange?: (view: MarkdownPreviewView) => void;
  /**
   * Hold remote images (`https://…`) behind a placeholder until the reviewer
   * loads them, so opening a preview never tells a third-party server the
   * reviewer's IP address. Default: on in a PR review (someone else's file),
   * off otherwise.
   */
  holdRemoteImages?: boolean;
}

/** A comment made in this preview, as the text highlighter sees it. */
function toHighlighterAnnotation(ann: CodeAnnotation, view: MarkdownPreviewView): Annotation {
  const anchor = ann.markdownPreview!;
  const sameView = anchor.view === view;
  return {
    id: ann.id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: ann.text,
    originalText: anchor.originalText,
    createdA: ann.createdAt,
    author: ann.author,
    // Stored positions are only valid in the view they were made in; the
    // other view finds the quote by its text.
    ...(sameView && anchor.startMeta && anchor.endMeta ? { startMeta: anchor.startMeta, endMeta: anchor.endMeta } : {}),
  };
}

/** The rendered-diff section a highlight starts in. */
function diffContextOf(mark: Element | null | undefined): MarkdownPreviewAnchor['diffContext'] {
  const section = mark?.closest('.plan-diff-added, .plan-diff-removed, .plan-diff-modified, .plan-diff-unchanged');
  if (!section) return undefined;
  if (section.classList.contains('plan-diff-removed')) return 'removed';
  if (section.classList.contains('plan-diff-added')) {
    // The new half of a stacked modified block renders as "added" inside it.
    return section.parentElement?.querySelector(':scope > .plan-diff-removed') ? 'modified' : 'added';
  }
  if (section.classList.contains('plan-diff-modified')) return 'modified';
  return 'unchanged';
}

/**
 * A Markdown file of the review, rendered. Two views, picked on the file's
 * header menu: Changes, the rendered diff (plan review's clean diff view with
 * this app's block renderer, unchanged runs folded, source lines in a
 * gutter), and Read, the whole new version with no diff marks. Select any
 * text to comment on it, the PR description's experience: the comment is a
 * file comment that carries the quote.
 */
export const MarkdownFilePreview: React.FC<MarkdownFilePreviewProps> = ({
  filePath,
  oldPath,
  status,
  patch,
  contents: providedContents,
  reviewBase,
  reviewSnapshotId,
  imageSnapshotId,
  imagesAvailable = false,
  reviewFilePaths,
  onOpenReviewFile,
  variant,
  onHeightChange,
  view: viewProp,
  onViewChange,
  holdRemoteImages,
}) => {
  const state = useReviewStateOptional();
  const ownContents = useFileContents({
    filePath,
    oldPath,
    reviewBase,
    reviewSnapshotId,
    enabled: !providedContents,
  });
  const { fileContents, loading, stale: snapshotStale } = providedContents ?? ownContents;

  const [localView, setLocalView] = useState<MarkdownPreviewView>('diff');
  const controller = state?.markdownPreview;
  const view = viewProp ?? (controller ? renderedViewOf(controller.viewOf(filePath)) : localView);
  const setView = useCallback((next: MarkdownPreviewView) => {
    if (onViewChange) onViewChange(next);
    else if (controller) controller.show(filePath, fileViewOfRendered(next));
    else setLocalView(next);
  }, [onViewChange, controller, filePath]);

  const sourcePath = markdownPreviewSourcePath(filePath, oldPath, status);
  const sides = useMemo(() => {
    if (sourcePath === null || !fileContents || fileContents.forPath !== filePath) return null;
    return markdownPreviewSides(patch, fileContents.old, fileContents.new, status);
  }, [fileContents, filePath, patch, sourcePath, status]);
  const ready = sides?.kind === 'ready' ? sides : null;
  const isStale = sides?.kind === 'stale' || snapshotStale;

  // Added and deleted files have one side: nothing to compare, so they show
  // that side whole. Everything else offers both views.
  const singleSide = status === 'added' ? 'new' : status === 'deleted' ? 'old' : null;
  const unchangedRename = !!ready && singleSide === null && ready.old === ready.new;
  const effectiveView: MarkdownPreviewView = singleSide || unchangedRename ? 'whole' : view;
  const wholeText = ready ? (singleSide === 'old' ? ready.old : ready.new) ?? '' : '';

  const [acceptedLarge, setAcceptedLarge] = useState(false);
  const bytes = useMemo(() => {
    if (!ready) return 0;
    return Math.max(utf8ByteLength(ready.old ?? ''), utf8ByteLength(ready.new ?? ''));
  }, [ready]);
  const tooLarge = bytes > MARKDOWN_PREVIEW_SIZE_LIMIT && !acceptedLarge;

  const diffBlocks = useMemo(
    () => (ready && effectiveView === 'diff' && !tooLarge ? computePlanDiff(ready.old ?? '', ready.new ?? '').blocks : null),
    [ready, effectiveView, tooLarge],
  );

  // --- Links and images -----------------------------------------------------

  const docPath = sourcePath ?? filePath;
  const resolveLink = useCallback<LocalLinkResolver>((href) => {
    const target = resolveReviewRelativePath(docPath, href);
    const files = reviewFilePaths ?? (state ? new Set(state.files.map((file) => file.path)) : undefined);
    const open = onOpenReviewFile ?? state?.openDiffFile;
    if (target !== null && open && files?.has(target)) {
      return { kind: 'open', open: () => open(target), title: `Open ${target} in this review` };
    }
    return { kind: 'unavailable', title: 'Not in this review' };
  }, [docPath, reviewFilePaths, onOpenReviewFile, state]);

  const snapshot = imageSnapshotId ?? state?.snapshotId;
  const canLoadImages = imagesAvailable || state?.imagePreviewAvailable === true;
  const holdRemote = holdRemoteImages ?? !!state?.prMetadata;
  const [remoteImagesLoaded, setRemoteImagesLoaded] = useState(false);
  const holdingRemote = holdRemote && !remoteImagesLoaded;
  const makeImageResolver = useCallback((side: PlanDiffSide): ImageResolver => (src) => {
    if (holdRemote && isRemoteImageSource(src)) {
      return holdingRemote
        ? { kind: 'unavailable', title: REMOTE_IMAGE_HELD_TITLE }
        : { kind: 'src', src: src.trim() };
    }
    if (isExternalImageSource(src)) return null;
    if (!canLoadImages) return { kind: 'unavailable', title: 'Images are not shown for this review' };
    // The patch names the file by its display path (a deletion's is its old
    // one). The source goes as written: the route normalizes it the same way
    // it reads the file's references.
    return { kind: 'src', src: markdownPreviewImageUrl({ doc: filePath, side, src, snapshot }) };
  }, [canLoadImages, filePath, snapshot, holdRemote, holdingRemote]);
  const resolveOldImage = useMemo(() => makeImageResolver('old'), [makeImageResolver]);
  const resolveNewImage = useMemo(() => makeImageResolver('new'), [makeImageResolver]);

  const renderBlock = useCallback((block: Block, orderedIndex: number | null, side: PlanDiffSide, headingAnchorId?: string) => {
    const body = <BlockRenderer block={block} orderedIndex={orderedIndex} headingAnchorId={headingAnchorId} />;
    return (
      <ImageResolverContext.Provider value={side === 'old' ? resolveOldImage : resolveNewImage}>
        {body}
      </ImageResolverContext.Provider>
    );
  }, [resolveOldImage, resolveNewImage]);
  const renderDiffBlock = useCallback(
    (block: Block, orderedIndex: number | null, side: PlanDiffSide) => renderBlock(block, orderedIndex, side),
    [renderBlock],
  );

  // --- Comments -------------------------------------------------------------

  const commentsEnabled = !!state?.onAddMarkdownPreviewComment && !!state?.markdownPreview;
  const fileComments = useMemo(
    () => (state?.allAnnotations ?? []).filter((ann) => ann.filePath === filePath && ann.markdownPreview),
    [state?.allAnnotations, filePath],
  );
  const highlighterAnnotations = useMemo(
    () => fileComments.map((ann) => toHighlighterAnnotation(ann, effectiveView)),
    [fileComments, effectiveView],
  );
  const selectedId = state?.selectedAnnotationId ?? null;
  const selectedHere = selectedId && fileComments.some((ann) => ann.id === selectedId) ? selectedId : null;

  const containerRef = useRef<HTMLDivElement>(null);
  // The highlighter (created below) for the new mark of a comment being saved.
  const highlighterRef = useRef<{ current: { getDoms: (id: string) => HTMLElement[] | undefined } | null } | null>(null);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(() => new Set());
  const onRestoreReport = useCallback((report: AnnotationRestoreReport) => {
    setUnanchored((current) => {
      const next = new Set(current);
      for (const id of report.attempted) next.delete(id);
      for (const id of report.unanchored) next.add(id);
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, []);

  const handleAdd = useCallback((ann: Annotation) => {
    const add = state?.onAddMarkdownPreviewComment;
    if (!add || !ann.text?.trim()) return;
    const mark = highlighterRef.current?.current?.getDoms(ann.id)?.[0];
    const diffContext = effectiveView === 'diff' ? diffContextOf(mark) : undefined;
    add(filePath, {
      id: ann.id,
      text: ann.text,
      ...(ann.images?.length ? { images: ann.images as ImageAttachment[] } : {}),
      anchor: {
        originalText: ann.originalText,
        view: effectiveView,
        ...(diffContext ? { diffContext } : {}),
        ...(ann.startMeta && ann.endMeta ? { startMeta: ann.startMeta, endMeta: ann.endMeta } : {}),
      },
    });
  }, [state?.onAddMarkdownPreviewComment, filePath, effectiveView]);

  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: highlighterAnnotations,
    onAddAnnotation: commentsEnabled ? handleAdd : undefined,
    onSelectAnnotation: state?.onSelectAnnotation,
    selectedAnnotationId: selectedHere,
    mode: 'comment',
    enabled: commentsEnabled,
    verifyRestoredContent: true,
    onRestoreReport,
  });
  highlighterRef.current = hook.highlighterRef as unknown as { current: { getDoms: (id: string) => HTMLElement[] | undefined } | null };

  // Paint highlights off the store: new ones on, deleted ones off. Re-runs
  // when what is on screen changes (view, contents, a fold opening).
  const [renderEpoch, setRenderEpoch] = useState(0);
  const prevIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!commentsEnabled) return;
    const ids = new Set(highlighterAnnotations.map((ann) => ann.id));
    for (const id of prevIdsRef.current) {
      if (!ids.has(id)) hook.removeHighlight(id);
    }
    hook.applyAnnotations(highlighterAnnotations);
    prevIdsRef.current = ids;
  }, [highlighterAnnotations, wholeText, diffBlocks, renderEpoch, commentsEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // A switch of view remounts the content: the old view's marks are gone.
  useLayoutEffect(() => {
    prevIdsRef.current = new Set();
    setUnanchored(new Set());
  }, [effectiveView]);

  // How many remote images are held on screen (counted from the rendered
  // placeholders, so folds and both views are counted as shown).
  const [heldRemoteCount, setHeldRemoteCount] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    const count = !holdingRemote || !container
      ? 0
      : Array.from(container.querySelectorAll('[data-image-unavailable]'))
        .filter((el) => el.getAttribute('title') === REMOTE_IMAGE_HELD_TITLE).length;
    setHeldRemoteCount((current) => (current === count ? current : count));
  });

  // --- Height reporting (all files) -----------------------------------------

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onHeightChange || !rootRef.current || typeof ResizeObserver === 'undefined') return;
    let last = rootRef.current.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const height = rootRef.current?.getBoundingClientRect().height ?? last;
      if (Math.abs(height - last) < 1) return;
      last = height;
      onHeightChange();
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

  // --- Clicks inside the document -------------------------------------------

  // Links never navigate the review tab: external ones open a new tab, a file
  // of this review opens in the review (through the link resolver), anything
  // else is inert. `#heading` scrolls within the preview.
  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    const held = target?.closest?.('[data-image-unavailable]');
    if (held && held.getAttribute('title') === REMOTE_IMAGE_HELD_TITLE) {
      // A held remote image: a click on it loads the remote images (and
      // never follows a link the image sits in).
      event.preventDefault();
      setRemoteImagesLoaded(true);
      return;
    }
    if (target?.closest?.('[data-plan-diff-fold]')) {
      // A fold opened or closed: re-anchor highlights once it has rendered.
      requestAnimationFrame(() => setRenderEpoch((n) => n + 1));
      return;
    }
    const anchor = target?.closest?.('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    if (anchor.hasAttribute('data-local-link')) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    if (/^https?:/i.test(href) || href.startsWith('//')) {
      if (anchor.getAttribute('target') === '_blank') return;
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (/^(mailto|tel):/i.test(href)) return;
    event.preventDefault();
    if (href.startsWith('#') && href.length > 1) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep as written */ }
      const heading = Array.from(event.currentTarget.querySelectorAll('[id]')).find((el) => el.id === id);
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handleAuxClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href');
    if (href && !/^https?:/i.test(href) && !href.startsWith('//')) event.preventDefault();
  }, []);

  // --- Rendering ------------------------------------------------------------

  const wholeBlocks = useMemo(
    () => (ready && effectiveView === 'whole' && !tooLarge ? parseMarkdownToBlocks(wholeText) : null),
    [ready, effectiveView, tooLarge, wholeText],
  );
  const wholeGroups = useMemo(() => (wholeBlocks ? groupBlocks(wholeBlocks) : []), [wholeBlocks]);
  const headingSlugs = useMemo(() => (wholeBlocks ? buildHeadingSlugMap(wholeBlocks) : null), [wholeBlocks]);
  const wholeSide: PlanDiffSide = singleSide === 'old' ? 'old' : 'new';

  let body: React.ReactNode;
  if (!ready) {
    body = (
      <div
        role="status"
        data-markdown-preview-state={loading ? 'loading' : isStale ? 'stale' : 'unavailable'}
        className="mx-auto max-w-3xl rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground"
      >
        {loading
          ? 'Loading the full Markdown file…'
          : isStale
            ? 'This file changed after the diff was captured. Refresh the diff to preview it.'
            : 'The full file content is unavailable for this review. Switch back to Source to review the available changes.'}
      </div>
    );
  } else if (tooLarge) {
    body = (
      <div
        role="status"
        data-markdown-preview-large=""
        className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground"
      >
        <span>
          <span className="font-medium text-foreground">Too large to preview here</span>
          {' · '}{Math.round(bytes / 1024)} KB. Rendering it may slow the page.
        </span>
        <button
          type="button"
          data-markdown-preview-anyway=""
          className="rounded px-2 py-1 text-xs text-foreground bg-muted/60 hover:bg-muted"
          onClick={() => setAcceptedLarge(true)}
        >
          Preview anyway
        </button>
      </div>
    );
  } else if (effectiveView === 'diff' && diffBlocks) {
    body = (
      <PlanCleanDiffView
        blocks={diffBlocks}
        wordLevel={false}
        renderBlock={renderDiffBlock}
        lineGutter
        foldUnchanged
        unchangedClassName="opacity-80"
      />
    );
  } else {
    body = (
      <div className={singleSide === 'new' ? 'plan-diff-added' : singleSide === 'old' ? 'plan-diff-removed' : undefined}>
        {wholeGroups.map((group) => {
          if (group.type === 'list-group') {
            const indices = computeListIndices(group.blocks);
            return (
              <div key={group.key}>
                {group.blocks.map((block, i) => (
                  <React.Fragment key={block.id}>
                    {renderBlock(block, indices[i], wholeSide, headingSlugs?.get(block.id))}
                  </React.Fragment>
                ))}
              </div>
            );
          }
          return (
            <React.Fragment key={group.block.id}>
              {renderBlock(group.block, null, wholeSide, headingSlugs?.get(group.block.id))}
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  // The header's status letter and the green or red rail already say "new"
  // or "deleted"; only a rename with no change needs a word.
  const renamedNote = ready && !tooLarge && unchangedRename
    ? (oldPath ? `Renamed from ${oldPath} · contents unchanged.` : 'Renamed · contents unchanged.')
    : null;
  const bothViews = !!ready && !tooLarge && !singleSide && !unchangedRename;
  const unanchoredCount = fileComments.filter((ann) => unanchored.has(ann.id)).length;

  return (
    <div
      ref={rootRef}
      className={variant === 'single' ? 'min-h-full px-4 py-4 sm:px-6' : 'px-4 py-4 sm:px-6 border-t border-border/40'}
      data-markdown-preview=""
      data-markdown-preview-view={effectiveView}
    >
      {renamedNote && (
        <div data-markdown-preview-renamed="" className="mx-auto mb-3 max-w-4xl text-xs text-muted-foreground">
          {renamedNote}
        </div>
      )}
      {heldRemoteCount > 0 && (
        <div
          role="status"
          data-markdown-preview-remote-images=""
          className="mx-auto mb-3 flex max-w-4xl flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          <span>
            {heldRemoteCount === 1 ? '1 remote image is' : `${heldRemoteCount} remote images are`} not loaded.
            {' '}Loading one tells its server your IP address.
          </span>
          <button
            type="button"
            data-markdown-preview-load-remote=""
            className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded"
            onClick={() => setRemoteImagesLoaded(true)}
          >
            Load remote images
          </button>
        </div>
      )}
      {unanchoredCount > 0 && (
        <div role="status" data-markdown-preview-unanchored="" className="mx-auto mb-3 max-w-4xl text-xs text-muted-foreground">
          {unanchoredCount === 1 ? '1 comment on this file is' : `${unanchoredCount} comments on this file are`} not in this view.
          {bothViews && (
            <button
              type="button"
              data-markdown-preview-show-view=""
              className="ml-1 text-primary hover:underline"
              onClick={() => setView(effectiveView === 'diff' ? 'whole' : 'diff')}
            >
              {effectiveView === 'diff' ? 'Show in Read' : 'Show in Changes'}
            </button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="mx-auto max-w-4xl"
        onClickCapture={handleClickCapture}
        onAuxClickCapture={handleAuxClickCapture}
      >
        <LocalLinkContext.Provider value={resolveLink}>{body}</LocalLinkContext.Provider>
      </div>

      {hook.commentPopover &&
        createPortal(
          <CommentPopover
            anchorEl={hook.commentPopover.anchorEl}
            contextText={hook.commentPopover.contextText}
            initialText={hook.commentPopover.initialText}
            draftKey={hook.commentPopover.draftKey}
            isGlobal={false}
            allowImages={false}
            onSubmit={hook.handleCommentSubmit}
            onClose={hook.handleCommentClose}
            onAskAI={state?.onAskAIForMarkdownPreview}
            askAIContext={{
              kind: 'selection',
              label: `${docPath} (rendered Markdown)`,
              text: hook.commentPopover.selectedText ?? hook.commentPopover.contextText,
            }}
          />,
          document.body,
        )}
    </div>
  );
};

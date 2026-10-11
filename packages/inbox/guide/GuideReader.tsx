/**
 * The guide viewer inside the Inbox: Plannotator's guide chain
 * (`@plannotator/guide-viewer`'s GuideView) with the Inbox as its GuideHost,
 * over Plannotator's own `AllFilesCodeView`, the renderer guides.show uses
 * (apps/guides-show/viewer/ReadOnlyDiffRenderer.tsx), so the diff panes are
 * the ones Plannotator draws. With `comments`, the diffs take line and range
 * comments through the review app's own selection, toolbar and inline
 * comments (`commentOnly`: nothing else of the review app, which needs its
 * server); without, they are read-only, as on guides.show and the phone.
 *
 * Mounted only through GuidePane's dynamic import (`#guide-reader`,
 * tests/entry-assets.test.ts). The single-file build inlines it: its bytes
 * ship in inbox.html and its modules (the guide chain, the diff renderer) run
 * at page load; what waits for Open is the mount, the diff render and the
 * highlighter, as with every lazy runtime in Plannotator's single-file apps.
 * No new Tailwind classes here or in the chain: the guides.show viewer CSS,
 * and with it its pinned manifest, stay as they are.
 */

import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import type {
  CodeAnnotation,
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  TokenAnnotationMeta,
} from '@plannotator/ui/types';
import type { GuideReaderProps } from './types';
import type ReaderShape from './reader-module';
import { GuideHostProvider, GuideView, type GuideDiffRendererContext, type GuideDiffRendererProps } from '@plannotator/guide-viewer';
import { parseDiffToFiles } from '@plannotator/guide-viewer/diffParser';
import { engineLabel } from '@plannotator/guide-viewer/GuideViewer';
import { AllFilesCodeView, type AllFilesCodeViewProps } from '@plannotator/review-editor/components/AllFilesCodeView';
import { extractLinesFromPatch } from '@plannotator/review-editor/utils/patchParser';
import { useConfigValue } from '@plannotator/ui/config';

/** A line range the review app selects on (Pierre's). */
type SelectedLineRange = NonNullable<AllFilesCodeViewProps['pendingSelection']>;

const NO_ANNOTATIONS: never[] = [];
const noop = () => {};

/** One card's comment wiring: the review app's annotation props of `AllFilesCodeView`. */
export interface GuideDiffComments {
  annotations: CodeAnnotation[];
  selectedAnnotationId: string | null;
  scrollTargetAnnotation: { id: string; token: number } | null;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  onAddAnnotationForFile: (
    filePath: string,
    type: CodeAnnotationType,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel,
    decorations?: ConventionalDecoration[],
    tokenMeta?: TokenAnnotationMeta,
  ) => void;
  onEditAnnotation: (
    id: string,
    text?: string,
    suggestedCode?: string,
    originalCode?: string,
    conventionalLabel?: ConventionalLabel | null,
    decorations?: ConventionalDecoration[],
  ) => void;
  onSelectAnnotation: (id: string | null) => void;
  onDeleteAnnotation: (id: string) => void;
}

/**
 * The diff renderer, configured from Plannotator's diff settings like guides.show's (the surface's reader draws with it too).
 * `compactTouchLayout` is the review app's own phone header (the surface passes it): the full path, its ellipsis at the leading edge
 * only when it does not fit, and 44 pt targets. `comments` turns on line comments; without it the diff is read-only.
 */
export const GuideDiff: FC<GuideDiffRendererProps & { compactTouchLayout?: boolean; comments?: GuideDiffComments }> = ({ comments, ...props }) => {
  const diffStyle = useConfigValue('diffStyle');
  const diffOverflow = useConfigValue('diffOverflow');
  const diffIndicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const fontFamily = useConfigValue('diffFontFamily');
  const fontSize = useConfigValue('diffFontSize');
  return (
    <AllFilesCodeView
      {...props}
      readOnly={!comments}
      commentOnly={!!comments}
      contextExpansionAvailable={false}
      diffStyle={diffStyle}
      diffOverflow={diffOverflow}
      diffIndicators={diffIndicators}
      lineDiffType={lineDiffType}
      disableLineNumbers={!showLineNumbers}
      disableBackground={!showBackground}
      expandUnchanged={expandUnchanged}
      fontFamily={fontFamily || undefined}
      fontSize={fontSize || undefined}
      annotations={comments?.annotations ?? NO_ANNOTATIONS}
      selectedAnnotationId={comments?.selectedAnnotationId ?? null}
      scrollTargetAnnotation={comments?.scrollTargetAnnotation ?? null}
      pendingSelection={comments?.pendingSelection ?? null}
      onLineSelection={comments?.onLineSelection ?? noop}
      onAddAnnotationForFile={comments?.onAddAnnotationForFile ?? noop}
      onEditAnnotation={comments?.onEditAnnotation ?? noop}
      onSelectAnnotation={comments?.onSelectAnnotation ?? noop}
      onDeleteAnnotation={comments?.onDeleteAnnotation ?? noop}
    />
  );
};

/** The provenance line guides.show draws under the counts: repository, branch, the reviewed range. */
function sourceLine(snapshot: GuideSnapshot): string {
  return [snapshot.source.repo, snapshot.source.branch, snapshot.review.gitRef].filter(Boolean).join(' · ');
}

function newCommentId(): string {
  return `ann-guide-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export default function GuideReader({ snapshot, reviewed, onReviewedChange, comments }: GuideReaderProps) {
  const files = useMemo(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const guide = useMemo<CodeGuideData>(
    () => ({
      title: snapshot.guide.title,
      intent: snapshot.guide.intent,
      sections: snapshot.guide.sections,
      unplacedFiles: snapshot.guide.unplacedFiles,
      reviewed: [...snapshot.guide.reviewed],
    }),
    [snapshot.guide],
  );
  const ticks = useMemo(() => guide.sections.map((_, i) => reviewed[i] ?? snapshot.guide.reviewed[i] ?? false), [guide.sections, reviewed, snapshot.guide.reviewed]);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const toggle = useCallback((index: number) => onReviewedChange(ticks.map((value, i) => (i === index ? !value : value))), [ticks, onReviewedChange]);

  // Line comments: the selection the toolbar opens on, as the review app keeps it (one, on the focused card).
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const pendingRef = useRef(pendingSelection);
  pendingRef.current = pendingSelection;
  const annotations = useMemo(() => (comments ? [...comments.annotations] : NO_ANNOTATIONS), [comments?.annotations]);
  const addComment = useCallback<GuideDiffComments['onAddAnnotationForFile']>(
    (filePath, type, text, suggestedCode, originalCode, conventionalLabel, decorations, tokenMeta) => {
      const range = pendingRef.current;
      const wiring = commentsRef.current;
      if (!range || !wiring) return;
      const lineStart = Math.min(range.start, range.end);
      const lineEnd = Math.max(range.start, range.end);
      const side = range.side === 'additions' ? 'new' : 'old';
      const file = files.find((f) => f.path === filePath);
      // The lines as the person read them, quoted in the reply.
      const selectedText = file ? extractLinesFromPatch(file.patch, lineStart, lineEnd, side) : '';
      wiring.onSave({
        id: newCommentId(),
        type,
        scope: 'line',
        filePath,
        lineStart,
        lineEnd,
        side,
        text,
        suggestedCode,
        originalCode,
        ...(tokenMeta && { charStart: tokenMeta.charStart, charEnd: tokenMeta.charEnd, tokenText: tokenMeta.tokenText }),
        ...(selectedText && { selectedText }),
        createdAt: Date.now(),
        conventionalLabel,
        decorations,
      });
      setPendingSelection(null);
    },
    [files],
  );
  const editComment = useCallback<GuideDiffComments['onEditAnnotation']>((id, text, suggestedCode, originalCode, conventionalLabel, decorations) => {
    const wiring = commentsRef.current;
    const before = wiring?.annotations.find((a) => a.id === id);
    if (!wiring || !before) return;
    wiring.onSave({
      ...before,
      ...(text !== undefined && { text }),
      ...(suggestedCode !== undefined && { suggestedCode }),
      ...(originalCode !== undefined && { originalCode }),
      // null clears the label; undefined keeps it.
      ...(conventionalLabel !== undefined && { conventionalLabel: conventionalLabel ?? undefined }),
      ...(decorations !== undefined && { decorations }),
    });
  }, []);
  const selectComment = useCallback((id: string | null) => commentsRef.current?.onSelect(id), []);
  const deleteComment = useCallback((id: string) => commentsRef.current?.onDelete(id), []);

  // A comment chosen in the panel: its file's card comes into view first.
  const scrollTarget = comments?.scrollTarget ?? null;
  const revealFile = useMemo(() => {
    if (!scrollTarget) return null;
    const target = annotations.find((a) => a.id === scrollTarget.id);
    return target ? { path: target.filePath, token: scrollTarget.token } : null;
    // Only a new target moves the view, not an edit of the comments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);

  const getDiffRendererProps = useCallback(
    ({ file, focused }: GuideDiffRendererContext): { comments?: GuideDiffComments } =>
      comments
        ? {
            comments: {
              annotations,
              selectedAnnotationId: comments.selectedId,
              scrollTargetAnnotation: scrollTarget && annotations.some((a) => a.id === scrollTarget.id && a.filePath === file.path) ? scrollTarget : null,
              // Only the focused card is the selection target, as in the review app.
              pendingSelection: focused ? pendingSelection : null,
              onLineSelection: setPendingSelection,
              onAddAnnotationForFile: addComment,
              onEditAnnotation: editComment,
              onSelectAnnotation: selectComment,
              onDeleteAnnotation: deleteComment,
            },
          }
        : {},
    [comments, annotations, scrollTarget, pendingSelection, addComment, editComment, selectComment, deleteComment],
  );
  const host = useMemo(
    () => ({ files, DiffRenderer: GuideDiff, getDiffRendererProps, ...(revealFile ? { revealFile } : {}) }),
    [files, getDiffRendererProps, revealFile],
  );

  return (
    <GuideHostProvider value={host}>
      <GuideView
        guide={guide}
        reviewed={ticks}
        onToggleReviewed={toggle}
        engineLabel={engineLabel(snapshot.generator?.engine, snapshot.generator?.model)}
        focusedFile={focusedFile}
        onFocusFile={setFocusedFile}
        sourceLine={sourceLine(snapshot)}
      />
    </GuideHostProvider>
  );
}

// Held to the shape the window's strict typecheck reads (reader-module.d.ts).
GuideReader satisfies typeof ReaderShape;

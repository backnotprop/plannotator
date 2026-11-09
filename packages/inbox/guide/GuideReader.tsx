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
 * Mounted only through lazyParts.tsx's dynamic import (`#guide-reader`,
 * tests/entry-assets.test.ts). It is its own chunk, packed in inbox.html and
 * served by the Inbox (build/pack-inbox.ts, #2593): its modules (the guide
 * chain, the diff renderer) load and run on the first Open, never at page load.
 * The first section card carries the Split | Unified tab (DiffStyleSwitch,
 * through the chain's `renderSectionTab`) unless the host draws the diff
 * controls in its own bar (`hostDiffControls`: the guided review and the
 * full-window review, approval "diff-controls-headers"); a phone draws every
 * diff Unified and has no tab. The diffs follow every display setting the
 * "Diff display" popover writes, the tab size included. No new Tailwind classes here or in the chain. The comment cards, toolbar
 * and suggestion blocks are styled by packages/review-editor/comments.css,
 * which apps/inbox/index.css imports (guides.show gets it through
 * review-editor's index.css; its pinned manifest follows the viewer build).
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import type {
  CodeAnnotation,
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  TokenAnnotationMeta,
} from '@plannotator/ui/types';
import { ReviewWorkerPoolProvider } from '@plannotator/review-editor/worker-pool';
import { openedLinesQuote } from '../attachments';
import { wholeFileReader, type KeptWholeFiles } from './wholeFileReader';
import type { GuideFileNote, GuideLineNote, GuideReaderProps } from './types';
import type ReaderShape from './reader-module';
import { GuideHostProvider, GuideView, type GuideDiffRendererContext, type GuideDiffRendererProps, type GuideGlobalComments } from '@plannotator/guide-viewer';
import { GuideCodeSpanContext } from '@plannotator/guide-viewer/renderInlineMarkdown';
import { CommentPopover, restoreCommentDraft } from '@plannotator/ui/components/CommentPopover';
import { CodeSpanContext } from '@plannotator/ui/components/LocalLinkContext';
import { parseDiffToFiles } from '@plannotator/guide-viewer/diffParser';
import { engineLabel } from '@plannotator/guide-viewer/GuideViewer';
import { AllFilesCodeView, type AllFilesCodeViewProps } from '@plannotator/review-editor/components/AllFilesCodeView';
import type { DiffSelectionActions } from '@plannotator/review-editor/components/SelectionChooser';
import { extractLinesFromPatch, isLineRangeInPatch } from '@plannotator/review-editor/utils/patchParser';
import { useConfigValue } from '@plannotator/ui/config';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { DiffStyleSwitch } from '../components/DiffStyleSwitch';
import { reviewSourceLine } from './sourceLine';
import { withChapterMermaid, withOverviewMermaid } from './overviewMermaid';
import { usePhone } from '../phone';

/** A line range the review app selects on (Pierre's). */
type SelectedLineRange = NonNullable<AllFilesCodeViewProps['pendingSelection']>;

const NO_ANNOTATIONS: never[] = [];
const NO_LINE_NOTES: readonly GuideLineNote[] = [];
const NO_FILE_NOTES: readonly GuideFileNote[] = [];
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
  /** Choices before the comment box (Comment · Ask · Show me). Absent: the comment box opens at once. */
  selectionActions?: DiffSelectionActions;
}

/**
 * The diff renderer, configured from Plannotator's diff settings like guides.show's (the surface's reader draws with it too).
 * `compactTouchLayout` is the review app's own phone header (the surface passes it): the full path, its ellipsis at the leading edge
 * only when it does not fit, and 44 pt targets. `comments` turns on line comments; without it the diff is read-only.
 */
export const GuideDiff: FC<
  GuideDiffRendererProps & {
    compactTouchLayout?: boolean;
    comments?: GuideDiffComments;
    /** Draw this layout whatever the setting says, leaving the setting as it is (a phone: always Unified). */
    diffStyleOverride?: 'split' | 'unified';
    /** A walkthrough's code isn't a change: no "N unmodified lines" between its ranges. */
    plainSeparators?: boolean;
    /** The review's Viewed ticks (the header's Viewed control). Absent: none, as before. */
    viewedFiles?: Set<string>;
    onToggleViewed?: (filePath: string) => void;
    /** Reads a file's whole text for the expand arrows. Absent: the diff shows as it came. */
    fetchFileContent?: AllFilesCodeViewProps['fetchFileContent'];
    fileOpenIn?: (filePath: string) => ReactNode;
    /** What the host draws under this file's lines (the PR page's threads). Absent: none. */
    lineNotes?: readonly GuideLineNote[];
    /** What the host draws about this whole file, under its header (the PR page's threads on the file). Absent: none. */
    wholeFileNotes?: readonly GuideFileNote[];
    /** Context notes on this file's lines (review-editor's seam). Absent: none, as before. */
    contextNotes?: AllFilesCodeViewProps['contextNotes'];
    renderContextNote?: AllFilesCodeViewProps['renderContextNote'];
  }
> = ({ comments, diffStyleOverride, plainSeparators, viewedFiles, onToggleViewed, fileOpenIn, lineNotes, wholeFileNotes, contextNotes, renderContextNote, ...props }) => {
  const savedDiffStyle = useConfigValue('diffStyle');
  const diffStyle = diffStyleOverride ?? savedDiffStyle;
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
      fileOpenIn={fileOpenIn}
      contextExpansionAvailable={false}
      diffStyle={diffStyle}
      diffOverflow={diffOverflow}
      diffIndicators={diffIndicators}
      lineDiffType={lineDiffType}
      disableLineNumbers={!showLineNumbers}
      disableBackground={!showBackground}
      expandUnchanged={expandUnchanged}
      hunkSeparators={plainSeparators ? 'simple' : 'line-info'}
      fontFamily={fontFamily || undefined}
      fontSize={fontSize || undefined}
      annotations={comments?.annotations ?? NO_ANNOTATIONS}
      {...(lineNotes ? { hostLineNotes: lineNotes } : {})}
      {...(wholeFileNotes ? { hostFileNotes: wholeFileNotes } : {})}
      selectedAnnotationId={comments?.selectedAnnotationId ?? null}
      scrollTargetAnnotation={comments?.scrollTargetAnnotation ?? null}
      pendingSelection={comments?.pendingSelection ?? null}
      onLineSelection={comments?.onLineSelection ?? noop}
      onAddAnnotationForFile={comments?.onAddAnnotationForFile ?? noop}
      onEditAnnotation={comments?.onEditAnnotation ?? noop}
      onSelectAnnotation={comments?.onSelectAnnotation ?? noop}
      onDeleteAnnotation={comments?.onDeleteAnnotation ?? noop}
      {...(comments?.selectionActions ? { selectionActions: comments.selectionActions } : {})}
      {...(onToggleViewed ? { viewedFiles, onToggleViewed } : {})}
      {...(contextNotes && renderContextNote ? { contextNotes, renderContextNote } : {})}
    />
  );
};

function newCommentId(): string {
  return `ann-guide-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

/**
 * A review's "All files" (code review in the Inbox): every changed file in the patch's order, under one heading, so
 * the same chain draws the same diffs and comments without the agent's chapters.
 */
function allFilesGuide(snapshot: GuideSnapshot, files: readonly { path: string; additions: number; deletions: number }[], threadHeading: boolean): CodeGuideData {
  // A walkthrough's files are code as it is, not changes.
  const asItIs = files.length > 0 && files.every((file) => file.additions === 0 && file.deletions === 0);
  return {
    title: snapshot.guide.title,
    intent: '',
    // Under a top bar whose switch says All files: no heading of its own (the pane's CSS draws one column, no card).
    sections: [{ title: threadHeading ? '' : asItIs ? 'Every file' : 'Every changed file', overview: threadHeading ? '' : asItIs ? 'In the order they were sent.' : 'In the order of the diff.', diffs: files.map((file) => ({ file: file.path })) }],
    unplacedFiles: [],
    reviewed: [false],
  };
}

/**
 * Highlighting runs off the page's thread, or a long file freezes it. The pool's three workers start with the first
 * reader on screen and end with the last, so a page with no diff does not hold them.
 */
export default function GuideReader(props: GuideReaderProps) {
  return (
    <ReviewWorkerPoolProvider>
      <Reader {...props} />
    </ReviewWorkerPoolProvider>
  );
}

function Reader({
  snapshot,
  reviewed,
  onReviewedChange,
  chapterTicks = true,
  comments,
  mode = 'walkthrough',
  reveal = null,
  viewed,
  fileOpenIn,
  selectionActions,
  renderOverviewDiagram,
  renderChapterDiagram,
  renderOverviewFigure,
  renderHeadActions,
  highlight = null,
  bare = false,
  controlsHost = null,
  fileContents,
  threadHeading = false,
  signComments = false,
  hostDiffControls = false,
  collapseAll,
  lineNotes,
  wholeFileNotes,
  contextNotes,
  renderContextNote,
}: GuideReaderProps) {
  const savedDiffStyle = useConfigValue('diffStyle');
  const files = useMemo(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const wholeFiles = useRef<KeptWholeFiles>(new Map());
  const fetchFileContent = useMemo<AllFilesCodeViewProps['fetchFileContent']>(() => (fileContents ? wholeFileReader(fileContents, wholeFiles.current) : undefined), [fileContents]);
  const walkthrough = useMemo<CodeGuideData>(
    () => ({
      title: snapshot.guide.title,
      // The thread's heading has one title: a guide with no intent keeps its name there (a narrow bar has no title).
      intent: threadHeading ? snapshot.guide.intent || snapshot.guide.title : snapshot.guide.intent,
      ...(snapshot.guide.overview && { overview: snapshot.guide.overview }),
      sections: snapshot.guide.sections,
      unplacedFiles: snapshot.guide.unplacedFiles,
      reviewed: [...snapshot.guide.reviewed],
    }),
    [snapshot.guide, threadHeading],
  );
  const everyFile = useMemo(() => allFilesGuide(snapshot, files, threadHeading), [snapshot, files, threadHeading]);
  const guide = mode === 'files' ? everyFile : walkthrough;
  const ticks = useMemo(
    () => (mode === 'files' ? [false] : guide.sections.map((_, i) => reviewed[i] ?? snapshot.guide.reviewed[i] ?? false)),
    [mode, guide.sections, reviewed, snapshot.guide.reviewed],
  );
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const toggle = useCallback(
    (index: number) => {
      // "All files" has one heading of its own, not a chapter: nothing to tick.
      if (mode === 'files') return;
      onReviewedChange(ticks.map((value, i) => (i === index ? !value : value)));
    },
    [mode, ticks, onReviewedChange],
  );

  // Line comments: the selection the toolbar opens on, as the review app keeps it (one), on the file it was made in:
  // the next file taking focus has the same line numbers, but not these lines.
  const [pendingSelection, setPendingSelection] = useState<SelectedLineRange | null>(null);
  const [selectionFile, setSelectionFile] = useState<string | null>(null);
  const selectionSetters = useRef(new Map<string, (range: SelectedLineRange | null) => void>());
  const selectionSetter = useCallback((path: string) => {
    let set = selectionSetters.current.get(path);
    if (!set) {
      set = (range) => {
        setSelectionFile(path);
        setPendingSelection(range);
      };
      selectionSetters.current.set(path, set);
    }
    return set;
  }, []);
  // A host's highlight (a picture's part opened its code): those lines are painted on that file's card, which takes focus.
  useEffect(() => {
    if (!highlight) {
      // The host took it back (a part landed where nothing may be painted).
      setPendingSelection(null);
      return;
    }
    setFocusedFile(highlight.path);
    setSelectionFile(highlight.path);
    setPendingSelection({ start: highlight.start, end: highlight.end, side: highlight.side === 'old' ? 'deletions' : 'additions' });
  }, [highlight?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const pendingRef = useRef(pendingSelection);
  pendingRef.current = pendingSelection;
  // The PR page and a review with Code review on sign a new comment with the person's name, as the review app does; a
  // guide, or any review with Code review off, leaves it unsigned as on main.
  const signs = bare || signComments;
  const signed = useCallback((): { author?: string } => (signs ? { author: getIdentity() } : {}), [signs]);
  // Line comments go to the diffs; global comments (on the whole review) to the guide's header.
  const annotations = useMemo(() => (comments ? comments.annotations.filter((a) => a.scope !== 'general') : NO_ANNOTATIONS), [comments?.annotations]);
  const globalAnnotations = useMemo(() => (comments ? comments.annotations.filter((a) => a.scope === 'general') : NO_ANNOTATIONS), [comments?.annotations]);
  /** The global comment composer, open on the header's "Global comment" button. */
  const [globalAnchor, setGlobalAnchor] = useState<HTMLElement | null>(null);
  const globalDraftKey = comments ? `guide-global:${comments.draftScope}` : null;
  const addGlobalComment = useCallback((text: string) => {
    const wiring = commentsRef.current;
    const trimmed = text.trim();
    setGlobalAnchor(null);
    if (!wiring || !trimmed) return;
    const draftKey = `guide-global:${wiring.draftScope}`;
    // The review app's general comment: no file and no lines (its '' / 0 / 0 sentinels).
    void wiring
      .onSave({ id: newCommentId(), type: 'comment', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0, side: 'new', text: trimmed, ...signed(), createdAt: Date.now() })
      // Refused (too long, the thread resolved elsewhere, offline): the words wait in the composer for the next open.
      .then((saved) => {
        if (!saved) restoreCommentDraft(draftKey, text);
      });
  }, [signed]);
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
      // On a line an expand arrow opened: no forge takes it inline, so a PR's review posts it in its main comment, the code quoted.
      const outsideDiff = !!file && !isLineRangeInPatch(file.patch, lineStart, lineEnd, side);
      const whole = wholeFiles.current.get(filePath);
      const openedCode = outsideDiff && whole ? openedLinesQuote(whole.contents, side, lineStart, lineEnd) : '';
      const selectedText = !outsideDiff && file ? extractLinesFromPatch(file.patch, lineStart, lineEnd, side) : '';
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
        ...(outsideDiff && { outsideDiff: true, ...(openedCode && { anchorText: openedCode }) }),
        createdAt: Date.now(),
        ...signed(),
        conventionalLabel,
        decorations,
      });
      setPendingSelection(null);
    },
    [files, signed],
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
  const commentFile = useMemo(() => {
    if (!scrollTarget) return null;
    const target = annotations.find((a) => a.id === scrollTarget.id);
    return target ? { path: target.filePath, token: scrollTarget.token } : null;
    // Only a new target moves the view, not an edit of the comments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);
  // The review's rail moves the view too (`reveal`): whichever moved last wins, under one token count of its own.
  const moves = useRef({ count: 0, comment: commentFile, rail: reveal, target: null as { path: string; token: number } | null });
  const revealFile = useMemo(() => {
    const seen = moves.current;
    const railMoved = reveal !== seen.rail && reveal !== null;
    const commentMoved = commentFile !== seen.comment && commentFile !== null;
    seen.rail = reveal;
    seen.comment = commentFile;
    const next = railMoved ? reveal : commentMoved ? commentFile : null;
    if (next) {
      seen.count += 1;
      seen.target = { path: next.path, token: seen.count };
    }
    return seen.target;
  }, [commentFile, reveal]);

  // A phone draws one column, always, and offers no switch (two ~130 px columns read as nothing);
  // the saved layout is left as it is. Elsewhere the first card carries the Split | Unified tab, unless the host's bar has it.
  const phone = usePhone();
  // The tab size the popover sets, as code review applies it (Pierre reads it off the page).
  const tabSize = useConfigValue('diffTabSize');
  useEffect(() => {
    document.documentElement.style.setProperty('--diffs-tab-size', String(tabSize));
  }, [tabSize]);
  // AllFilesCodeView compares Viewed sets by identity: a new Set only when the ticks change.
  const viewedFilesKey = viewed ? [...viewed.files].sort().join('\n') : null;
  const viewedSet = useMemo(() => (viewed ? new Set(viewed.files) : undefined), [viewedFilesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nothing marked as changed (a walkthrough): Split would draw the same code twice.
  const asItIs = files.length > 0 && files.every((file) => file.additions === 0 && file.deletions === 0);
  // The pull request page's flat review, whose bar holds its actions, draws the tab as two marks.
  const renderSectionTab = useCallback((index: number) => (index === 0 ? <DiffStyleSwitch icons={!!controlsHost} /> : null), [controlsHost]);

  // Each file's card gets its own notes, the same array while they stay the same, so one thread read again draws one
  // file again and no other.
  const notesByFile = useMemo(() => {
    const map = new Map<string, GuideLineNote[]>();
    for (const note of lineNotes ?? []) {
      const list = map.get(note.filePath);
      if (list) list.push(note);
      else map.set(note.filePath, [note]);
    }
    return map;
  }, [lineNotes]);
  const keptNotes = useRef(new Map<string, readonly GuideLineNote[]>());
  const fileNotes = useCallback((path: string): readonly GuideLineNote[] => {
    const next = notesByFile.get(path) ?? NO_LINE_NOTES;
    const kept = keptNotes.current.get(path);
    const same = kept && kept.length === next.length && kept.every((note, i) => note.id === next[i]!.id && note.key === next[i]!.key && note.line === next[i]!.line && note.side === next[i]!.side);
    if (same) return kept;
    keptNotes.current.set(path, next);
    return next;
  }, [notesByFile]);

  // The same for notes on whole files: each file's own, the same array while they stay the same.
  const wholeByFile = useMemo(() => {
    const map = new Map<string, GuideFileNote[]>();
    for (const note of wholeFileNotes ?? []) {
      const list = map.get(note.filePath);
      if (list) list.push(note);
      else map.set(note.filePath, [note]);
    }
    return map;
  }, [wholeFileNotes]);
  const keptWhole = useRef(new Map<string, readonly GuideFileNote[]>());
  const wholeNotesFor = useCallback((path: string): readonly GuideFileNote[] => {
    const next = wholeByFile.get(path) ?? NO_FILE_NOTES;
    const kept = keptWhole.current.get(path);
    const same = kept && kept.length === next.length && kept.every((note, i) => note.id === next[i]!.id && note.key === next[i]!.key);
    if (same) return kept;
    keptWhole.current.set(path, next);
    return next;
  }, [wholeByFile]);

  const getDiffRendererProps = useCallback(
    ({ file }: GuideDiffRendererContext): {
      comments?: GuideDiffComments;
      diffStyleOverride?: 'unified';
      plainSeparators?: boolean;
      viewedFiles?: Set<string>;
      onToggleViewed?: (filePath: string) => void;
      fetchFileContent?: AllFilesCodeViewProps['fetchFileContent'];
      fileOpenIn?: (filePath: string) => ReactNode;
      flushFiles?: boolean;
      headerKeepsFolder?: boolean;
      lineNotes?: readonly GuideLineNote[];
      wholeFileNotes?: readonly GuideFileNote[];
      contextNotes?: AllFilesCodeViewProps['contextNotes'];
      renderContextNote?: AllFilesCodeViewProps['renderContextNote'];
    } => ({
      ...(lineNotes ? { lineNotes: fileNotes(file.path) } : {}),
      ...(wholeFileNotes ? { wholeFileNotes: wholeNotesFor(file.path) } : {}),
      // The PR page: files flush, and a narrow header (a phone's) keeps the folder, so two files of one name read apart.
      ...(bare && { flushFiles: true, headerKeepsFolder: true }),
      // A host's context notes: only a file that has one gets the seam (the others draw exactly as before).
      ...(contextNotes && renderContextNote && contextNotes.some((note) => note.filePath === file.path) ? { contextNotes, renderContextNote } : {}),
      ...((phone || asItIs) && { diffStyleOverride: 'unified' as const }),
      ...(asItIs && { plainSeparators: true }),
      ...(fetchFileContent && { fetchFileContent }),
      ...(fileOpenIn ? { fileOpenIn } : {}),
      ...(viewedSet && viewed ? { viewedFiles: viewedSet, onToggleViewed: viewed.onToggle } : {}),
      ...(comments
        ? {
            comments: {
              annotations,
              selectedAnnotationId: comments.selectedId,
              scrollTargetAnnotation: scrollTarget && annotations.some((a) => a.id === scrollTarget.id && a.filePath === file.path) ? scrollTarget : null,
              pendingSelection: selectionFile === file.path ? pendingSelection : null,
              onLineSelection: selectionSetter(file.path),
              onAddAnnotationForFile: addComment,
              onEditAnnotation: editComment,
              onSelectAnnotation: selectComment,
              onDeleteAnnotation: deleteComment,
              ...(selectionActions ? { selectionActions: selectionActions as DiffSelectionActions } : {}),
            },
          }
        : {}),
    }),
    [bare, contextNotes, renderContextNote, phone, asItIs, comments, annotations, scrollTarget, pendingSelection, selectionFile, selectionSetter, addComment, editComment, selectComment, deleteComment, viewedSet, viewed, selectionActions, fetchFileContent, fileOpenIn, lineNotes, fileNotes, wholeFileNotes, wholeNotesFor],
  );
  // Global comments: the list under the header and its button, while the review takes comments (as line comments).
  // One chosen in the list is shown where the pane lists comments (its folded sheet opens on it).
  const showGlobalComment = useCallback((id: string) => {
    const wiring = commentsRef.current;
    if (wiring?.onShowGlobalComment) wiring.onShowGlobalComment(id);
    else wiring?.onSelect(id);
  }, []);
  const globalComments = useMemo<GuideGlobalComments | undefined>(
    () =>
      comments
        ? {
            comments: globalAnnotations.map((a) => ({ id: a.id, text: a.text ?? '' })),
            onAdd: setGlobalAnchor,
            onSelect: showGlobalComment,
            selectedId: comments.selectedId,
          }
        : undefined,
    [comments, globalAnnotations, showGlobalComment],
  );
  // A global comment chosen in the panel: its place in the guide's list comes into view.
  useEffect(() => {
    if (!scrollTarget || !globalAnnotations.some((a) => a.id === scrollTarget.id)) return;
    const item = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-global-comment]')).find((el) => el.dataset.guideGlobalComment === scrollTarget.id);
    item?.scrollIntoView?.({ block: 'nearest' });
    // Only a new target moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);
  // Every guide the Inbox opens draws its Mermaid overview diagram, whatever the host draws itself.
  const drawOverviewDiagram = useMemo(() => withOverviewMermaid(renderOverviewDiagram), [renderOverviewDiagram]);
  // And each chapter's diagram (format version 5), at the top of the chapter's code pane.
  const drawChapterDiagram = useMemo(() => withChapterMermaid(renderChapterDiagram), [renderChapterDiagram]);
  const host = useMemo(
    () => ({
      files,
      DiffRenderer: GuideDiff,
      getDiffRendererProps,
      ...(revealFile ? { revealFile } : {}),
      ...(phone || asItIs || hostDiffControls ? {} : { renderSectionTab }),
      // A walkthrough's chapter can be words alone: nothing is missing, so it says that and not "out of date".
      ...(asItIs && { renderSectionEmpty: () => <p className="ib-rv-nocode" data-section-no-code="">No code in this chapter.</p> }),
      renderOverviewDiagram: drawOverviewDiagram,
      renderChapterDiagram: drawChapterDiagram,
      ...(renderOverviewFigure ? { renderOverviewFigure } : {}),
      ...(renderHeadActions ? { renderHeadActions } : {}),
      ...(globalComments ? { globalComments } : {}),
      // What GuideDiff draws (a phone: always Unified), for a file box's first estimate.
      diffStyle: phone || asItIs ? ('unified' as const) : savedDiffStyle,
      // The PR page's flush files draw no row after the last hunk until a file's text is read (flushFiles).
      opensWholeFiles: !!fetchFileContent && !bare,
      // The PR page: files edge to edge, each box exactly its header and code.
      ...(bare ? { flushFiles: true } : {}),
      ...(collapseAll ? { collapseAll } : {}),
    }),
    [files, asItIs, getDiffRendererProps, revealFile, phone, hostDiffControls, renderSectionTab, drawOverviewDiagram, drawChapterDiagram, renderOverviewFigure, renderHeadActions, globalComments, savedDiffStyle, fetchFileContent, collapseAll, bare],
  );

  // The window's wrap for a code span, for the viewer's own inline parser.
  const codeSpan = useContext(CodeSpanContext);

  return (
    <GuideHostProvider value={host}>
      <GuideCodeSpanContext.Provider value={codeSpan}>
      <GuideView
        guide={guide}
        reviewed={ticks}
        onToggleReviewed={toggle}
        showReviewed={chapterTicks}
        // All files under the thread's heading: the repository, branch and range alone (no agent's chapters to credit).
        engineLabel={threadHeading && mode === 'files' ? undefined : engineLabel(snapshot.generator?.engine, snapshot.generator?.model)}
        focusedFile={focusedFile}
        onFocusFile={setFocusedFile}
        sourceLine={reviewSourceLine(snapshot)}
        bare={bare}
        actionsHost={controlsHost}
        threadHeading={threadHeading}
        // Every file's box as tall as its diff, in the readers built on this one (a thread's guided review, the review, the PR page).
        fitFileHeights
      />
      </GuideCodeSpanContext.Provider>
      {globalAnchor && globalDraftKey && (
        <CommentPopover
          anchorEl={globalAnchor}
          contextText=""
          isGlobal
          // The export prints a global comment's words only.
          allowImages={false}
          // The words typed survive a close (Escape, a click outside) and a refused save, one draft per message.
          draftKey={globalDraftKey}
          onSubmit={addGlobalComment}
          onClose={() => setGlobalAnchor(null)}
        />
      )}
    </GuideHostProvider>
  );
}

// Held to the shape the window's strict typecheck reads (reader-module.d.ts).
GuideReader satisfies typeof ReaderShape;

// The PR page's All files rides this chunk: the review app's tree and file view (PullRepoParts.tsx).
export { PullAllFiles, PullRepoFile } from './PullRepoParts';

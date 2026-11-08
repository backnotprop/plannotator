/**
 * The full-window review (code review in the Inbox, approval
 * "inbox-code-review-direction", concept A take B): what opens every guide or
 * review an agent sends (approval "inbox-one-review-screen": the guide pane
 * it replaced is gone), from the review card's Start review or the guide
 * tile's Open.
 *
 * - What Code review brings shows only while it is on (Settings →
 *   Capabilities → Code review) and the agent sent a review (`review: true`):
 *   the verdict, Viewed ticks, Show me and Ask on selected lines, the
 *   Overview's picture and Post to GitHub/GitLab. Open in follows the switch
 *   alone. Otherwise (a guide, or a review with Code review off) there is no
 *   verdict to give: the comments ride the person's next Send from the
 *   thread, and the header's Write the reply goes back to it with the reply
 *   box open.
 *
 * - The agent's walkthrough is the spine. There is no left rail (approval
 *   "review-deslop", r7): the top bar holds the "Walkthrough | All files"
 *   switch, the menu of chapters or changed files (ReviewJump) and the review's
 *   title in quiet grey. The diff controls (one Split / Unified button,
 *   Collapse all, the "Diff display" gear: DiffControls, approval
 *   "diff-controls-headers") sit in the bar only, never on the chapters. A
 *   phone's bar is one row: the same menu holds its title and switch.
 * - The diff is Plannotator's own (`GuideReader` over review-editor's
 *   `AllFilesCodeView`): line comments as in code review, and a Viewed tick on
 *   each file's header, kept on the message.
 * - One decision, in the header, with Plannotator's own `DecisionControl`:
 *   Approve with no comments, Send feedback with some, and the caret's
 *   alternates. The verdict is the person's reply in the thread: its first
 *   words say the verdict (`inboxReviewVerdictWords`), a note follows, and
 *   the comments ride under "Feedback on the guided review" in the review
 *   app's export format. It wakes the agent like any reply, and the card in
 *   the thread then shows the outcome.
 *
 * - Show me (approval "code-review-launch-build", item 1): selecting lines
 *   offers Comment · Ask · Show me. Show me asks the agent for a Shape of the
 *   lines, a real board that opens over the review; a click on a part lands on
 *   its line and the board shrinks to a corner card. The Overview draws the
 *   agent's own picture sent with the guide; a review with none has one Show me
 *   in its heading, for the whole review. Plain Ask opens the Inbox's Ask window
 *   with the lines named.
 * - A place in code on a Shape board (a drawn part's `data-code`) opens the review
 *   there with the board as that same corner card (the owner, q-db7db55f).
 *
 * No new keyboard shortcuts: Escape and "Thread" go back to the thread.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { GuideReaderPart, ReaderPart } from '../lazyParts';
import { inboxPullIsOpen, inboxPullUrlOfKey, type InboxMessageWire, type InboxPull, type InboxThread } from '@plannotator/core/inbox-types';
import { parseDiffToFiles, type DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { groupByFileKind } from '@plannotator/core/file-kind';
import { plural } from '@plannotator/core/inbox-format';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import { inboxDrawnViewOf, inboxReviewLines, inboxReviewRound } from '@plannotator/core/inbox-review';
import type { ShapeCodeTarget, ShapeVersion } from '@plannotator/core/shape';
import type { ShapeHost, ShapeReviewAt, ShapeReviewNarrow } from '@plannotator/ui/components/shape';
import { OverviewFigure, ShowMeButton } from '../review-drawing/OverviewFigure';
import { ShowMeBox, ShowMeCorner } from '../review-drawing/ShowMeLayer';
import { partLanding, reviewDrawnOn, overviewPicture, baseName, changedMarks, chapterOf, markOf, partName, targetLines } from '../review-drawing/showMeModel';
import { useShowMe } from '../review-drawing/useShowMe';
import { ShapeBoardLayer, ShapePebbleButton } from '../shape/ShapeParts';
import type { ShapeBoardPlace } from '../shape/types';
import { useLineInView } from './reviewLineInView';
import { shapeReview } from '../shape/review';
import type { InboxShapes } from '../shape/useInboxShapes';
import type { GuideSelectionActions } from '../guide/types';
import { reviewSourceLine } from '../guide/sourceLine';
import { InboxApiError, inboxApi } from '../api';
import { agentName, whenTime } from '../format';
import { Icon } from '../icons';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { holdBarAfterClose, usePhoneCommentsSheet } from './phoneCommentsSheet';
import { clearReviewNotes, readReviewNotes, saveReviewNotes, VerdictKeys, verdictOf, verdictReply } from '../reviewVerdict';
import { useGuideState } from './useGuideState';
import { PostEnding, reviewEnding, useReviewDestination } from '../pulls/PostEnding';
import { onPullDiff, postedSignature, postedWords } from '../pulls/postRules';
import { useLiveSessions } from './NewMessage';
import {
  AskerEndedNote,
  askerCanEnd,
  askerHasEnded,
  CLOSED_ROUTE,
  LEAVE,
  mergeRouteRows,
  othersLive,
  RouteChoice,
  routeRace,
  type AskingSession,
  type RouteState,
} from './ReplyRoute';
import { DiffControls, nextCollapseAll, type CollapseAllState } from './DiffControls';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@plannotator/ui/components/ui/dropdown-menu';
import { chapterInView, fileInView, ReviewJump } from './ReviewJump';
import { OpenInCodeSpans, OpenInFile } from './OpenIn';
import { Tip } from './Tip';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
const GuideReader = GuideReaderPart.Part;

export interface ReviewPaneProps {
  thread: InboxThread;
  /** A tailnet guest's page: the routes behind the arrows refuse it, so no reader. */
  guest?: boolean;
  message: InboxMessageWire;
  /** Back to the thread. */
  onBack: () => void;
  /** Close the review and the thread. */
  onClose: () => void;
  /** The verdict went: the thread reads again (the card shows the outcome). */
  onSent: () => void | Promise<void>;
  /** A review went to the PR on the forge: Reviews reads its rows again. */
  onPosted?: () => void;
  /** Plain Ask on selected lines: the Inbox's Ask window opens with these words in its box. Absent: no Ask. */
  onAsk?: (words: string) => void;
  /** Settings → Capabilities → Code review is on. */
  codeReview: boolean;
  /** No verdict here (a guide, or Code review off): back to the thread with its reply box open. */
  onWriteReply?: () => void;
  /** The window's Shape host and boards. */
  shapeHost: ShapeHost;
  shapes: InboxShapes;
  /** The board open over the review (`&shape=` in the address), or null. */
  board: string | null;
  onBoard: (id: string | null) => void;
  /** Opened from a link on that board: the board starts as the corner card, the review at `at`. */
  boardShrunk?: boolean;
  /** The view and panel the person left that board on (the link's): the board under the card opens there. */
  boardPlace?: ShapeBoardPlace | null;
  /** The person moved to another view or panel on the board. */
  onBoardNavigate?: (place: ShapeBoardPlace) => void;
  /**
   * Where to open (a Shape board's link, `&code=`, `&step=`, `&files`): a file at a line, a chapter, or All files.
   * Once there, `onLanded` (the window drops it from the address, so a reload starts at the top).
   */
  at?: ShapeReviewAt | null;
  onLanded?: () => void;
}

/** Below this width the comments panel folds into the header's Comments button: the rail and the diff keep the room. */
export const REVIEW_FOLD_PANEL_BELOW = 1500;

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];

type RailMode = 'walkthrough' | 'files';

export function ReviewPane({ thread, message, guest = false, onBack, onClose, onSent, onPosted, onAsk, codeReview, onWriteReply, shapeHost, shapes, board, onBoard, boardShrunk = false, boardPlace = null, onBoardNavigate, at = null, onLanded }: ReviewPaneProps) {
  const state = useGuideState(thread, message);
  const { snapshot, error, reviewed, saveError, setSaveError, records, setRecords, commentsRead, comments, selectedId, setSelectedId, readOnly, changeReviewed, remove, edit, showComment, readerComments: stateComments, fileContents } = state;
  // Code review's own review: the agent sent it as one (`review: true`) while Code review is on. A guide, or a review
  // while Code review is off, reads with none of it: no verdict, Viewed ticks, Show me, Overview picture or Post. With
  // Code review off the server refuses the verdict, Viewed ticks, Show me and posting; the rest is the window's choice.
  const isReview = codeReview && message.guide?.review === true;
  // A teammate's pull request takes no verdict (the owner's direction): its review reads, comments stay for the
  // conversation in the thread, and no Approve or Request changes is offered.
  const verdict = isReview && !thread.pull_theirs;
  // Post to GitHub/GitLab (the owner's answer C on #2590): a review of the one PR this thread was handed can go on
  // that PR instead. A teammate's posts with its full verdict; its agent path stays verdict-free (no control here).
  // A stack's review spans several PRs and posts from each layer's own review (Pull requests) instead.
  const postKey = isReview && !state.readOnly && thread.pull_keys?.length === 1 ? thread.pull_keys[0]! : null;
  const [postPull, setPostPull] = useState<InboxPull | null>(null);
  /** The pull list answered (or failed) for this review's PR: until then its ending is not known, and none shows. */
  const [pullsRead, setPullsRead] = useState(false);
  // A post refused at its commit (`pull_commit_gone` on GitHub after a force-push, `pull_moved` on GitLab after any push;
  // GitHub takes a commit still on the PR). Read again from the forge, then offered at its new head.
  const [moved, setMoved] = useState<'reading' | 'read' | 'failed' | null>(null);
  const [reread, setReread] = useState(0);
  useEffect(() => {
    if (reread === 0) {
      setPostPull(null);
      setPullsRead(false);
    }
    if (!postKey) return;
    const controller = new AbortController();
    inboxApi.pulls(reread > 0, controller.signal).then(
      async (answer) => {
        if (controller.signal.aborted) return;
        // A PR reached by its link is on no list: its own read, while it's open.
        const url = answer.pulls.some((pull) => pull.key === postKey) ? null : inboxPullUrlOfKey(postKey);
        const linked = url ? await inboxApi.reviewLink(url, controller.signal).catch(() => null) : null;
        if (controller.signal.aborted) return;
        const unlisted = linked?.ok && inboxPullIsOpen(linked.pull) ? linked.pull : null;
        setPostPull(answer.pulls.find((pull) => pull.key === postKey) ?? unlisted);
        setPullsRead(true);
        if (reread > 0) setMoved('read');
      },
      () => {
        // The list could not be read: the agent's ending alone, as before.
        if (controller.signal.aborted) return;
        setPullsRead(true);
        if (reread > 0) setMoved('failed');
      },
    );
    return () => controller.abort();
  }, [postKey, reread]);
  useEffect(() => {
    setMoved(null);
    setReread(0);
  }, [postKey]);
  // The PR's own diff, read with the PR: a comment whose lines read the same there goes inline, at that diff's commit.
  // Kept only with the commit it is of (`head_sha`): lines read on a diff of no known commit vouch for none.
  const [pullDiff, setPullDiff] = useState<{ files: DiffFile[]; head: string } | null>(null);
  useEffect(() => {
    setPullDiff(null);
    if (!postKey || !postPull) return;
    const controller = new AbortController();
    inboxApi
      .pullDiff(postKey, 'layer', controller.signal)
      .then((answer) => {
        if (controller.signal.aborted || typeof answer.patch !== 'string' || typeof answer.head_sha !== 'string' || !answer.head_sha) return;
        setPullDiff({ files: parseDiffToFiles(answer.patch), head: answer.head_sha });
      })
      .catch(() => {
        // Not read: every comment in the review body, as with a PR of another diff.
      });
    return () => controller.abort();
  }, [postKey, postPull?.head_sha, reread]);
  const [picked, pick] = useReviewDestination();
  const ending = reviewEnding(postPull, verdict, picked);
  const [posted, setPosted] = useState<{ label: string; url: string; action: string } | null>(null);
  useEffect(() => setPosted(null), [message.id]);
  const phone = usePhone();
  // With Code review on, its diff headers offer Open in (the thread's project; nothing when the file is not there).
  const fileOpenIn = useCallback((path: string) => <OpenInFile scope={{ thread: thread.thread_id, message: message.id, from: 'root' }} path={path} />, [thread.thread_id, message.id]);
  const [mode, setMode] = useState<RailMode>('walkthrough');
  const [reveal, setReveal] = useState<{ path: string; token: number } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [viewed, setViewed] = useState<string[]>(() => message.guide_viewed ?? []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true);
  // The comments panel opens and closes from the header's Comments button at every width: docked beside the diff
  // where there is room, over it (a sheet) below REVIEW_FOLD_PANEL_BELOW. Docked, it starts open when the review
  // already has comments and closed with none; the sheet starts closed. Closed, nothing of it stays on screen.
  const [sheet, setSheet] = useState(false);
  const [panelDocked, setPanelDocked] = useState<boolean | null>(null);
  useEffect(() => {
    if (commentsRead && panelDocked === null) setPanelDocked(comments.length > 0);
    // Chosen once, when the comments are first read; after that the person's choice holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentsRead]);
  const panelOpen = folded ? sheet : panelDocked === true;
  const setPanelOpen = (open: boolean) => (folded ? setSheet(open) : setPanelDocked(open));
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  // A global comment chosen in the guide: selected in the panel, and a closed panel opens on it.
  const readerComments = useMemo(
    () =>
      stateComments && {
        ...stateComments,
        onShowGlobalComment: (id: string) => {
          setSelectedId(id);
          if (folded) setSheet(true);
          else setPanelDocked(true);
        },
      },
    [stateComments, setSelectedId, folded],
  );
  useEffect(() => setViewed(message.guide_viewed ?? []), [message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => (snapshot ? parseDiffToFiles(snapshot.review.rawPatch) : []), [snapshot]);
  const commentsForPost = useMemo(() => (pullDiff ? onPullDiff(comments, files, pullDiff.files) : comments), [comments, files, pullDiff]);
  // What the forge took is on the forge: it leaves here, so a verdict to the agent doesn't send it again.
  const forgetWent = (went: readonly CodeAnnotation[]) => {
    const sent = new Set(went.map(postedSignature));
    for (const c of comments) if (sent.has(postedSignature(c))) remove(c.id);
  };
  const chapters = snapshot?.guide.sections ?? [];

  const move = (path: string) => setReveal((was) => ({ path, token: (was?.token ?? 0) + 1 }));
  // Where the person is: the top bar's chapter (or file) follows the scroll. A jump holds the one picked until the
  // person moves the page themselves, so the name does not run through the chapters a smooth scroll passes, and a
  // last chapter too short to reach the top of the scroll keeps its name.
  const [fileSpot, setFileSpot] = useState<string | null>(null);
  const jumped = useRef(false);
  // The top bar's Collapse all (DiffControls): every file's diff, this view only.
  const [collapseAll, setCollapseAll] = useState<CollapseAllState | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (jumped.current) return;
        if (mode === 'walkthrough') setCurrent(chapterInView(body, chapters.length));
        else setFileSpot(fileInView(body));
      });
    };
    const release = () => {
      jumped.current = false;
    };
    const HAND = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    read();
    body.addEventListener('scroll', read, { passive: true });
    for (const kind of HAND) body.addEventListener(kind, release, { passive: true });
    // Where the person is changes with no scroll too: a taller or shorter window, and a file or chapter that folds.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    resized?.observe(body);
    if (contentRef.current) resized?.observe(contentRef.current);
    return () => {
      resized?.disconnect();
      cancelAnimationFrame(frame);
      body.removeEventListener('scroll', read);
      for (const kind of HAND) body.removeEventListener(kind, release);
    };
  }, [mode, snapshot, chapters.length]);
  const toChapter = (index: number | null) => {
    jumped.current = true;
    setCurrent(index);
    if (mode !== 'walkthrough') setMode('walkthrough');
    if (index === null) {
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const first = chapters[index]?.diffs.find((ref) => files.some((file) => file.path === ref.file));
    if (first) move(first.file);
    else bodyRef.current?.querySelector(`[data-guide-section="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const toFile = (path: string) => {
    jumped.current = true;
    setFileSpot(path);
    if (mode !== 'files') setMode('files');
    move(path);
  };
  /** The switch keeps the person's place: the file at the top of the view stays there in the other mode. */
  const flip = (next: RailMode) => {
    const body = bodyRef.current;
    const path = body ? fileInView(body) : null;
    jumped.current = true;
    setMode(next);
    if (next === 'files') setFileSpot(path);
    // A file no chapter placed sits after the last chapter: the name a scroll by hand gives it there.
    else setCurrent(path ? (chapterOf(chapters, path) ?? Math.max(chapters.length - 1, 0)) : null);
    if (path) move(path);
    else body?.scrollTo({ top: 0 });
  };

  // Show me: a Shape of selected lines (or the whole review), over the review.
  const author = agentName(message.author);
  const round = inboxReviewRound(thread.messages, message.id);
  const earlierReviews = useMemo(() => {
    const at = thread.messages.findIndex((m) => m.id === message.id);
    return thread.messages.slice(0, Math.max(0, at)).filter((m) => m.guide?.review).map((m) => m.id);
  }, [thread.messages, message.id]);
  const otherReviews = useMemo(() => thread.messages.filter((m) => m.guide?.review && m.id !== message.id).map((m) => m.id), [thread.messages, message.id]);
  const showMe = useShowMe({
    threadId: thread.thread_id,
    reviewId: message.id,
    title: message.guide?.title ?? snapshot?.guide.title ?? '',
    round,
    agent: author,
    others: otherReviews,
    files,
    boardOpen: !!board,
    enabled: !readOnly && isReview,
    subscribeBoards: shapes.subscribe,
    onBoard,
  });
  /**
   * The board shrunk to the corner card, kept as it is underneath: the part a click landed on, or none (a link on the
   * board, a drawn part's place in code; opened from one, the review starts this way).
   */
  const [landed, setLanded] = useState<{ part: { name: string; mark: string | null; file: string; lines: [number, number] | null } | null } | null>(() =>
    boardShrunk && board ? { part: null } : null,
  );
  const landedOn = useRef(board);
  useEffect(() => {
    if (landedOn.current === board) return;
    landedOn.current = board;
    setLanded(null);
  }, [board]);
  const threadBoard = shapes.byThread.get(thread.thread_id);
  const boardSummary = board ? (shapes.shapes ?? []).find((shape) => shape.id === board) : undefined;
  const showMeAgain = useRef(showMe.again);
  showMeAgain.current = showMe.again;
  const onBoardRef = useRef(onBoard);
  onBoardRef.current = onBoard;
  // The board's Show me again: the box, over the review, for what it was made of; the new version opens the board again.
  const boardHost = useMemo<ShapeHost>(
    () =>
      showMe.state.canAsk
        ? {
            ...shapeHost,
            refreshLabel: 'Show me again',
            refresh: async (id) => {
              onBoardRef.current(null);
              showMeAgain.current(id);
            },
          }
        : shapeHost,
    [shapeHost, showMe.state.canAsk],
  );
  const [highlight, setHighlight] = useState<{ path: string; start: number; end: number; token: number } | null>(null);
  // Painted lines come into view, clear of the corner card.
  useLineInView(bodyRef, highlight);
  /** The chapter that holds the file (else All files), and the review moves to it. */
  const showFile = (path: string) => {
    const index = chapterOf(chapters, path);
    jumped.current = true;
    if (index === null) {
      setFileSpot(path);
      if (mode !== 'files') setMode('files');
    } else {
      setCurrent(index);
      if (mode !== 'walkthrough') setMode('walkthrough');
    }
    move(path);
  };
  /** A part of a picture opens its code: its file, the lines painted. */
  const openCode = (target: ShapeCodeTarget): boolean => {
    if (!files.some((file) => file.path === target.path)) return false;
    showFile(target.path);
    const [start, end] = targetLines(target);
    setHighlight((was) => ({ path: target.path, start, end, token: (was?.token ?? 0) + 1 }));
    return true;
  };
  /**
   * A click on a part of the board: it lands on the code and the board shrinks. Drawn on another review, the lines
   * where that code is now; found nowhere, a file gone from the new side, a rename's old name, or nothing saying which
   * review it was drawn on: the file, unpainted, with the corner's note. Lines this diff can't show: the board's own viewer.
   */
  const landOnCode = (target: ShapeCodeTarget, el: HTMLElement, version?: ShapeVersion | null): boolean => {
    const renamed = files.some((file) => file.path === target.path) ? undefined : files.find((file) => file.oldPath === target.path);
    if (renamed) {
      showFile(renamed.path);
      setHighlight(null);
      setLanded({ part: { name: partName(el), mark: markOf(el), file: renamed.path, lines: null } });
      return true;
    }
    const drawnOn = reviewDrawnOn(version?.through, thread.messages, board ? showMe.askedOn(board) : undefined, version?.at);
    const landing = partLanding(target, showMe.nowLines, drawnOn === message.id ? undefined : drawnOn ? { lines: showMe.linesOf(drawnOn) } : null);
    if (landing === null) return false;
    if (landing === 'changed') {
      showFile(target.path);
      setHighlight(null);
    } else openCode({ ...target, line: landing[0], lineEnd: landing[1] });
    setLanded({ part: { name: partName(el), mark: markOf(el), file: target.path, lines: landing === 'changed' ? null : landing } });
    return true;
  };
  /**
   * A stack badge's "Read it in the review" (`narrow`): that PR's chapter shows only the part's files, under a bar with
   * the way back to the board ("Back to the board") and "Show the whole stack". The chapter is the PR's step, else the
   * one that holds the part's first file. Null: the review as it is.
   */
  const [narrow, setNarrow] = useState<(ShapeReviewNarrow & { chapter: number }) | null>(null);
  /** A place in the review (a Shape board's link): a file at a line, a file, a chapter, or All files. */
  // Narrowing gives the reader a new snapshot: the jump waits for it to draw, or the move is lost with the old one.
  const narrowJump = useRef<{ chapter: number; file: string | null } | null>(null);
  const narrowBack = useRef<HTMLButtonElement>(null);
  // The bar stays over the narrowed chapter: a jump lands below it (`--ib-rv-narrow-h`, read by the file's scroll margin).
  const narrowBar = useRef<HTMLDivElement>(null);
  const goTo = (to: ShapeReviewAt) => {
    if (to.narrow) {
      const chapter = to.step && to.step <= chapters.length ? to.step - 1 : chapterOf(chapters, to.narrow.files[0]!);
      if (chapter !== null) {
        setNarrow({ ...to.narrow, chapter });
        // The chapter's first file that is kept: its first file may be one the narrowing leaves out.
        const kept = to.narrow.files;
        const first = chapters[chapter]?.diffs.find((ref) => kept.includes(ref.file) && files.some((file) => file.path === ref.file));
        narrowJump.current = { chapter, file: first?.file ?? null };
        return;
      }
    }
    setNarrow(null);
    jump(to);
  };
  const jump = (to: ShapeReviewAt) => {
    if (to.path && to.line) openCode({ path: to.path, line: to.line });
    else if (to.path && files.some((file) => file.path === to.path)) toFile(to.path);
    else if (to.step && to.step <= chapters.length) {
      // A chapter with no diff has only its heading to scroll to: wait for the reader to draw it.
      const index = to.step - 1;
      if (chapters[index]?.diffs.some((ref) => files.some((file) => file.path === ref.file))) toChapter(index);
      else {
        jumped.current = true;
        setCurrent(index);
        let tries = 0;
        const look = () => {
          const heading = bodyRef.current?.querySelector(`[data-guide-section="${index}"]`);
          if (heading) heading.scrollIntoView({ block: 'start' });
          else if (tries++ < 120) requestAnimationFrame(look);
        };
        look();
      }
    } else if (to.files) flip('files');
  };
  // A place to open at (a Shape board's link): once the review is read, then the address lets it go.
  const placed = useRef<string | null>(null);
  useEffect(() => {
    if (!at || !snapshot) return;
    const key = JSON.stringify(at);
    if (placed.current === key) return;
    placed.current = key;
    goTo(at);
    onLanded?.();
    // The place is read once per review; the jumps read the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, snapshot]);
  // The board over this review links into it: a place in code lands here, and the board shrinks to
  // the corner card, as a link on the board over the thread does (it opens this review that way).
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const toChapterRef = useRef(toChapter);
  toChapterRef.current = toChapter;
  const boardReview = useMemo(
    () =>
      shapeReview(
        message,
        (_, to) => {
          setLanded({ part: null });
          // Guided review: the walkthrough from its start.
          if (to) goToRef.current(to);
          else toChapterRef.current(null);
        },
        inboxApi.guide,
      ),
    // New facts on the review; not every render's new callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.id, message.guide?.sha256],
  );
  // The actions are made once per switch (a new object each render would re-render every diff); Show me reads
  // the latest render's open through this ref, so it sees the drawings and turns read since.
  const showMeOpen = useRef(showMe.open);
  showMeOpen.current = showMe.open;
  const selectionActions = useMemo<GuideSelectionActions | undefined>(
    () =>
      showMe.state.canAsk
        ? {
            onShowMe: (selection) => showMeOpen.current({ file: selection.filePath, lines: [selection.lineStart, selection.lineEnd] }),
            ...(onAsk
              ? {
                  onAsk: (selection) =>
                    onAsk(`${baseName(selection.filePath)} ${selection.lineStart === selection.lineEnd ? 'line' : 'lines'} ${inboxReviewLines([selection.lineStart, selection.lineEnd])}: `),
                }
              : {}),
          }
        : undefined,
    [showMe.state.canAsk, onAsk],
  );
  // The Overview's picture, drawn as a Shape picture (overviewPicture: version 3 only); any other diagram keeps the
  // guide viewer's own. In a later round, which of its parts the agent redrew.
  const overviewHtml = useMemo(() => overviewPicture(snapshot?.guide.overview?.diagram), [snapshot]);
  // Narrowed (a stack badge): the PR's chapter with only the part's files, when it has any of them.
  const narrowed = useMemo(() => {
    if (!snapshot || !narrow) return null;
    const section = snapshot.guide.sections[narrow.chapter];
    if (!section) return null;
    const total = new Set(section.diffs.map((d) => d.file)).size;
    const kept = section.diffs.filter((d) => narrow.files.includes(d.file));
    if (!kept.length) return null;
    const sections = snapshot.guide.sections.map((s, i) => (i === narrow.chapter ? { ...s, diffs: kept } : s));
    return { snapshot: { ...snapshot, guide: { ...snapshot.guide, sections } }, shown: new Set(kept.map((d) => d.file)).size, total };
  }, [snapshot, narrow]);
  const readerSnapshot = narrowed?.snapshot ?? snapshot;
  useEffect(() => {
    const bar = narrowBar.current;
    const pane = paneRef.current;
    if (!bar || !pane) return;
    const set = () => pane.style.setProperty('--ib-rv-narrow-h', `${bar.offsetHeight}px`);
    set();
    const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set);
    seen?.observe(bar);
    return () => {
      seen?.disconnect();
      pane.style.removeProperty('--ib-rv-narrow-h');
    };
  }, [narrow, narrowed]);
  // The move to the narrowed chapter (or file) waits for the reader to draw: the reader loads lazily, and a move made
  // before it mounts reads as one it has already seen (a review opened from the board over the thread).
  useEffect(() => {
    if (!narrowJump.current) return;
    let tries = 0;
    let frame = 0;
    const go = () => {
      if (!bodyRef.current?.querySelector('[data-guide-section]') && tries++ < 120) {
        frame = requestAnimationFrame(go);
        return;
      }
      const pending = narrowJump.current;
      narrowJump.current = null;
      if (!pending) return;
      if (pending.file) {
        jumped.current = true;
        setCurrent(pending.chapter);
        if (mode !== 'walkthrough') setMode('walkthrough');
        move(pending.file);
      } else jump({ step: pending.chapter + 1 });
      // The card that sent the person here is gone behind the review: focus starts on the way back.
      narrowBack.current?.focus({ preventScroll: true });
    };
    go();
    return () => cancelAnimationFrame(frame);
    // Runs once per narrowing; the jump reads this render's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  const backToBoard = () => {
    setNarrow(null);
    if (board) setLanded(null);
    else if (threadBoard) onBoard(threadBoard.id);
  };
  const earlierReview = earlierReviews.at(-1) ?? null;
  const [earlierOverview, setEarlierOverview] = useState<GuideOverviewDiagram | null>(null);
  useEffect(() => {
    setEarlierOverview(null);
    if (!isReview || !earlierReview || !overviewHtml) return;
    let live = true;
    inboxApi.guide(earlierReview).then(
      (answer) => {
        const parsed = parseGuideSnapshot(answer.snapshot);
        const diagram = parsed.ok ? parsed.value.guide.overview?.diagram : undefined;
        if (live && diagram?.kind === 'html') setEarlierOverview(diagram);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [isReview, earlierReview, !!overviewHtml]); // eslint-disable-line react-hooks/exhaustive-deps
  const overviewChanged = useMemo(
    () =>
      overviewHtml && earlierOverview
        ? changedMarks([earlierOverview.source, earlierOverview.tall?.source ?? ''], [overviewHtml.source, overviewHtml.tall?.source ?? ''])
        : null,
    [overviewHtml, earlierOverview],
  );
  const overviewMeta = overviewChanged
    ? `redrawn by ${author} · ${plural(overviewChanged.size, 'part')} changed`
    : `drawn by ${author} with the guide`;
  const renderOverviewDiagram = useCallback(
    (diagram: GuideOverviewDiagram): ReactNode | null =>
      // Code review's picture: a guide, or a review with Code review off, keeps the guide viewer's own note.
      isReview && diagram.kind === 'html' && diagram === overviewHtml ? (
        <OverviewFigure drawn={inboxDrawnViewOf(diagram)} meta={overviewMeta} {...(overviewChanged ? { changed: overviewChanged } : {})} onCode={(target) => void openCode(target)} />
      ) : null,
    // openCode reads the latest render's state through its closure; the figure is redrawn when these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isReview, overviewHtml, overviewMeta, overviewChanged, files, chapters, mode],
  );
  // Before there is a picture, Show me is one of the review's own actions, in its heading beside Global comment.
  const renderHeadActions = useCallback(
    (): ReactNode | null => (!overviewHtml && showMe.state.canAsk ? <ShowMeButton onShowMe={() => showMe.open({ file: null, lines: null })} /> : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overviewHtml, showMe.state.canAsk],
  );

  const viewedSet = useMemo(() => new Set(viewed), [viewed]);
  const toggleViewed = useCallback(
    (path: string) => {
      const next = viewed.includes(path) ? viewed.filter((p) => p !== path) : [...viewed, path];
      setViewed(next);
      inboxApi.saveGuideViewed(message.id, next).then(
        (saved) => setViewed(saved.viewed),
        (cause: unknown) => setSaveError(cause instanceof Error ? cause.message : 'The Viewed tick was not saved.'),
      );
    },
    [viewed, message.id, setSaveError],
  );
  // Viewed ticks are Code review's: the server takes them only on a review, and only while Code review is on.
  const viewedProp = useMemo(() => (readOnly || !isReview ? undefined : { files: viewedSet, onToggle: toggleViewed }), [readOnly, isReview, viewedSet, toggleViewed]);
  // The top bar's menu lists what the review draws, in the order it draws it (code, then tests, then generated).
  const jumpChapters = chapters.map((chapter, index) => ({ title: chapter.title, reviewed: reviewed[index] ?? snapshot?.guide.reviewed[index] ?? false }));
  const jumpFiles = groupByFileKind(files, (file) => file.path)
    .flatMap((group) => group.items)
    .map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, viewed: isReview && viewedSet.has(file.path) }));
  const jumpAt = mode === 'walkthrough' ? current : Math.max(0, jumpFiles.findIndex((file) => file.path === fileSpot));

  // The notes the person writes on a decision: kept per review until its verdict went (a failed send, a close
  // and a reload keep them), the way the reply box keeps its draft.
  const [notes, setNotes] = useState<Record<string, string>>(() => readReviewNotes(message.id));
  useEffect(() => setNotes(readReviewNotes(message.id)), [message.id]);
  const changeNotes = useCallback(
    (next: Record<string, string>) => {
      setNotes(next);
      saveReviewNotes(message.id, next);
    },
    [message.id],
  );
  const keys = useRef(new VerdictKeys());
  // A verdict whose answer comes after the person left the review (closed it, opened another thread) leaves
  // them where they are.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The session that wrote the review: when it ended and another of the project is live, the verdict asks
  // where it goes first, as a reply does (ReplyRoute); with none live it waits for the next agent.
  const asking = useMemo<AskingSession | null>(
    () =>
      message.author.kind === 'agent' && message.author.session
        ? { message, session: message.author.session, host: message.author.host ?? '', name: agentName(message.author) }
        : null,
    [message],
  );
  const { model: live } = useLiveSessions(thread.thread_id, asking && askerCanEnd(asking) ? asking.session : null, verdict && !readOnly && asking !== null && askerCanEnd(asking));
  const askerEnded = askerHasEnded(asking, live);
  const anyOtherLive = asking !== null && othersLive(asking, live).length > 0;
  const [route, setRoute] = useState<RouteState>(CLOSED_ROUTE);
  const routed = useRef<{ id: DecisionActionId; note?: string } | null>(null);
  useEffect(() => {
    if (!asking) return;
    setRoute((current) => (current.open ? mergeRouteRows(current, asking, live) : current));
    // Only a new read of the live sessions merges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // The verdict: one reply to the review's message, its comments (as the review app exports them) after the words.
  const sendVerdict = useCallback(
    async (id: DecisionActionId, note?: string, choice?: RouteState) => {
      if (sending || !snapshot) return;
      if (!choice && askerEnded && anyOtherLive && asking) {
        routed.current = { id, ...(note !== undefined ? { note } : {}) };
        setSendError(null);
        setRoute((current) => mergeRouteRows({ ...current, open: true, error: null, focus: current.focus + 1 }, asking, live));
        return;
      }
      const chosen =
        choice && choice.selected && choice.selected !== LEAVE && choice.selected !== asking?.session
          ? (choice.rows.find((row) => row.live.session === choice.selected && !row.ended)?.live ?? null)
          : null;
      const to = chosen ? { host: chosen.host, session: chosen.session } : undefined;
      const plan = verdictOf(id, records.length > 0);
      setSending(true);
      setSendError(null);
      try {
        if (plan.discard) {
          for (const record of records) await inboxApi.removeAnnotation(record.id);
          setRecords([]);
        }
        const parts = verdictReply(plan, message.guide?.title ?? snapshot.guide.title, plan.discard ? [] : records, note);
        const input = { words: parts.words, questions: [], ...(parts.feedback ? { feedback: parts.feedback, annotation_ids: parts.annotation_ids } : {}), review_verdict: plan.verdict, ...(to ? { to } : {}) };
        await inboxApi.reply(message.id, { idempotency_key: keys.current.keyFor(input), ...input });
        keys.current.done();
        clearReviewNotes(message.id);
        routed.current = null;
        if (!mounted.current) return;
        setNotes({});
        setRoute(CLOSED_ROUTE);
        await onSent();
        if (mounted.current) onBack();
      } catch (cause) {
        if (!mounted.current) return;
        if (to && cause instanceof InboxApiError && cause.code === 'session_not_live') {
          setRoute((current) => routeRace(current, to.session));
        } else {
          setSendError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'Your verdict was not sent.');
        }
        setSending(false);
      }
    },
    [sending, snapshot, records, setRecords, message.id, message.guide?.title, onSent, onBack, askerEnded, anyOtherLive, asking, live],
  );
  const spec = useMemo(
    () => buildDecisionSpec({ app: 'review', gate: true, count: comments.length, hasFeedback: comments.length > 0, approvalNotesSupported: true }),
    [comments.length],
  );
  const handlers = useMemo<Record<DecisionActionId, DecisionHandler>>(
    () => ({
      primary: () => void sendVerdict('primary'),
      'note-with-approval': (note) => void sendVerdict('note-with-approval', note),
      'request-changes': (note) => void sendVerdict('request-changes', note),
      'note-with-feedback': (note) => void sendVerdict('note-with-feedback', note),
      'approve-with-notes': () => void sendVerdict('approve-with-notes'),
      'discard-and-finish': () => void sendVerdict('discard-and-finish'),
    }),
    [sendVerdict],
  );

  /** Close the panel from inside it (its close, Escape): focus goes back to the button that opens it. */
  const closeSheet = () => {
    // At once: on a phone the button can take focus only once the page shows again.
    flushSync(() => setPanelOpen(false));
    sheetButtonRef.current?.focus({ preventScroll: true });
    if (phone) holdBarAfterClose(sheetButtonRef.current);
  };
  usePhoneCommentsSheet(phone && sheet, sheetCloseRef, closeSheet);
  // Escape closes the open panel before it closes the review (App's handler skips a used Escape).
  const onSheetKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && panelOpen && !event.defaultPrevented) {
      event.preventDefault();
      closeSheet();
    }
  };

  const title = message.guide?.title ?? snapshot?.guide.title ?? 'Review';
  // With no verdict and no post here, what the comments do: ride the person's next Send from the thread.
  const rides = !readOnly && !verdict && !postPull && comments.length > 0 ? `${plural(comments.length, 'comment')} ${comments.length === 1 ? 'goes' : 'go'} with your next reply to ${author}.` : null;
  // Who sent it and when, as the thread's message says (the old guide pane's line).
  const from = `from ${author} in ${thread.project.name}, sent ${whenTime(message.created_at)}`;
  const source = snapshot ? reviewSourceLine(snapshot) : '';
  const railModes = (
    <div className="ib-seg ib-rv-modes" role="radiogroup" aria-label="Review by">
      {(['walkthrough', 'files'] as const).map((value) => (
        <label key={value} className="ib-seg-o" data-on={mode === value ? '' : undefined} data-review-mode-choice={value}>
          <input type="radio" name={`ib-rv-mode-${sheetId}`} checked={mode === value} onChange={() => flip(value)} />
          {value === 'walkthrough' ? 'Walkthrough' : 'All files'}
        </label>
      ))}
    </div>
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-wlayer ib-review ib-rv-walk${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}${!folded && !panelOpen ? ' ib-rv-shut' : ''}`}
      aria-label="Review"
      data-review-message={message.id}
      data-review-mode={mode}
      {...(narrow && narrowed ? { 'data-review-narrowed': '' } : {})}
    >
      <div className="ib-vhead">
        <Tip content="Thread">
          <button type="button" className="ib-back" aria-label="Thread" onClick={onBack}>
            <Icon name="back" size={15} />
          </button>
        </Tip>
        {!phone && <span className="ib-vsep" />}
        {!phone && (
          <span className="ib-rv-nav" data-review-nav="">
            {railModes}
            {snapshot && <ReviewJump mode={mode} chapters={jumpChapters} files={jumpFiles} current={jumpAt} onChapter={toChapter} onFile={toFile} viewedTicks={isReview} />}
          </span>
        )}
        {/* A phone's bar is one row: the place, and in its menu the title and the switch that had rows of their own. */}
        {phone && snapshot && (
          <ReviewJump
            mode={mode}
            chapters={jumpChapters}
            files={jumpFiles}
            current={jumpAt}
            onChapter={toChapter}
            onFile={toFile}
            viewedTicks={isReview}
            head={
              <>
                <div className="ib-rj-head">
                  <bdi className="ib-rj-title" data-review-title="">
                    {title}
                  </bdi>
                  {source && (
                    <span className="ib-rj-source" dir="ltr" data-review-source="">
                      {source}
                    </span>
                  )}
                  <span className="ib-rj-source" data-review-from="">
                    {from}
                  </span>
                </div>
                <DropdownMenuRadioGroup className="ib-rj-modes" aria-label="Review by" value={mode} onValueChange={(value) => flip(value as typeof mode)}>
                  {(['walkthrough', 'files'] as const).map((value) => (
                    <DropdownMenuRadioItem key={value} value={value} className="ib-rj-mode" data-review-mode-choice={value}>
                      {value === 'walkthrough' ? 'Walkthrough' : 'All files'}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            }
          />
        )}
        {!phone && <span className="ib-vsep ib-rv-titlesep" aria-hidden="true" />}
        {/* The review's title, quiet; where it gives way (a short bar) the heading holds the same facts. */}
        {!phone && (
          <Tip
            content={
              <span className="ib-tip-proj">
                <bdi className="ib-tip-name">{title}</bdi>
                {source && (
                  <span className="ib-tip-path" dir="ltr" data-review-source="">
                    {source}
                  </span>
                )}
              </span>
            }
          >
            <span className="ib-fn ib-rv-title" data-review-title="">
              <bdi>{title}</bdi>
            </span>
          </Tip>
        )}
        {!phone && (
          <span className="ib-from ib-rv-from" data-review-from="">
            {from}
          </span>
        )}
        <span className="ib-sp" />
        {snapshot && <DiffControls files={files.length} collapseAll={collapseAll} onCollapseAll={() => setCollapseAll(nextCollapseAll)} />}
        {threadBoard && <ShapePebbleButton shape={threadBoard} open={board === threadBoard.id} onToggle={() => onBoard(board === threadBoard.id ? null : threadBoard.id)} />}
        <button
          type="button"
          ref={sheetButtonRef}
          className={`ib-btn ib-sm ib-vcomments${panelOpen ? ' ib-on' : ''}`}
          onClick={() => setPanelOpen(!panelOpen)}
          onKeyDown={onSheetKey}
          aria-expanded={panelOpen}
          aria-controls={sheetId}
          aria-label={`Comments, ${comments.length}`}
          data-guide-comments-sheet=""
        >
          <Icon name="comment" size={15} />
          {comments.length}
        </button>
        {!readOnly && snapshot && postPull ? (
          <PostEnding
            pull={postPull}
            agent={
              verdict
                ? {
                    name: author,
                    host: message.author.kind === 'agent' ? (message.author.host ?? null) : null,
                    control: (
                      <span className="ib-rv-decide" data-review-decision="">
                        <DecisionControl spec={spec} handlers={handlers} busy={sending || route.open} isLoading={sending} labelBreakpoint="md" drafts={notes} onDraftsChange={changeNotes} />
                      </span>
                    ),
                  }
                : null
            }
            comments={commentsForPost}
            anchor="guide"
            {...(pullDiff ? { headSha: pullDiff.head } : {})}
            busy={sending || route.open}
            picked={picked}
            onPick={pick}
            onWent={forgetWent}
            onPosted={(result) => {
              setMoved(null);
              forgetWent(result.posted);
              setPosted({ label: result.label, url: result.url, action: result.action });
              onPosted?.();
            }}
            onMoved={() => {
              setMoved('reading');
              setReread((n) => n + 1);
            }}
          />
        ) : !readOnly && snapshot && verdict ? (
          <span className="ib-rv-decide" data-review-decision="">
            <DecisionControl spec={spec} handlers={handlers} busy={sending || route.open} isLoading={sending} labelBreakpoint="md" drafts={notes} onDraftsChange={changeNotes} />
          </span>
        ) : (
          // No verdict to give: the comments ride the next Send, from the thread's reply box.
          // A PR's review waits for the pull list: Post may take this place (no Write the reply flashing first).
          !readOnly &&
          snapshot &&
          onWriteReply &&
          (!postKey || pullsRead) && (
            <Tip content={rides}>
              <button type="button" className="ib-btn ib-sm ib-pri" onClick={onWriteReply} aria-label="Write the reply" data-review-write-reply="">
                <Icon name="reply" size={14} />
                {phone ? 'Reply' : 'Write the reply'}
              </button>
            </Tip>
          )
        )}
        <Tip content="Close">
          <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the review">
            <Icon name="x" />
          </button>
        </Tip>
      </div>
      <div className="ib-rsplit">
        <div className="ib-gbody" ref={bodyRef}>
          {moved && (
            <p className="ib-prr-note" role="status" data-review-pull-moved={moved}>
              {moved === 'reading'
                ? 'This pull request has new commits since you opened this review. Reading it again…'
                : moved === 'read'
                  ? 'This pull request has new commits since you opened this review. Read again: your review now posts to its newest commit.'
                  : 'This pull request has new commits, and it could not be read again. Try again in a moment.'}
            </p>
          )}
          {posted && (
            <div className="ib-prr-posted" role="status" data-pull-review-posted={posted.action}>
              <Icon name="checkCircle" size={15} />
              <span>{postedWords(posted)}</span>
              <a href={posted.url} target="_blank" rel="noreferrer noopener">
                View on {posted.label}
                <Icon name="external" size={13} />
              </a>
            </div>
          )}
          {!readOnly && verdict && ending !== 'forge' && asking && (route.open || askerEnded) && (
            // The session that wrote the review ended: the thread's own note, and at a decision its route choice.
            <div className="ib-rv-route" data-review-route="">
              {route.open ? (
                <RouteChoice
                  name={`review-route-${message.id}`}
                  asking={asking}
                  project={thread.project.name}
                  state={route}
                  sending={sending}
                  onSelect={(id) => setRoute((current) => ({ ...current, selected: id, error: null }))}
                  onSubmit={() => {
                    const pending = routed.current;
                    if (pending) void sendVerdict(pending.id, pending.note, route);
                  }}
                  onBack={() => setRoute((current) => ({ ...current, open: false, error: null }))}
                  onShowAll={() => setRoute((current) => ({ ...current, showAll: true }))}
                />
              ) : (
                <AskerEndedNote asking={asking} project={thread.project.name} anyLive={anyOtherLive} />
              )}
            </div>
          )}
          {(saveError || sendError) && (
            <div className="ib-error ib-gerror" role="alert">
              {sendError ?? saveError}
            </div>
          )}
          {error ? (
            <div className="ib-error ib-gerror" role="alert">
              {error}
            </div>
          ) : snapshot ? (
            // The reader is a chunk loaded on first use: one that cannot arrive says so here (ReaderPart).
            <div ref={contentRef}>
            {narrow && narrowed && (
              <div ref={narrowBar} className="ib-rv-narrow" role="region" aria-label="Opened from the board" data-review-narrow={narrow.pr}>
                <button ref={narrowBack} type="button" className="ib-rv-narrow-back" onClick={backToBoard} data-review-narrow-back="">
                  <Icon name="chevL" size={15} />
                  Back to the board
                </button>
                <span className="ib-rv-narrow-what">
                  {/* The spaces keep the words apart where a phone runs them as text (inbox.css); a flex row ignores them. */}
                  <b>{narrow.part}</b> <span className="ib-mut">in</span>{' '}
                  <a
                    className="ib-rv-narrow-pr"
                    {...(narrow.hue !== undefined ? { 'data-hue': '', style: { '--shp-h': narrow.hue } as CSSProperties } : {})}
                    {...(narrow.url ? { href: narrow.url, target: '_blank', rel: 'noreferrer noopener' } : {})}>
                    <span className="ib-rv-narrow-n">
                      <Icon name="pullRequest" size={12} />#{narrow.pr}
                    </span>
                    {narrow.title && <> <b>{narrow.title}</b></>}
                  </a>
                  {narrowed.shown < narrowed.total && ' '}
                  {narrowed.shown < narrowed.total && (
                    <span className="ib-mut">
                      · {narrowed.shown} of the {narrowed.total} files in this chapter
                    </span>
                  )}
                </span>
                <button type="button" className="ib-rv-narrow-all" onClick={() => setNarrow(null)} data-review-narrow-all="">
                  Show the whole stack
                </button>
              </div>
            )}
            <ReaderPart diff={snapshot.review.rawPatch}>
              <OpenInCodeSpans scope={{ thread: thread.thread_id, message: message.id }} on={codeReview}>
              <GuideReader
                snapshot={readerSnapshot!}
                reviewed={reviewed}
                onReviewedChange={changeReviewed}
                comments={readerComments}
                mode={mode}
                reveal={reveal}
                viewed={viewedProp}
                {...(guest ? {} : { fileContents })}
                {...(codeReview ? { fileOpenIn } : {})}
                {...(selectionActions ? { selectionActions } : {})}
                renderOverviewDiagram={renderOverviewDiagram}
                renderHeadActions={renderHeadActions}
                highlight={highlight}
                threadHeading
                signComments={isReview}
                hostDiffControls
                {...(collapseAll ? { collapseAll } : {})}
              />
              </OpenInCodeSpans>
            </ReaderPart>
            </div>
          ) : null}
        </div>
        <div
          className="ib-apanel ib-gpanel"
          id={sheetId}
          onKeyDown={onSheetKey}
          role="region"
          aria-label="Comments"
          data-guide-comments={comments.length}
          data-review-panel={panelOpen ? 'open' : 'closed'}
        >
          {panelOpen && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{comments.length}</span>
              <span className="ib-sp" />
              <button ref={sheetCloseRef} type="button" className="ib-iconbtn" onClick={closeSheet} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          <AnnotationPanel
            title="Comments"
            emptyHint={readOnly ? undefined : 'Click a line number, drag across lines, or select code to comment'}
            isOpen
            // The panel's own head (title, count, close) is above: the list draws as embedded at every width.
            presentation="embedded"
            annotations={NO_ANNOTATIONS}
            blocks={NO_BLOCKS}
            codeAnnotations={comments}
            onSelect={(id) => {
              showComment(id);
              if (folded) setSheet(false);
            }}
            onDelete={remove}
            selectedId={selectedId}
            onSelectCodeAnnotation={(id) => {
              showComment(id);
              if (folded) setSheet(false);
            }}
            onDeleteCodeAnnotation={remove}
            onEditCodeAnnotation={readOnly ? undefined : edit}
            width="100%"
            readOnly={readOnly}
          />
          {rides && (
            <p className="ib-gstrip" data-review-rides="">
              {rides}
            </p>
          )}
        </div>
      </div>
      <ShowMeBox
        state={showMe.state}
        agent={author}
        onWords={showMe.setWords}
        onSend={() => void showMe.send()}
        onBusy={(policy) => void showMe.busyChoice(policy)}
        onStop={() => void showMe.stop()}
        onClose={showMe.closeBox}
      />
      {board && <ShapeBoardLayer host={boardHost} id={board} thread={thread} hidden={!!landed} onClose={() => onBoard(null)} onCode={landOnCode} review={boardReview} place={boardPlace} onNavigate={onBoardNavigate} />}
      {board && landed && (
        <ShowMeCorner shape={board} title={boardSummary?.title ?? 'Shape'} picture={boardSummary?.preview?.picture ?? null} part={landed.part} resolveSrc={(src) => shapeHost.assetUrl?.(board, src) ?? src} onGrow={() => setLanded(null)} onClose={() => onBoard(null)} {...(showMe.state.canAsk ? { onAgain: () => { onBoard(null); showMe.again(board); } } : {})} />
      )}
    </section>
  );
}

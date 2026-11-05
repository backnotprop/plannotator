/**
 * The full-window review (code review in the Inbox, approval
 * "inbox-code-review-direction", concept A take B): what Start review on a
 * review card opens, while the person has Settings → Capabilities → Code
 * review on.
 *
 * - The agent's walkthrough is the spine. There is no left rail (approval
 *   "review-deslop", r7): the top bar holds the "Walkthrough | All files"
 *   switch, the menu of chapters or changed files (ReviewJump) and the review's
 *   title in quiet grey. Split | Unified is a tab on each chapter, and sits in
 *   the bar while no tab is in view. A phone's bar is one row: the same menu
 *   holds its title and switch.
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
 * - Show me (approval "shape-in-code-review", mock ac2): selecting lines offers
 *   Comment · Ask · Show me. Show me asks the agent for a picture of the
 *   lines, which opens over the diff; a click on a part opens its code and the
 *   picture shrinks to a corner card. The Overview draws the agent's own
 *   picture sent with the guide; a review with none has one Show me in its
 *   heading, for the whole review.
 *   Plain Ask opens the Inbox's Ask window with the lines named.
 *
 * No new keyboard shortcuts: Escape and "Thread" go back as the guide pane's do.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { GuideReaderPart, ReaderPart } from '../lazyParts';
import type { InboxMessageWire, InboxPull, InboxThread } from '@plannotator/core/inbox-types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { groupByFileKind } from '@plannotator/core/file-kind';
import { plural } from '@plannotator/core/inbox-format';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import { inboxDrawnViewOf, inboxReviewLines, inboxReviewRound } from '@plannotator/core/inbox-review';
import type { ShapeCodeTarget } from '@plannotator/core/shape';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { OverviewFigure, ShowMeButton } from '../review-drawing/OverviewFigure';
import { ShowMeBox, ShowMeCorner, ShowMeSheet } from '../review-drawing/ShowMeLayer';
import { anchorDrawing, anchorLines, overviewPicture, baseName, changedMarks, chapterOf, codeKey, markOf, newSideLines, partName, targetLines } from '../review-drawing/showMeModel';
import { useShowMe, type ShowMePlace } from '../review-drawing/useShowMe';
import { SHEET_HOME, type SheetOffset } from '../review-drawing/useSheetDrag';
import type { GuideSelectionActions } from '../guide/types';
import { reviewSourceLine } from '../guide/sourceLine';
import { InboxApiError, inboxApi } from '../api';
import { agentName } from '../format';
import { Icon } from '../icons';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { clearReviewNotes, readReviewNotes, saveReviewNotes, VerdictKeys, verdictOf, verdictReply } from '../reviewVerdict';
import { useGuideState } from './GuidePane';
import { PostEnding, reviewEnding, useReviewDestination } from '../pulls/PostEnding';
import { postedWords } from '../pulls/postRules';
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
import { DiffStyleSwitch } from './DiffStyleSwitch';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@plannotator/ui/components/ui/dropdown-menu';
import { chapterInView, fileInView, ReviewJump } from './ReviewJump';
import { Tip } from './Tip';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
const GuideReader = GuideReaderPart.Part;

export interface ReviewPaneProps {
  thread: InboxThread;
  message: InboxMessageWire;
  /** Back to the thread. */
  onBack: () => void;
  /** Close the review and the thread. */
  onClose: () => void;
  /** The verdict went: the thread reads again (the card shows the outcome). */
  onSent: () => void | Promise<void>;
  /** Plain Ask on selected lines: the Inbox's Ask window opens with these words in its box. Absent: no Ask. */
  onAsk?: (words: string) => void;
}

/** Below this width the comments panel folds into the header's Comments button: the rail and the diff keep the room. */
export const REVIEW_FOLD_PANEL_BELOW = 1500;

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];

type RailMode = 'walkthrough' | 'files';

/** Where Split | Unified is held under the top bar (inbox.css `.ib-rv-held`). */

export function ReviewPane({ thread, message, onBack, onClose, onSent, onAsk }: ReviewPaneProps) {
  const state = useGuideState(thread, message);
  const { snapshot, error, reviewed, saveError, setSaveError, records, setRecords, comments, selectedId, setSelectedId, readOnly, changeReviewed, remove, edit, showComment, readerComments: stateComments } = state;
  // A teammate's pull request takes no verdict (the owner's direction): its review reads, comments stay for the
  // conversation in the thread, and no Approve or Request changes is offered.
  const verdict = !thread.pull_theirs;
  // Post to GitHub/GitLab (the owner's answer C on #2590): a review of the one PR this thread was handed can go on
  // that PR instead. A teammate's posts with its full verdict; its agent path stays verdict-free (no control here).
  // A stack's review spans several PRs and posts from each layer's own review (Pull requests) instead.
  const postKey = !state.readOnly && thread.pull_keys?.length === 1 ? thread.pull_keys[0]! : null;
  const [postPull, setPostPull] = useState<InboxPull | null>(null);
  // `pull_moved` on a post: the PR was pushed since it was read here. Read again from the forge, then offered at its new
  // head (the review's comments ride the body, so they do not depend on the commit).
  const [moved, setMoved] = useState<'reading' | 'read' | 'failed' | null>(null);
  const [reread, setReread] = useState(0);
  useEffect(() => {
    if (reread === 0) setPostPull(null);
    if (!postKey) return;
    const controller = new AbortController();
    inboxApi.pulls(reread > 0, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setPostPull(answer.pulls.find((pull) => pull.key === postKey) ?? null);
        if (reread > 0) setMoved('read');
      },
      () => {
        // The list could not be read: the agent's ending alone, as before.
        if (!controller.signal.aborted && reread > 0) setMoved('failed');
      },
    );
    return () => controller.abort();
  }, [postKey, reread]);
  useEffect(() => {
    setMoved(null);
    setReread(0);
  }, [postKey]);
  const [picked, pick] = useReviewDestination();
  const ending = reviewEnding(postPull, verdict, picked);
  const [posted, setPosted] = useState<{ label: string; url: string; action: string } | null>(null);
  useEffect(() => setPosted(null), [message.id]);
  const phone = usePhone();
  const [mode, setMode] = useState<RailMode>('walkthrough');
  const [reveal, setReveal] = useState<{ path: string; token: number } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [viewed, setViewed] = useState<string[]>(() => message.guide_viewed ?? []);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true);
  const [sheet, setSheet] = useState(false);
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  // A global comment chosen in the guide: selected in the panel, and the folded panel opens on it.
  const readerComments = useMemo(
    () =>
      stateComments && {
        ...stateComments,
        onShowGlobalComment: (id: string) => {
          setSelectedId(id);
          if (folded) setSheet(true);
        },
      },
    [stateComments, setSelectedId, folded],
  );
  useEffect(() => setViewed(message.guide_viewed ?? []), [message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => (snapshot ? parseDiffToFiles(snapshot.review.rawPatch) : []), [snapshot]);
  const chapters = snapshot?.guide.sections ?? [];

  const move = (path: string) => setReveal((was) => ({ path, token: (was?.token ?? 0) + 1 }));
  // Where the person is: the top bar's chapter (or file) follows the scroll. A jump holds the one picked until the
  // person moves the page themselves, so the name does not run through the chapters a smooth scroll passes, and a
  // last chapter too short to reach the top of the scroll keeps its name.
  const [fileSpot, setFileSpot] = useState<string | null>(null);
  const jumped = useRef(false);
  // No chapter's tab is in view: Split | Unified docks in the top bar, where it covers nothing (a phone has neither).
  const [docked, setDocked] = useState(false);
  const dockRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = body.getBoundingClientRect();
        const tabs = [...body.querySelectorAll('[data-guide-section-tab] [data-diff-style-switch]')];
        const inView = tabs.find((tab) => {
          const at = tab.getBoundingClientRect();
          return at.bottom > box.top && at.top < box.bottom;
        });
        // One at a time. Focus in the docked one goes with it, to the tab that takes over.
        if (inView && dockRef.current?.contains(document.activeElement)) inView.querySelector<HTMLElement>('input:checked')?.focus({ preventScroll: true });
        setDocked(tabs.length > 0 && !inView);
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
    // A taller or shorter window changes which tabs are in view with no scroll.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    resized?.observe(body);
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

  // Show me: a picture of selected lines (or the whole review), over the diff.
  const author = agentName(message.author);
  const host = message.author.kind === 'agent' ? (message.author.host ?? null) : null;
  const round = inboxReviewRound(thread.messages, message.id);
  const earlierReviews = useMemo(() => {
    const at = thread.messages.findIndex((m) => m.id === message.id);
    return thread.messages.slice(0, Math.max(0, at)).filter((m) => m.guide?.review).map((m) => m.id);
  }, [thread.messages, message.id]);
  const showMe = useShowMe({ threadId: thread.thread_id, reviewId: message.id, earlier: earlierReviews, title: message.guide?.title ?? snapshot?.guide.title ?? '', round, agent: author, files, enabled: !readOnly });
  // Round 2 for Show me: an earlier round's picture stays as asked, its parts anchored again on this round's diff.
  const askedReview = showMe.state.shown && showMe.state.shown.review !== message.id ? showMe.state.shown.review : null;
  const [askedPatch, setAskedPatch] = useState<{ review: string; patch: string } | null>(null);
  useEffect(() => {
    if (!askedReview || askedPatch?.review === askedReview) return;
    let live = true;
    inboxApi.guide(askedReview).then(
      (answer) => {
        const parsed = parseGuideSnapshot(answer.snapshot);
        if (live && parsed.ok) setAskedPatch({ review: askedReview, patch: parsed.value.review.rawPatch });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [askedReview]); // eslint-disable-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => {
    const shown = showMe.state.shown;
    if (!shown || !askedReview || askedPatch?.review !== askedReview) return null;
    const lines = (patch: string) => new Map(parseDiffToFiles(patch).map((file) => [file.path, newSideLines(file.patch)] as const));
    return anchorDrawing([shown.drawing.view.html, shown.drawing.view.tall?.html ?? ''], lines(askedPatch.patch), new Map(files.map((file) => [file.path, newSideLines(file.patch)] as const)));
  }, [showMe.state.shown?.drawing.id, askedReview, askedPatch, files]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where the person dragged the picture: kept while the review is open, through the corner card and back.
  const [sheetOffset, setSheetOffset] = useState<SheetOffset>(SHEET_HOME);
  const [highlight, setHighlight] = useState<{ path: string; start: number; end: number; token: number } | null>(null);
  /** A part of a picture opens its code: the chapter that holds the file (else All files), the lines painted. */
  const openCode = (target: ShapeCodeTarget): boolean => {
    if (!files.some((file) => file.path === target.path)) return false;
    const index = chapterOf(chapters, target.path);
    jumped.current = true;
    if (index === null) {
      setFileSpot(target.path);
      if (mode !== 'files') setMode('files');
    } else {
      setCurrent(index);
      if (mode !== 'walkthrough') setMode('walkthrough');
    }
    move(target.path);
    const [start, end] = targetLines(target);
    setHighlight((was) => ({ path: target.path, start, end, token: (was?.token ?? 0) + 1 }));
    return true;
  };
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
            showMeIcon: <Pebble alive={false} size={15} />,
          }
        : undefined,
    [showMe.state.canAsk, onAsk],
  );
  /**
   * Show me again on an earlier round's picture: its lines where they are in this round (the same text, moved
   * or not), else the lines the person pressed Show me on, else the lines it was asked on.
   */
  const againPlace = (): ShowMePlace | undefined => {
    const shown = showMe.state.shown;
    if (!shown) return undefined;
    const { file, lines } = shown.drawing;
    if (file && lines && askedPatch?.review === askedReview) {
      const before = parseDiffToFiles(askedPatch.patch).find((f) => f.path === file);
      const after = files.find((f) => f.path === file);
      const now = before && after ? anchorLines(lines, newSideLines(before.patch), newSideLines(after.patch)) : null;
      if (now) return { file, lines: now };
    }
    return shown.from ?? undefined;
  };

  // The Overview's picture, and in a later round which of its parts the agent redrew.
  // The Overview's picture, drawn as a Shape picture (overviewPicture: version 3 only); any other diagram keeps the guide viewer's own.
  const overviewHtml = useMemo(() => overviewPicture(snapshot?.guide.overview?.diagram), [snapshot]);
  const earlierReview = earlierReviews.at(-1) ?? null;
  const [earlierOverview, setEarlierOverview] = useState<GuideOverviewDiagram | null>(null);
  useEffect(() => {
    setEarlierOverview(null);
    if (!earlierReview || !overviewHtml) return;
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
  }, [earlierReview, !!overviewHtml]); // eslint-disable-line react-hooks/exhaustive-deps
  const overviewChanged = useMemo(
    () =>
      overviewHtml && earlierOverview
        ? changedMarks([earlierOverview.source, earlierOverview.tall?.source ?? ''], [overviewHtml.source, overviewHtml.tall?.source ?? ''])
        : null,
    [overviewHtml, earlierOverview],
  );
  const overviewMeta = overviewChanged
    ? `redrawn by ${author} for round ${round} · ${plural(overviewChanged.size, 'part')} changed`
    : `drawn by ${author} with the guide`;
  const renderOverviewDiagram = useCallback(
    (diagram: GuideOverviewDiagram): ReactNode | null =>
      diagram.kind === 'html' && diagram === overviewHtml ? (
        <OverviewFigure drawn={inboxDrawnViewOf(diagram)} meta={overviewMeta} {...(overviewChanged ? { changed: overviewChanged } : {})} onCode={(target) => void openCode(target)} />
      ) : null,
    // openCode reads the latest render's state through its closure; the figure is redrawn when these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overviewHtml, overviewMeta, overviewChanged, files, chapters, mode],
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
  const viewedProp = useMemo(() => (readOnly ? undefined : { files: viewedSet, onToggle: toggleViewed }), [readOnly, viewedSet, toggleViewed]);
  // The top bar's menu lists what the review draws, in the order it draws it (code, then tests, then generated).
  const jumpChapters = chapters.map((chapter, index) => ({ title: chapter.title, reviewed: reviewed[index] ?? snapshot?.guide.reviewed[index] ?? false }));
  const jumpFiles = groupByFileKind(files, (file) => file.path)
    .flatMap((group) => group.items)
    .map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, viewed: viewedSet.has(file.path) }));
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
  const { model: live } = useLiveSessions(thread.thread_id, asking && askerCanEnd(asking) ? asking.session : null, !readOnly && asking !== null && askerCanEnd(asking));
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

  const closeSheet = () => {
    setSheet(false);
    sheetButtonRef.current?.focus({ preventScroll: true });
  };
  const onSheetKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && folded && sheet && !event.defaultPrevented) {
      event.preventDefault();
      closeSheet();
    }
  };

  const title = message.guide?.title ?? snapshot?.guide.title ?? 'Review';
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
      className={`ib-viewer ib-review ib-rv-walk${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}`}
      aria-label="Review"
      data-review-message={message.id}
      data-review-mode={mode}
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
            {snapshot && <ReviewJump mode={mode} chapters={jumpChapters} files={jumpFiles} current={jumpAt} onChapter={toChapter} onFile={toFile} />}
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
        <span className="ib-sp" />
        {docked && !phone && (
          <span ref={dockRef} className="ib-rv-docked" data-review-diff-style-docked="">
            <DiffStyleSwitch icons name="ib-diff-style-docked" label="Diff layout, top bar" tipSide="bottom" />
          </span>
        )}
        {folded && (
          <button
            type="button"
            ref={sheetButtonRef}
            className={`ib-btn ib-sm ib-vcomments${sheet ? ' ib-on' : ''}`}
            onClick={() => setSheet((v) => !v)}
            onKeyDown={onSheetKey}
            aria-expanded={sheet}
            aria-controls={sheetId}
            aria-label={`Comments, ${comments.length}`}
            data-guide-comments-sheet=""
          >
            <Icon name="comment" size={15} />
            {comments.length}
          </button>
        )}
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
            comments={comments}
            anchor="guide"
            busy={sending || route.open}
            picked={picked}
            onPick={pick}
            onPosted={(result) => {
              setMoved(null);
              setPosted({ label: result.label, url: result.url, action: result.action });
            }}
            onMoved={() => {
              setMoved('reading');
              setReread((n) => n + 1);
            }}
          />
        ) : (
          !readOnly &&
          verdict &&
          snapshot && (
            <span className="ib-rv-decide" data-review-decision="">
              <DecisionControl spec={spec} handlers={handlers} busy={sending || route.open} isLoading={sending} labelBreakpoint="md" drafts={notes} onDraftsChange={changeNotes} />
            </span>
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
            // The reader is a chunk loaded on first use: one that cannot arrive says so here (GuidePane).
            <ReaderPart diff={snapshot.review.rawPatch}>
              <GuideReader
                snapshot={snapshot}
                reviewed={reviewed}
                onReviewedChange={changeReviewed}
                comments={readerComments}
                mode={mode}
                reveal={reveal}
                viewed={viewedProp}
                {...(selectionActions ? { selectionActions } : {})}
                renderOverviewDiagram={renderOverviewDiagram}
                renderHeadActions={renderHeadActions}
                highlight={highlight}
                threadHeading
              />
            </ReaderPart>
          ) : null}
        </div>
        <div
          className="ib-apanel ib-gpanel"
          id={sheetId}
          onKeyDown={onSheetKey}
          role={folded ? 'region' : undefined}
          aria-label={folded ? 'Comments' : undefined}
          data-guide-comments={comments.length}
        >
          {folded && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{comments.length}</span>
              <span className="ib-sp" />
              <button type="button" className="ib-iconbtn" onClick={closeSheet} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          <AnnotationPanel
            emptyHint={readOnly ? undefined : 'Click a line number, drag across lines, or select code to comment'}
            isOpen
            presentation={folded ? 'embedded' : undefined}
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
      {showMe.state.shown?.as === 'sheet' && (
        <ShowMeSheet
          drawing={showMe.state.shown.drawing}
          answer={showMe.state.shown.answer}
          agent={author}
          host={host}
          offset={sheetOffset}
          {...(phone ? {} : { onOffset: setSheetOffset })}
          asked={askedReview ? { stale: anchors?.stale ?? new Set<string>(), onAgain: () => showMe.again(showMe.state.shown!.drawing, againPlace()) } : null}
          onAgain={() => showMe.again(showMe.state.shown!.drawing)}
          onCode={(drawn, el) => {
            const target = anchors?.moved.get(codeKey(drawn)) ?? drawn;
            if (openCode(target)) showMe.toCorner({ name: partName(el), mark: markOf(el), file: target.path, lines: targetLines(target) });
          }}
          onShrink={() => showMe.toCorner(null)}
          onClose={showMe.closePicture}
        />
      )}
      {showMe.state.shown?.as === 'corner' && (
        <ShowMeCorner drawing={showMe.state.shown.drawing} part={showMe.state.shown.part} onGrow={showMe.grow} onClose={showMe.closePicture} />
      )}
    </section>
  );
}

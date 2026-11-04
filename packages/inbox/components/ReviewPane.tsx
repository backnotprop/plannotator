/**
 * The full-window review (code review in the Inbox, approval
 * "inbox-code-review-direction", concept A take B): what Start review on a
 * review card opens, while the person has Settings → Capabilities → Code
 * review on.
 *
 * - The agent's walkthrough is the spine: the overview and its chapters down
 *   the left rail, with a "Walkthrough | All files" switch that turns the same
 *   rail into the list of changed files.
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
 * No new keyboard shortcuts: Escape and "Thread" go back as the guide pane's do.
 */

import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { GuideReaderPart } from '../lazyParts';
import type { InboxMessageWire, InboxPull, InboxThread } from '@plannotator/core/inbox-types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
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
}

/** Below this width the comments panel folds into the header's Comments button: the rail and the diff keep the room. */
export const REVIEW_FOLD_PANEL_BELOW = 1500;

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];

type RailMode = 'walkthrough' | 'files';

export function ReviewPane({ thread, message, onBack, onClose, onSent }: ReviewPaneProps) {
  const state = useGuideState(thread, message);
  const { snapshot, error, reviewed, saveError, setSaveError, records, setRecords, comments, selectedId, readOnly, changeReviewed, remove, edit, showComment, readerComments } = state;
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
  useEffect(() => setViewed(message.guide_viewed ?? []), [message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => (snapshot ? parseDiffToFiles(snapshot.review.rawPatch) : []), [snapshot]);
  const chapters = snapshot?.guide.sections ?? [];
  const reviewedCount = chapters.filter((_, i) => reviewed[i] ?? snapshot?.guide.reviewed[i] ?? false).length;

  const move = (path: string) => setReveal((was) => ({ path, token: (was?.token ?? 0) + 1 }));
  const toChapter = (index: number | null) => {
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
    if (mode !== 'files') setMode('files');
    move(path);
  };

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

  const author = agentName(message.author);
  const railModes = (
    <div className="ib-seg ib-rv-modes" role="radiogroup" aria-label="Review by">
      {(['walkthrough', 'files'] as const).map((value) => (
        <label key={value} className="ib-seg-o" data-on={mode === value ? '' : undefined} data-review-mode-choice={value}>
          <input type="radio" name={`ib-rv-mode-${sheetId}`} checked={mode === value} onChange={() => setMode(value)} />
          {value === 'walkthrough' ? 'Walkthrough' : 'All files'}
        </label>
      ))}
    </div>
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-review${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}`}
      aria-label="Review"
      data-review-message={message.id}
      data-review-mode={mode}
    >
      <div className="ib-vhead">
        <button type="button" className="ib-back" onClick={onBack}>
          <Icon name="back" size={15} />
          Thread
        </button>
        <span className="ib-vsep" />
        <span className="ib-fn">Review</span>
        <span className="ib-from">
          <bdi>{message.guide?.title ?? ''}</bdi> · from {author}
        </span>
        <span className="ib-sp" />
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
        <nav className="ib-rrail" aria-label="Review">
          {railModes}
          {mode === 'walkthrough' ? (
            <ol className="ib-rv-list" data-review-chapters="">
              <li>
                <button type="button" className="ib-rv-row" data-on={current === null ? '' : undefined} onClick={() => toChapter(null)}>
                  <span className="ib-rv-mark ib-rv-overview" aria-hidden="true">
                    <Icon name="book" size={13} />
                  </span>
                  <span className="ib-rv-t">Overview</span>
                </button>
              </li>
              {chapters.map((chapter, index) => {
                const done = reviewed[index] ?? snapshot?.guide.reviewed[index] ?? false;
                const count = chapter.diffs.length;
                return (
                  <li key={`${chapter.title}:${index}`}>
                    <button
                      type="button"
                      className="ib-rv-row"
                      data-on={current === index ? '' : undefined}
                      onClick={() => toChapter(index)}
                      aria-label={`Chapter ${index + 1}: ${chapter.title}${done ? ', reviewed' : ''}`}
                    >
                      <span className="ib-rv-mark" data-done={done ? '' : undefined} aria-hidden="true">
                        {done ? <Icon name="check" size={12} /> : index + 1}
                      </span>
                      <span className="ib-rv-t">{chapter.title}</span>
                      <span className="ib-rv-n">{count}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <ul className="ib-rv-list" data-review-files="">
              {files.map((file) => {
                const seen = viewedSet.has(file.path);
                const slash = file.path.lastIndexOf('/');
                return (
                  <li key={file.path}>
                    <button type="button" className="ib-rv-row ib-rv-file" onClick={() => toFile(file.path)} aria-label={`${file.path}${seen ? ', viewed' : ''}`}>
                      <span className="ib-rv-mark" data-done={seen ? '' : undefined} aria-hidden="true">
                        {seen ? <Icon name="check" size={12} /> : null}
                      </span>
                      <span className="ib-rv-t">
                        <Tip content={file.path} cut>
                          <span className="ib-rv-path">
                            {/* Cut at the start (the box is right to left); the path itself reads left to right, a leading dot included. */}
                            <bdi dir="ltr">
                              {slash >= 0 && <span className="ib-rv-dir">{file.path.slice(0, slash + 1)}</span>}
                              {file.path.slice(slash + 1)}
                            </bdi>
                          </span>
                        </Tip>
                      </span>
                      <span className="ib-rv-n">
                        <span className="ib-add">+{formatCount(file.additions)}</span> <span className="ib-del">-{formatCount(file.deletions)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="ib-rv-progress" aria-live="polite">
            {mode === 'walkthrough'
              ? `${reviewedCount} of ${plural(chapters.length, 'chapter')} reviewed`
              : `${viewed.filter((path) => files.some((file) => file.path === path)).length} of ${plural(files.length, 'file')} viewed`}
          </div>
        </nav>
        <div className="ib-gbody" ref={bodyRef}>
          {phone && (
            // A phone has no rail: its switch, and the chapters or files as a native list to jump to.
            <div className="ib-rv-phonebar" data-review-phonebar="">
              {railModes}
              <select
                className="ib-rv-jump"
                aria-label={mode === 'walkthrough' ? 'Go to a chapter' : 'Go to a file'}
                value=""
                onChange={(event) => {
                  const value = event.target.value;
                  if (mode === 'walkthrough') toChapter(value === 'overview' ? null : Number(value));
                  else if (value) toFile(value);
                }}
              >
                <option value="" disabled>
                  {mode === 'walkthrough' ? `Chapters · ${reviewedCount} of ${chapters.length} reviewed` : `Files · ${plural(files.length, 'file')}`}
                </option>
                {mode === 'walkthrough' ? (
                  <>
                    <option value="overview">Overview</option>
                    {chapters.map((chapter, index) => (
                      <option key={`${chapter.title}:${index}`} value={String(index)}>
                        {`${index + 1}. ${chapter.title}${(reviewed[index] ?? snapshot?.guide.reviewed[index]) ? ' ✓' : ''}`}
                      </option>
                    ))}
                  </>
                ) : (
                  files.map((file) => (
                    <option key={file.path} value={file.path}>
                      {`${file.path}${viewedSet.has(file.path) ? ' ✓' : ''}`}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}
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
            <LazyBlockBoundary fallback={(notice) => <div className="ib-gerror">{notice}</div>}>
              <Suspense fallback={null}>
                <GuideReader
                  snapshot={snapshot}
                  reviewed={reviewed}
                  onReviewedChange={changeReviewed}
                  comments={readerComments}
                  mode={mode}
                  reveal={reveal}
                  viewed={viewedProp}
                />
              </Suspense>
            </LazyBlockBoundary>
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
    </section>
  );
}

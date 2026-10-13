/**
 * A guided review open in the Inbox (the record's 4.2): it takes the window
 * the way an attachment does, under a header naming who sent it, with
 * Plannotator's guide viewer below. The viewer mounts through a dynamic import
 * (React.lazy): in the single-file build its code is inline and its modules
 * run at page load, but nothing of the guide renders until Open. Reviewed
 * ticks are kept with the thread, on the message in the store, so they
 * survive a reload, another browser and the Inbox moving to another port.
 *
 * The person comments on the diffs as in the review app (a line number, a
 * drag across lines, or code selected): each comment is kept in the store
 * with the thread's other annotations, listed in the panel beside the guide
 * and in the reply's "N annotations", and rides the next Send as the review
 * app's export under "Feedback on the guided review". A resolved thread
 * shows the guide read-only.
 */

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxAnnotationRecord, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { InboxApiError, inboxApi } from '../api';
import { guideCommentOf } from '../attachments';
import { agentName, whenTime, plural } from '../format';
import { Icon } from '../icons';
import { useNarrowerThan } from '../narrower';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
const GuideReader = lazy(() => import('#guide-reader'));

export interface GuidePaneProps {
  thread: InboxThread;
  message: InboxMessageWire;
  /** Back to the thread. */
  onBack: () => void;
  /** Close the guide and the thread. */
  onClose: () => void;
}

/**
 * The guide's width below which the 300 px comments panel folds into the
 * header's Comments button and opens over the guide: beside it the guide's
 * cards would squeeze their diffs to a narrow column (about 170 px in a
 * 1024 px window). The guide at 1280 px and wider keeps the panel docked.
 */
export const GUIDE_FOLD_PANEL_BELOW = 1200;

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];

export function GuidePane({ thread, message, onBack, onClose }: GuidePaneProps) {
  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<boolean[]>(() => message.guide_reviewed ?? []);
  const [saveError, setSaveError] = useState<string | null>(null);
  // This guide's comments waiting for a Send, as the store keeps them.
  const [records, setRecords] = useState<InboxAnnotationRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; token: number } | null>(null);
  // Read only once archived, unless the guide arrived after the archive line (it behaves as an open thread's).
  const archiveSeq = thread.archive_seq ?? null;
  const readOnly = thread.resolved_at !== null && !(archiveSeq !== null && (message.seq ?? 0) > archiveSeq);
  /**
   * Bumped by every local save or removal: a read of the thread's annotations
   * that started before it answers with the store as it was, and must not put
   * back a comment just removed or drop one just saved.
   */
  const localWrites = useRef(0);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(GUIDE_FOLD_PANEL_BELOW, false);
  /** The folded panel, open over the guide. */
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  /** Close the sheet from inside it (its close, Escape): focus goes back to the button that opened it. */
  const closeSheet = () => {
    setSheet(false);
    sheetButtonRef.current?.focus({ preventScroll: true });
  };
  // Escape closes the open sheet before it closes the guide (App's handler skips a used Escape).
  const onSheetKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && folded && sheet && !event.defaultPrevented) {
      event.preventDefault();
      closeSheet();
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    setReviewed(message.guide_reviewed ?? []);
    setSaveError(null);
    setSelectedId(null);
    inboxApi
      .guide(message.id)
      .then((answer) => {
        if (cancelled) return;
        const parsed = parseGuideSnapshot(answer.snapshot);
        if (parsed.ok) setSnapshot(parsed.value);
        else setError(`This guided review could not be read (${parsed.error.path}: ${parsed.error.message}).`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The guided review did not load.');
      });
    return () => {
      cancelled = true;
    };
    // A tick saved from another tab arrives with the thread; the open pane keeps its own until then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  // The comments: read with the thread's annotations, again whenever the thread changes (a Send, an edit in the reply's list, another tab).
  useEffect(() => {
    let cancelled = false;
    const startedAt = localWrites.current;
    inboxApi
      .attachments(thread.thread_id)
      .then((model) => {
        if (cancelled || localWrites.current !== startedAt) return;
        setRecords(model.annotations.filter((r) => r.message_id === message.id && r.guide));
      })
      .catch(() => {
        // The thread went away; the pane closes with it.
      });
    return () => {
      cancelled = true;
    };
  }, [thread, message.id]);

  const changeReviewed = (next: boolean[]) => {
    setReviewed(next);
    setSaveError(null);
    inboxApi.saveGuideReviewed(message.id, next).then(
      (saved) => setReviewed(saved.reviewed),
      (cause: unknown) => setSaveError(cause instanceof Error ? cause.message : 'The reviewed tick was not saved.'),
    );
  };

  const comments = useMemo(() => records.map(guideCommentOf).filter((c): c is CodeAnnotation => c !== null), [records]);

  const save = useCallback(
    (annotation: CodeAnnotation) => {
      setSaveError(null);
      localWrites.current += 1;
      inboxApi.saveGuideAnnotation(message.id, annotation).then(
        (saved) => {
          // Again on the answer: a read that started while the write was in flight may not hold it.
          localWrites.current += 1;
          setRecords((list) => [...list.filter((r) => r.id !== saved.annotation.id), saved.annotation]);
        },
        (cause: unknown) => setSaveError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.'),
      );
    },
    [message.id],
  );
  const remove = useCallback((id: string) => {
    setSaveError(null);
    localWrites.current += 1;
    inboxApi.removeAnnotation(id).then(
      () => {
        localWrites.current += 1;
        setRecords((list) => list.filter((r) => r.id !== id));
      },
      (cause: unknown) => setSaveError(cause instanceof InboxApiError ? cause.message : 'The comment was not removed.'),
    );
  }, []);
  const edit = (id: string, updates: Partial<CodeAnnotation>) => {
    const before = comments.find((c) => c.id === id);
    if (before) save({ ...before, ...updates });
  };
  const showComment = (id: string) => {
    setSelectedId(id);
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };

  const readerComments = useMemo(
    () => (readOnly ? undefined : { annotations: comments, selectedId, onSelect: setSelectedId, onSave: save, onDelete: remove, scrollTarget }),
    [readOnly, comments, selectedId, save, remove, scrollTarget],
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}`}
      aria-label="Guided review"
      data-guide-message={message.id}
    >
      <div className="ib-vhead">
        <button type="button" className="ib-back" onClick={onBack}>
          <Icon name="back" size={15} />
          Thread
        </button>
        <span className="ib-vsep" />
        <span className="ib-fn">Guided review</span>
        <span className="ib-from">
          from {agentName(message.author)} in {thread.project.name}, sent {whenTime(message.created_at)}
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
            title="Comments"
            data-guide-comments-sheet=""
          >
            <Icon name="comment" size={15} />
            {comments.length}
          </button>
        )}
        <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the guided review">
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-gsplit">
        <div className="ib-gbody">
          {saveError && (
            <div className="ib-error ib-gerror" role="alert">
              {saveError}
            </div>
          )}
          {error ? (
            <div className="ib-error ib-gerror" role="alert">
              {error}
            </div>
          ) : snapshot ? (
            <Suspense fallback={null}>
              <GuideReader snapshot={snapshot} reviewed={reviewed} onReviewedChange={changeReviewed} comments={readerComments} />
            </Suspense>
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
          {/* The folded panel's sheet: its own title and close. */}
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
            // A folded panel draws as a sheet of its own (the panel's window-wide overlay below 768 px has no close here).
            presentation={folded ? 'embedded' : undefined}
            annotations={NO_ANNOTATIONS}
            blocks={NO_BLOCKS}
            codeAnnotations={comments}
            onSelect={(id) => {
              showComment(id);
              // A folded panel steps aside to show the comment in the guide.
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
          {comments.length > 0 && (
            <div className="ib-gstrip">
              <span className="ib-rchip" data-strip-chip="">
                {plural(comments.length, 'comment')}
              </span>
              <span className="ib-l">ride your next Send to {agentName(message.author)}.</span>
              <span className="ib-sp" />
              <button type="button" className="ib-btn ib-sm" onClick={onBack}>
                <Icon name="back" size={14} />
                Back to the thread
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

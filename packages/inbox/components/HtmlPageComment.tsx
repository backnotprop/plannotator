/**
 * A comment on an HTML page on a phone (approval "inbox-html-attachments-phone"):
 * instead of the dimmed box over the page, a pin or a text selection opens the
 * full-screen composer's card on its Comment tab, as an image's does, and the
 * page stays in sight above it. `HtmlViewer` hands the draft over (`onHostDraft`,
 * as the iPhone app's surface does); this holds it until it is saved or dropped.
 *
 * The card reads: what the comment is on, Parent and Child to move a pin to the
 * element around it or back in (`stepPin`), the field and Comment. The field is
 * the reply's (`InboxComposerField`: `@` tags and `/` skills), inside
 * `data-image-composer`, so the pane's Escape rungs treat it as they treat an
 * image's comment row. Words typed when the file closes wait as its draft
 * (`kept`), and come back on the same pin or words when it opens again
 * (`expect`, then the page's own draft); so do the files added to it.
 *
 * Focus lands in the field for a pin. A selection leaves it in the page, where
 * the person may still be dragging its handles; moving it would end them.
 *
 * Words outlive their target: a new pin or a Parent keeps them, and a tap on the
 * page that clears a selection closes the card only while it holds none. A
 * selection lost to focus leaving the frame leaves the card as it is: the bridge
 * does not report that one, and the quote is in the draft.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationType, type Annotation, type HostDraft } from '@plannotator/ui/types';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { shortLabel } from '../attachments';
import { composerMinimized, openComposerComment, setComposerMinimized, showComposerComment } from '../fullScreenComposer';
import { Icon } from '../icons';
import { isWindowPinched } from '../windowPinch';
import { useRowDraft, type CommentDraft } from '../fileCommentDrafts';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { FullScreenCommentBin } from './FullScreenComposer';
import { TagNotes } from './TagPicker';
import { useCommentFiles, type CommentFiles } from '../commentFiles';
import { usePhone } from '../phone';
import type { InboxUpload } from '@plannotator/core/inbox-types';

export interface HtmlPageCommentOptions {
  /** The card can open: a phone's full screen on a page that takes comments. Off, any open draft goes. */
  enabled: boolean;
  /** What the draft belongs to: another file drops it (the pane kept typed words as that file's draft first). */
  fileKey: string;
  threadId: string | null;
  /** The file's name, for the field's label. */
  name: string;
  viewer: RefObject<ViewerHandle | null>;
  /** The agents a comment can tag: the reply's. */
  tags?: InboxComposerTags;
  onSave: (annotation: Annotation) => Promise<boolean>;
  /** How much of the frame the card covers, for the pin to clear it. */
  covered: () => number;
  /** The comment was saved or dropped from the card: focus goes back to the pane, with what to say. */
  onDone: (saying: string | null) => void;
}

export interface HtmlPageComment {
  /** A draft is open: the card shows it, and it stays while the window is zoomed. */
  open: boolean;
  /** For `HtmlViewer`. */
  onHostDraft: (draft: HostDraft | null) => void;
  /** The card for a pin or a selection, or null: the Comment tab shows the page's own row (`HtmlPageCommentRow`). */
  card: ReactNode | null;
  /** For the composer's minimize: a comment with no words yet is dropped. */
  onMinimized: () => void;
  /** The comment being written, as the file closes (its words as `text`, what it is on, its files), or null: it holds none. */
  kept: () => CommentDraft | null;
  /** The next draft the page hands over (a kept comment put back on its pin or words) opens holding its words and files. */
  expect: (draft: CommentDraft) => void;
}

export function useHtmlPageComment({ enabled, fileKey, threadId, name, viewer, tags, onSave, covered, onDone }: HtmlPageCommentOptions): HtmlPageComment {
  const [draft, setDraft] = useState<HostDraft | null>(null);
  const [words, setWords] = useState('');
  const [saving, setSaving] = useState(false);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mentions = useRef<readonly string[]>([]);
  /** Puts back the card's tab and fold as the comment found them. */
  const restore = useRef<(() => void) | null>(null);
  /** Parent or Child was pressed: the next draft is the same comment, focus stays where it is. */
  const stepping = useRef(false);
  /** The words and files a kept comment had, for the draft the page hands over next (`expect`). */
  const expected = useRef<CommentDraft | null>(null);
  /** Pictures and files added to the comment (a phone's card: the paperclip and a paste). They go with its words. */
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const files = useCommentFiles({
    phone: true,
    inCard: true,
    field: () => fieldRef.current,
    text: { get value() { return wordsRef.current; }, set: setWords },
  });
  const clearFiles = files.clear;
  /** The files as drawn now, for the callbacks below (which keep one identity). */
  const filesNow = useRef(files);
  filesNow.current = files;
  /** Files wait in the card: as words do, they keep it open. */
  const holdsFiles = useRef(false);
  holdsFiles.current = files.ready > 0 || files.uploading;

  const drop = useCallback(() => {
    setDraft(null);
    setWords('');
    clearFiles();
    mentions.current = [];
    restore.current?.();
    restore.current = null;
  }, [clearFiles]);

  const onHostDraft = useCallback(
    (next: HostDraft | null) => {
      if (next === null) {
        // The selection went away while words wait for it: the quote is in the draft, so they can still be saved.
        if (wordsRef.current.trim() === '' && !holdsFiles.current) drop();
        return;
      }
      if (threadId) {
        if (restore.current) showComposerComment(threadId);
        else restore.current = openComposerComment(threadId);
      }
      setDraft(next);
      const back = expected.current;
      if (back !== null) {
        setWords(back.annotation.text ?? '');
        filesNow.current.restore(back.files ?? [], back.late ?? []);
        expected.current = null;
      }
    },
    [threadId, drop],
  );
  const kept = useCallback((): CommentDraft | null => {
    const held = draftRef.current;
    const text = wordsRef.current;
    if (!held) return null;
    // Its files go with its words (uploads still on their way land in the draft), or alone.
    const added = filesNow.current.handOver();
    if (text.trim() === '' && added.files.length === 0 && added.late.length === 0) return null;
    return { kind: 'comment', annotation: { ...held.annotation, text, ...(mentions.current.length > 0 ? { mentions: mentions.current } : {}) }, files: added.files, late: added.late };
  }, []);
  const expect = useCallback((draft: CommentDraft) => {
    expected.current = draft;
  }, []);

  const onMinimized = useCallback(() => {
    if (!draftRef.current || wordsRef.current.trim() !== '' || holdsFiles.current) return;
    draftRef.current.cancel();
    drop();
    // Minimize asked for the pill, whatever the card was before the comment.
    if (threadId && !composerMinimized(threadId, true)) setComposerMinimized(threadId, true);
  }, [threadId, drop]);

  const submit = async () => {
    const held = draftRef.current;
    const text = wordsRef.current.trim();
    const images = files.images();
    if (!held || (!text && images.length === 0) || saving || files.uploading) return;
    setSaving(true);
    const annotation: Annotation = { ...held.annotation, text, ...(mentions.current.length > 0 ? { mentions: mentions.current } : {}), ...(images.length > 0 ? { images } : {}) };
    const ok = await onSave(annotation);
    setSaving(false);
    if (!ok) return;
    held.cancel();
    viewer.current?.applySharedAnnotations([annotation]);
    drop();
    onDone('Comment saved.');
  };

  // Another file or version, or the card can no longer open (a linked page came over the file).
  useEffect(() => drop, [enabled, fileKey, drop]);

  // The pinned element stays in sight above the card, and above the keyboard when it comes up.
  const pinned = draft?.intent === 'compose' ? draft.annotation.id : null;
  useEffect(() => {
    if (!pinned) return;
    const reveal = () => viewer.current?.revealPin?.({ clearBottom: covered() });
    const frame = requestAnimationFrame(reveal);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', reveal);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', reveal);
    };
    // `covered` reads the page as it is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, viewer]);

  const fieldTags = useMemo<InboxComposerTags | undefined>(() => {
    const options = tags?.options;
    if (!options) return undefined;
    const owner = options.find((o) => o.owner) ?? null;
    return {
      options,
      onChange: (ids) => {
        mentions.current = ids;
      },
      note: ({ id, tagged }) => <TagNotes id={id} tagged={tagged} owner={owner} where="comment" />,
    };
  }, [tags?.options]);

  const card = draft ? (
    <HtmlCommentCard
      draft={draft}
      name={name}
      words={words}
      onWords={setWords}
      fieldRef={fieldRef}
      files={files}
      saving={saving}
      tags={fieldTags}
      onSubmit={() => void submit()}
      onStep={(direction) => {
        stepping.current = true;
        viewer.current?.stepPin?.(direction);
      }}
      stepping={stepping}
    />
  ) : null;

  return { open: draft !== null, onHostDraft, card, onMinimized, kept, expect };
}

function HtmlCommentCard({
  draft,
  name,
  words,
  onWords,
  fieldRef,
  files,
  saving,
  tags,
  onSubmit,
  onStep,
  stepping,
}: {
  draft: HostDraft;
  name: string;
  words: string;
  onWords: (text: string) => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  files: CommentFiles;
  saving: boolean;
  tags?: InboxComposerTags;
  onSubmit: () => void;
  onStep: (direction: 'parent' | 'child') => void;
  stepping: RefObject<boolean>;
}) {
  const enterSavesComment = useConfigValue('enterSavesComment');
  const pin = draft.intent === 'compose';
  // The words it is on, as the approved card reads; an element with none (a picture) has its kind.
  const target = shortLabel(draft.annotation.originalText) || draft.label || '';

  useEffect(() => {
    const wasStep = stepping.current;
    stepping.current = false;
    if (!pin || wasStep) return;
    // Zoomed, the card can be out of the view: the browser brings it in.
    fieldRef.current?.focus({ preventScroll: !isWindowPinched() });
  }, [draft.annotation.id, pin, stepping]);

  return (
    <div className="ib-fcomp-comment ib-htmlcomment" data-image-composer="" data-html-comment={draft.intent}>
      <div className="ib-htmlcomment-on">
        <span className="ib-htmlcomment-t" data-html-comment-target="">
          {target}
        </span>
        {pin && (
          <>
            {/* Pressing one keeps focus in the field, so the keyboard stays up. */}
            <button type="button" className="ib-fvb" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep('parent')} aria-label="Comment on the element around it" data-html-comment-step="parent">
              <Icon name="arrowUp" size={18} />
            </button>
            <button type="button" className="ib-fvb" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep('child')} aria-label="Comment on the element inside it" data-html-comment-step="child">
              <Icon name="arrowDown" size={18} />
            </button>
          </>
        )}
      </div>
      <div className="ib-ccard" onPaste={files.onPaste}>
        {files.tiles}
        {files.dropTarget}
        <div className="ib-fcomp-field">
          <InboxComposerField
            textareaRef={fieldRef}
            value={words}
            onChange={onWords}
            onKeyDown={(event) => {
              if (!isCommentSubmitKey(event, enterSavesComment)) return;
              event.preventDefault();
              event.stopPropagation();
              onSubmit();
            }}
            placeholder="Comment on this…"
            ariaLabel={`Comment on ${name}: ${target}`}
            destination="your comment"
            tags={tags}
          />
        </div>
        {files.clip}
        <FullScreenCommentBin />
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={onSubmit} disabled={saving || files.uploading || (words.trim() === '' && files.ready === 0)} data-html-comment-save="">
          Comment
        </button>
      </div>
    </div>
  );
}

/** Where a page row's words (and the files added to it) wait while the row is off screen and the file still open (a linked page over it). */
export type PageCommentParking = { current: { key: string; text: string; files?: readonly InboxUpload[]; late?: readonly Promise<InboxUpload | null>[] } | null };

/** A fresh id for a comment on the whole page. */
function pageCommentId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-page-${crypto.randomUUID()}` : `ann-page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The page's own comment row: the full-screen composer's Comment tab on an HTML page, as an image's row is on an
 * image. A comment here is on the whole page: a general comment (`GLOBAL_COMMENT`, as the HTML viewer's own "Add
 * global comment" makes in annotate), kept on the attachment and sent with the reply ("General feedback about the
 * document"). A comment on an element or on words is the page's pin or selection, as before.
 *
 * Its words are a row draft (`useRowDraft`): they wait as the file's draft when it closes, and come back with it.
 * `parking` keeps them while the row is off screen with the file still open (a linked page over it).
 */
export function HtmlPageCommentRow({
  fileKey,
  name,
  tags,
  parking,
  hidden = false,
  onSave,
}: {
  /** The file and version the row is for: its parked words are only ever its own. */
  fileKey: string;
  /** The file's name, for the field's label. */
  name: string;
  /** The agents a comment can tag: the reply's. */
  tags?: InboxComposerTags;
  parking: PageCommentParking;
  /** A pin's or a selection's card is in the tab (a phone's): the row stays drawn, hidden, its words kept. */
  hidden?: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
}) {
  const enterSavesComment = useConfigValue('enterSavesComment');
  /** The words as a save took them: the file closing before the save answers keeps no draft of them. */
  const sentWords = useRef<string | null>(null);
  const wordsRef = useRef('');
  const waiting = useRowDraft(() => {
    const kept = filesRef.current?.kept() ?? [];
    const late = filesRef.current?.flying() ?? [];
    return sentWords.current === wordsRef.current && kept.length === 0 && late.length === 0 ? null : { kind: 'row', text: wordsRef.current, markup: null, files: kept, late };
  });
  const [parked] = useState(() => (parking.current?.key === fileKey ? parking.current : null));
  const [words, setWords] = useState(() => waiting?.text ?? parked?.text ?? '');
  wordsRef.current = words;
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  // Pictures and files added to the comment (the reply box's paperclip, paste and drop): they go with its words.
  const files = useCommentFiles({
    initial: waiting?.files ?? parked?.files,
    late: waiting?.late ?? parked?.late,
    phone: usePhone(),
    inCard: true,
    field: () => fieldRef.current,
    text: { get value() { return wordsRef.current; }, set: setWords },
  });
  const filesRef = useRef(files);
  filesRef.current = files;
  const [saving, setSaving] = useState(false);
  const mentions = useRef<readonly string[]>([]);
  // Off screen with the file still open: the words wait here, and the row takes them back when it is drawn again.
  useLayoutEffect(() => {
    parking.current = null;
    return () => {
      const text = wordsRef.current;
      const kept = filesRef.current.kept();
      const late = filesRef.current.flying();
      parking.current = text.trim() !== '' && sentWords.current !== text ? { key: fileKey, text, files: kept, late } : kept.length > 0 || late.length > 0 ? { key: fileKey, text: '', files: kept, late } : null;
    };
  }, [fileKey, parking]);

  const fieldTags = useMemo<InboxComposerTags | undefined>(() => {
    const options = tags?.options;
    if (!options) return undefined;
    const owner = options.find((o) => o.owner) ?? null;
    return {
      options,
      onChange: (ids) => {
        mentions.current = ids;
      },
      note: ({ id, tagged }) => <TagNotes id={id} tagged={tagged} owner={owner} where="comment" />,
    };
  }, [tags?.options]);

  const submit = async () => {
    const text = words.trim();
    const images = files.images();
    if ((!text && images.length === 0) || saving || files.uploading) return;
    setSaving(true);
    sentWords.current = words;
    const back = files.sending(images);
    const ok = await onSave({
      id: pageCommentId(),
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.GLOBAL_COMMENT,
      text,
      originalText: '',
      createdA: Date.now(),
      ...(mentions.current.length > 0 ? { mentions: mentions.current } : {}),
      ...(images.length > 0 ? { images } : {}),
    });
    setSaving(false);
    if (!ok) {
      sentWords.current = null;
      back();
      return;
    }
    setWords('');
    mentions.current = [];
    files.clear();
  };

  return (
    <div className="ib-fcomp-comment" data-image-composer="" data-html-page-comment="" hidden={hidden || undefined}>
      <div className="ib-ccard" onPaste={files.onPaste}>
        {files.tiles}
        {files.dropTarget}
        <div className="ib-fcomp-field">
          <InboxComposerField
            textareaRef={fieldRef}
            value={words}
            onChange={setWords}
            onKeyDown={(event) => {
              if (!isCommentSubmitKey(event, enterSavesComment)) return;
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }}
            placeholder="Comment on this page…"
            ariaLabel={`Comment on ${name}`}
            destination="your comment"
            tags={fieldTags}
          />
        </div>
        {files.clip}
        <FullScreenCommentBin />
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={() => void submit()} disabled={saving || files.uploading || (words.trim() === '' && files.ready === 0)} data-html-page-comment-save="">
          Comment
        </button>
      </div>
    </div>
  );
}

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
 * `data-image-composer`, so the pane's unsaved-comment question and its Escape
 * rungs treat it as they treat an image's comment row.
 *
 * Focus lands in the field for a pin. A selection leaves it in the page, where
 * the person may still be dragging its handles; moving it would end them.
 *
 * Words outlive their target: a new pin or a Parent keeps them, and a tap on the
 * page that clears a selection closes the card only while it holds none. A
 * selection lost to focus leaving the frame leaves the card as it is: the bridge
 * does not report that one, and the quote is in the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { Annotation, HostDraft } from '@plannotator/ui/types';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { shortLabel } from '../attachments';
import { composerMinimized, openComposerComment, setComposerMinimized, showComposerComment } from '../fullScreenComposer';
import { Icon } from '../icons';
import { isWindowPinched } from '../windowPinch';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { TagNotes } from './TagPicker';

export interface HtmlPageCommentOptions {
  /** The card can open: a phone's full screen on a page that takes comments. Off, any open draft goes. */
  enabled: boolean;
  /** What the draft belongs to: another file drops it (the pane asked first about typed words). */
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
  /** The Comment tab's contents, or null: Reply only. */
  card: ReactNode | null;
  /** For the composer's minimize: a comment with no words yet is dropped. */
  onMinimized: () => void;
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

  const drop = useCallback(() => {
    setDraft(null);
    setWords('');
    mentions.current = [];
    restore.current?.();
    restore.current = null;
  }, []);

  const onHostDraft = useCallback(
    (next: HostDraft | null) => {
      if (next === null) {
        // The selection went away while words wait for it: the quote is in the draft, so they can still be saved.
        if (wordsRef.current.trim() === '') drop();
        return;
      }
      if (threadId) {
        if (restore.current) showComposerComment(threadId);
        else restore.current = openComposerComment(threadId);
      }
      setDraft(next);
    },
    [threadId, drop],
  );

  const onMinimized = useCallback(() => {
    if (!draftRef.current || wordsRef.current.trim() !== '') return;
    draftRef.current.cancel();
    drop();
    // Minimize asked for the pill, whatever the card was before the comment.
    if (threadId && !composerMinimized(threadId, true)) setComposerMinimized(threadId, true);
  }, [threadId, drop]);

  const submit = async () => {
    const held = draftRef.current;
    const text = wordsRef.current.trim();
    if (!held || !text || saving) return;
    setSaving(true);
    const annotation: Annotation = { ...held.annotation, text, ...(mentions.current.length > 0 ? { mentions: mentions.current } : {}) };
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

  return { open: draft !== null, onHostDraft, card, onMinimized };
}

function HtmlCommentCard({
  draft,
  name,
  words,
  onWords,
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
  saving: boolean;
  tags?: InboxComposerTags;
  onSubmit: () => void;
  onStep: (direction: 'parent' | 'child') => void;
  stepping: RefObject<boolean>;
}) {
  const enterSavesComment = useConfigValue('enterSavesComment');
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
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
              <Icon name="chevU" size={18} />
            </button>
            <button type="button" className="ib-fvb" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep('child')} aria-label="Comment on the element inside it" data-html-comment-step="child">
              <Icon name="chevD" size={18} />
            </button>
          </>
        )}
      </div>
      <div className="ib-ccard">
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
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={onSubmit} disabled={saving || words.trim() === ''} data-html-comment-save="">
          Comment
        </button>
      </div>
    </div>
  );
}

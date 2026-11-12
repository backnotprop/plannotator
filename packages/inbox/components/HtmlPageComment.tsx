import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import { AnnotationType, type Annotation, type HostDraft } from '@plannotator/ui/types';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { shortLabel } from '../attachments';
import { composerMinimized, openComposerComment, setComposerMinimized, showComposerComment } from '../fullScreenComposer';
import { Icon } from '../icons';
import { isWindowPinched } from '../windowPinch';
import { useRowDraft } from '../fileCommentDrafts';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { FullScreenCommentBin } from './FullScreenComposer';
import { TagNotes } from './TagPicker';

export interface HtmlPageCommentOptions {
  enabled: boolean;
  fileKey: string;
  threadId: string | null;
  name: string;
  viewer: RefObject<ViewerHandle | null>;
  tags?: InboxComposerTags;
  onSave: (annotation: Annotation) => Promise<boolean>;
  covered: () => number;
  onDone: (saying: string | null) => void;
}

export interface HtmlPageComment {
  open: boolean;
  onHostDraft: (draft: HostDraft | null) => void;
  card: ReactNode | null;
  onMinimized: () => void;
  kept: () => Annotation | null;
  expectWords: (text: string) => void;
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
  const restore = useRef<(() => void) | null>(null);
  const stepping = useRef(false);
  const expected = useRef<string | null>(null);

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
        if (wordsRef.current.trim() === '') drop();
        return;
      }
      if (threadId) {
        if (restore.current) showComposerComment(threadId);
        else restore.current = openComposerComment(threadId);
      }
      setDraft(next);
      if (expected.current !== null) {
        setWords(expected.current);
        expected.current = null;
      }
    },
    [threadId, drop],
  );
  const kept = useCallback((): Annotation | null => {
    const held = draftRef.current;
    const text = wordsRef.current;
    if (!held || text.trim() === '') return null;
    return { ...held.annotation, text, ...(mentions.current.length > 0 ? { mentions: mentions.current } : {}) };
  }, []);
  const expectWords = useCallback((text: string) => {
    expected.current = text;
  }, []);

  const onMinimized = useCallback(() => {
    if (!draftRef.current || wordsRef.current.trim() !== '') return;
    draftRef.current.cancel();
    drop();
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

  useEffect(() => drop, [enabled, fileKey, drop]);

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

  return { open: draft !== null, onHostDraft, card, onMinimized, kept, expectWords };
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
  const target = shortLabel(draft.annotation.originalText) || draft.label || '';

  useEffect(() => {
    const wasStep = stepping.current;
    stepping.current = false;
    if (!pin || wasStep) return;
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
            <button type="button" className="ib-fvb" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep('parent')} aria-label="Comment on the element around it" data-html-comment-step="parent">
              <Icon name="arrowUp" size={18} />
            </button>
            <button type="button" className="ib-fvb" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep('child')} aria-label="Comment on the element inside it" data-html-comment-step="child">
              <Icon name="arrowDown" size={18} />
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
        <FullScreenCommentBin />
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={onSubmit} disabled={saving || words.trim() === ''} data-html-comment-save="">
          Comment
        </button>
      </div>
    </div>
  );
}

export type PageCommentParking = { current: { key: string; text: string } | null };

function pageCommentId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-page-${crypto.randomUUID()}` : `ann-page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function HtmlPageCommentRow({
  fileKey,
  name,
  tags,
  parking,
  hidden = false,
  onSave,
}: {
  fileKey: string;
  name: string;
  tags?: InboxComposerTags;
  parking: PageCommentParking;
  hidden?: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
}) {
  const enterSavesComment = useConfigValue('enterSavesComment');
  const sentWords = useRef<string | null>(null);
  const wordsRef = useRef('');
  const waiting = useRowDraft(() => (sentWords.current === wordsRef.current ? null : { kind: 'row', text: wordsRef.current, markup: null }));
  const [words, setWords] = useState(() => waiting?.text ?? (parking.current?.key === fileKey ? parking.current.text : ''));
  wordsRef.current = words;
  const [saving, setSaving] = useState(false);
  const mentions = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    parking.current = null;
    return () => {
      const text = wordsRef.current;
      parking.current = text.trim() !== '' && sentWords.current !== text ? { key: fileKey, text } : null;
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
    if (!text || saving) return;
    setSaving(true);
    sentWords.current = words;
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
    });
    setSaving(false);
    if (!ok) {
      sentWords.current = null;
      return;
    }
    setWords('');
    mentions.current = [];
  };

  return (
    <div className="ib-fcomp-comment" data-image-composer="" data-html-page-comment="" hidden={hidden || undefined}>
      <div className="ib-ccard">
        <div className="ib-fcomp-field">
          <InboxComposerField
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
        <FullScreenCommentBin />
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={() => void submit()} disabled={saving || words.trim() === ''} data-html-page-comment-save="">
          Comment
        </button>
      </div>
    </div>
  );
}

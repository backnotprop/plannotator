import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { diagramTargetName, diagramTargetText } from '@plannotator/core/diagram-anchor';
import { cn } from '../../lib/utils';
import type { ScreenRect } from '../../utils/diagram-projection';
import { SparklesIcon } from '../SparklesIcon';
import { Button } from '../ui/button';
import { isCommentSubmitKey } from '../../utils/commentSubmitKey';
import type { DiagramComposerDraft } from './useDiagramComments';
import { getCommentCardEnabled } from '../../utils/commentCardPolicy';
import { Icon } from '../inbox-thread/icons';
import { CommentDraftScopeContext } from '../../utils/commentDraftScope';

const cardDrafts = new Map<string, string>();

/**
 * Enter saves, Shift+Enter breaks a line and Esc discards, and none of the three is spelled on
 * screen. It lives here because the markdown composer is bound to web-highlighter's selection
 * and the html composer to the sandbox bridge; neither reaches an app-owned svg.
 */

const COMPOSER_WIDTH_PX = 288;

export function DiagramComposer({
  draft,
  anchorRect,
  hostWidth,
  hostHeight = 0,
  sourceDirty,
  submitting,
  error,
  disabledReason,
  onSubmit,
  onCancel,
  onAskAI,
  initialText,
}: {
  draft: DiagramComposerDraft;
  anchorRect: ScreenRect;
  hostWidth: number;
  hostHeight?: number;
  sourceDirty: boolean;
  submitting: boolean;
  error: string | null;
  disabledReason?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  onAskAI?: (question: string) => Promise<boolean>;
  initialText?: string;
}) {
  // The comment card (opt-in, `configurePlannotatorUI({ commentCard })`): read once, so a box never changes look open.
  const [card] = useState(getCommentCardEnabled);
  const scope = useContext(CommentDraftScopeContext);
  const part = draft.primary.target;
  const cardKey = [scope, draft.sourceLine?.[0] ?? '', part.id ?? '', part.from ?? '', part.to ?? '', part.kind ?? '', diagramTargetText(part)].join('\u0000');
  // Words the host put back (a comment kept as the file's draft) win over the card's own draft, and become it: the
  // card then has one store, so a chevron after a reopen keeps them as any other draft.
  const [text, setTextState] = useState(() => initialText ?? (card ? cardDrafts.get(cardKey) ?? '' : ''));
  useEffect(() => {
    if (card && initialText !== undefined && initialText.trim() !== '') cardDrafts.set(cardKey, initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setText = (value: string) => {
    setTextState(value);
    if (!card) return;
    if (value.trim() !== '') cardDrafts.set(cardKey, value);
    else cardDrafts.delete(cardKey);
  };
  const [asking, setAsking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) textareaRef.current?.focus();
  }, [refocus]);

  const target = draft.primary.target;
  const unsavedPart = draft.sourceLine === null && sourceDirty;
  const canWrite = disabledReason === undefined && !unsavedPart;
  const rightFits = anchorRect.left + anchorRect.width + 12 + COMPOSER_WIDTH_PX <= hostWidth;
  const left = rightFits ? anchorRect.left + anchorRect.width + 12 : Math.max(0, anchorRect.left - COMPOSER_WIDTH_PX - 12);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    setHeight(rootRef.current?.offsetHeight ?? 0);
  });
  const top = Math.max(0, hostHeight > 0 && height > 0 ? Math.min(anchorRect.top, hostHeight - height) : anchorRect.top);

  const canAskAI = onAskAI !== undefined && !asking && !submitting && text.trim() !== '';
  const askAI = async () => {
    const question = text.trim();
    if (onAskAI === undefined || question === '' || asking) {
      textareaRef.current?.focus();
      return;
    }
    setAsking(true);
    let accepted = false;
    try {
      accepted = await onAskAI(question);
    } catch (error) {
      console.error('Ask AI action failed:', error);
    } finally {
      setAsking(false);
    }
    if (!accepted) setRefocus((n) => n + 1);
    else if (card) cardDrafts.delete(cardKey);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Ours: the canvas and whatever holds it (a popout) must not also
      // act on this Escape.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    // Enter saves here whatever the "Enter saves a comment" setting says (it always has: a diagram
    // comment is one short line); the shared check adds the IME guard Safari needs (keyCode 229)
    // and keeps Shift+Enter a newline.
    if (isCommentSubmitKey(event, true)) {
      event.preventDefault();
      if (canWrite && !asking && text.trim() !== '') submit();
    }
  };
  const sent = useRef(false);
  const submit = () => {
    if (card) sent.current = true;
    onSubmit(text);
  };
  useEffect(() => {
    if (error !== null) sent.current = false;
  }, [error]);
  const keyRef = useRef(cardKey);
  keyRef.current = cardKey;
  useEffect(() => () => {
    if (sent.current) cardDrafts.delete(keyRef.current);
  }, []);

  if (card && disabledReason === undefined) {
    const on = diagramTargetText(target);
    return (
      <div
        ref={rootRef}
        data-diagram-composer=""
        data-comment-card=""
        data-in-canvas=""
        role="dialog"
        aria-label={`Comment on ${on}`}
        className="pn-cbox"
        style={{ left, top, width: COMPOSER_WIDTH_PX }}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="pn-cbox-close" onClick={onCancel} aria-label="Close (your words are kept)" title="Close (your words are kept)" data-comment-card-close="">
          <Icon name="chevD" size={16} />
        </button>
        <div className="pn-cbox-quote">
          On {on} ({diagramTargetName(target)}){draft.sourceLine !== null && ` · line ${draft.sourceLine[0]}`}{draft.additional.length > 0 && ` · +${draft.additional.length} more`}
        </div>
        {unsavedPart && <p className="pn-cbox-note">This part is only in your unsaved draft. Save the diagram to comment on it.</p>}
        <div className="pn-cbox-field">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Comment…"
            rows={1}
            disabled={submitting || asking}
            className="pn-cbox-ta pn-cbox-plain"
          />
        </div>
        {error !== null && <p role="alert" className="pn-cbox-note pn-cbox-err">{error}</p>}
        <div className="pn-cbox-row">
          {onAskAI !== undefined && (
            <button type="button" data-diagram-ask-ai="" className="pn-cbox-tool pn-cbox-word" onClick={() => void askAI()} disabled={!canAskAI} title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}>
              <SparklesIcon className="h-3.5 w-3.5" />
              Ask AI
            </button>
          )}
          <span className="pn-cbox-mid" />
          {text !== '' && (
            <button
              type="button"
              className="pn-cbox-tool pn-cbox-bin"
              onClick={() => { cardDrafts.delete(cardKey); setTextState(''); onCancel(); }}
              aria-label="Discard this comment"
              title="Discard this comment"
              data-comment-card-discard=""
            >
              <Icon name="trash" size={15} />
            </button>
          )}
          <button type="button" className="pn-cbox-save" disabled={!canWrite || submitting || asking || text.trim() === ''} onClick={submit} data-comment-card-submit="">
            Comment
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-diagram-composer=""
      role="dialog"
      aria-label={`Comment on ${diagramTargetText(target)}`}
      className="pointer-events-auto absolute z-10 flex w-72 max-w-full flex-col gap-1.5 rounded-md border border-border bg-card p-2 shadow-lg"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Keys inside the composer never reach the canvas's zoom keys.
        event.stopPropagation();
      }}
    >
      <div className="text-[10px] text-muted-foreground">
        On <span className="font-medium text-foreground">{diagramTargetText(target)}</span> ({diagramTargetName(target)})
        {draft.sourceLine !== null && ` · line ${draft.sourceLine[0]}`}
        {draft.additional.length > 0 && ` · +${draft.additional.length} more`}
      </div>
      {disabledReason === undefined ? (
        <>
          {unsavedPart && (
            <p className="text-[10px] text-warning">This part is only in your unsaved draft. Save the diagram to comment on it.</p>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Add a comment..."
            rows={3}
            disabled={submitting || asking}
            className={cn(
              'w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground',
              'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )}
          />
          {error !== null && (
            <p role="alert" className="text-[10px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-1">
            {onAskAI !== undefined && (
              <button
                type="button"
                data-diagram-ask-ai=""
                onClick={() => void askAI()}
                disabled={!canAskAI}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title={canAskAI ? 'Ask AI this question' : 'Type a question to ask AI'}
              >
                <SparklesIcon className="h-3 w-3" />
                Ask AI
              </button>
            )}
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" size="xs" disabled={!canWrite || submitting || asking || text.trim() === ''} onClick={submit}>
              Comment
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

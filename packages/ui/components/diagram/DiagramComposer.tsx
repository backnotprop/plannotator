import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { diagramTargetName, diagramTargetText } from '@plannotator/core/diagram-anchor';
import { cn } from '../../lib/utils';
import type { ScreenRect } from '../../utils/diagram-projection';
import { SparklesIcon } from '../SparklesIcon';
import { Button } from '../ui/button';
import type { DiagramComposerDraft } from './useDiagramComments';

/**
 * The inline composer beside the ring: the part's label as the context
 * line, a textarea, Cancel and Comment. Enter saves, Shift+Enter breaks a
 * line and Esc discards, and none of the three is spelled on screen (owner
 * ruling; the markdown composer shows no hint either). It lives here
 * because the markdown composer is bound to web-highlighter's selection and
 * the html composer to the sandbox bridge; neither reaches an app-owned svg.
 *
 * With `onAskAI` it also offers the markdown composer's "Ask AI": the typed
 * text is asked as a question about the part instead of saved as a comment.
 * Disabled until there is text, never bound to a key (Enter stays Comment,
 * as Mod+Enter stays Save in the markdown composer), and the composer closes
 * once the host accepts the question.
 */

/** The composer's width; it sits to the right of the ring and flips left
 * when the host is too narrow there. */
const COMPOSER_WIDTH_PX = 288;

export function DiagramComposer({
  draft,
  anchorRect,
  hostWidth,
  sourceDirty,
  submitting,
  error,
  disabledReason,
  onSubmit,
  onCancel,
  onAskAI,
}: {
  draft: DiagramComposerDraft;
  anchorRect: ScreenRect;
  hostWidth: number;
  sourceDirty: boolean;
  submitting: boolean;
  /** The last submit's failure, shown under the textarea. */
  error: string | null;
  /** When set, commenting is off for this viewer and the composer says
   * why instead of offering a textarea. */
  disabledReason?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** Ask the typed text as a question about this part. Resolves true when
   * the host took it (the composer then closes), false to keep the draft.
   * Absent: no Ask AI button. */
  onAskAI?: (question: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  // A refused question hands the keyboard back to the textarea, once it is
  // enabled again (it is disabled while the question is pending).
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) textareaRef.current?.focus();
  }, [refocus]);

  const target = draft.primary.target;
  const unsavedPart = draft.sourceLine === null && sourceDirty;
  const canWrite = disabledReason === undefined && !unsavedPart;
  const rightFits = anchorRect.left + anchorRect.width + 12 + COMPOSER_WIDTH_PX <= hostWidth;
  const left = rightFits ? anchorRect.left + anchorRect.width + 12 : Math.max(0, anchorRect.left - COMPOSER_WIDTH_PX - 12);

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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canWrite && !asking && text.trim() !== '') onSubmit(text);
    }
  };

  return (
    <div
      data-diagram-composer=""
      role="dialog"
      aria-label={`Comment on ${diagramTargetText(target)}`}
      className="pointer-events-auto absolute z-10 flex w-72 flex-col gap-1.5 rounded-md border border-border bg-card p-2 shadow-lg"
      style={{ left, top: Math.max(0, anchorRect.top) }}
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
            <Button type="button" size="xs" disabled={!canWrite || submitting || asking || text.trim() === ''} onClick={() => onSubmit(text)}>
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@plannotator/ui/components/ui/button';
import { submitHint } from '@plannotator/ui/utils/platform';
import { useCompactTouchLayout } from '@plannotator/ui/hooks/useIsMobile';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@plannotator/ui/components/ui/dialog';

/**
 * One-step "send with a note" for the code review surface.
 *
 * The note itself is not owned here: App materializes it at submit time as a
 * `scope: 'general'` CodeAnnotation so it rides `exportReviewFeedback`'s
 * `## General` section and the `/api/feedback` annotations array with no server
 * change. This component only owns the affordance and the typed text
 * (deliberately local, so a keystroke never re-renders the review header).
 *
 * Interaction contract:
 * - The control is ONE joined split button: [Send Feedback | v]. The left
 *   segment is always the incumbent plain send, unchanged; the caret is a
 *   separate segment of the same pill.
 * - The caret opens a panel BELOW the pill with a multi-line note field and its
 *   own distinct action, "Send with additional feedback", which sends the note
 *   together with everything already in the session. The two actions never
 *   share a button.
 * - The note field: Enter inserts a newline, Mod+Enter submits with feedback,
 *   Esc closes the panel and keeps the half-typed text.
 *
 * DUPLICATE, ON PURPOSE. Its annotate twin is
 * `packages/editor/components/AnnotateSendControl.tsx`; the two share the field
 * contract but not their props (this one carries responsive toolbar labels, a
 * three-way busy expression and a compact dialog sibling). Tripwire: if a THIRD
 * surface ever needs this field, extract the textarea + auto-grow + key
 * handling as `packages/ui/components/SubmitNoteField.tsx` and have both
 * controls compose it — as its own PR, never mixed into a feature.
 */
export interface ReviewSubmitNoteControl {
  /** Submit this note together with any annotations already in the session. */
  onSubmit: (text: string) => void;
}

export const REVIEW_NOTE_PLACEHOLDER = 'Add a note...';

/** Deliberately frozen, maintainer-approved label for the distinct action. It
 *  must never collapse into the incumbent Send Feedback button's label. */
export const REVIEW_NOTE_SEND_LABEL = 'Send with additional feedback';

/** Two lines tall at rest, grows with content, then scrolls. */
const NOTE_MAX_HEIGHT_PX = 144;

function useAutoGrow(text: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, NOTE_MAX_HEIGHT_PX)}px`;
  }, [text]);
  return ref;
}

interface ReviewNoteFieldProps {
  text: string;
  onTextChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onClose: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** The multi-line note field. Controlled: the owner keeps the text so closing
 *  and reopening does not discard a half-typed note. */
const ReviewNoteField: React.FC<ReviewNoteFieldProps> = ({
  text,
  onTextChange,
  onSubmit,
  onClose,
  disabled = false,
  autoFocus = true,
}) => {
  const ref = useAutoGrow(text);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const canSend = text.trim().length > 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        // Stop here: the review app runs its own Escape ladder (file tree,
        // sidebar, dialogs), and a bare Escape in this field is ours.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled && canSend) onSubmit(text);
      }
      // Plain Enter falls through: the field is multi-line and Enter's job is
      // a newline.
    },
    [canSend, disabled, onClose, onSubmit, text],
  );

  return (
    <textarea
      ref={ref}
      rows={2}
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={REVIEW_NOTE_PLACEHOLDER}
      aria-label={REVIEW_NOTE_PLACEHOLDER}
      data-review-note-input="true"
      data-pn-mobile-editable
      className="block w-full resize-none overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-snug text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
      style={{ maxHeight: NOTE_MAX_HEIGHT_PX }}
    />
  );
};

interface ReviewNoteSendButtonProps {
  onClick: () => void;
  disabled: boolean;
}

/** Always renders full-strength: while the panel is open this is THE submit,
 *  and a grayed action beside the deliberately faded header primary read as
 *  "everything is disabled" in maintainer review. An empty-note click is a
 *  no-op that refocuses the field instead. */
const ReviewNoteSendButton: React.FC<ReviewNoteSendButtonProps> = ({ onClick, disabled }) => (
  <Button
    variant="outline"
    size="xs"
    data-review-note-send="true"
    onClick={onClick}
    disabled={disabled}
    title={REVIEW_NOTE_SEND_LABEL}
    iconLeft={<Send className="size-3.5" />}
  >
    {REVIEW_NOTE_SEND_LABEL}
  </Button>
);

/**
 * The compact/touch note composer. The desktop panel is an anchored dropdown,
 * which is the wrong shape inside the header's scrollable ActionMenu popup
 * (it closes on outside pointerdown and its max-height fights the soft
 * keyboard), so compact gets a dialog opened from an additive menu row.
 */
export const ReviewNoteDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  note: ReviewSubmitNoteControl;
  disabled?: boolean;
  annotationCount?: number;
}> = ({ isOpen, onClose, note, disabled = false, annotationCount = 0 }) => {
  const isCompactTouchLayout = useCompactTouchLayout();
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0;

  const submit = useCallback(() => {
    if (disabled || !canSend) return;
    note.onSubmit(text);
    setText('');
    onClose();
  }, [canSend, disabled, note, onClose, text]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        data-review-note-composer="dialog"
        // Opening the sheet must not raise the touch keyboard on its own.
        initialFocus={isCompactTouchLayout ? false : undefined}
        className="max-w-md rounded-xl bg-card p-4 text-foreground"
      >
        <DialogTitle className="font-semibold mb-1">Add a note</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground mb-3">
          {annotationCount > 0
            ? `Sent with your ${annotationCount} annotation${annotationCount === 1 ? '' : 's'}.`
            : 'Sent to the agent as review-level feedback.'}
        </DialogDescription>
        <ReviewNoteField
          text={text}
          onTextChange={setText}
          onSubmit={submit}
          onClose={onClose}
          disabled={disabled}
          autoFocus={!isCompactTouchLayout}
        />
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] leading-snug text-muted-foreground">{submitHint}</span>
          <ReviewNoteSendButton onClick={submit} disabled={disabled} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

interface ReviewSendControlProps {
  /** True when the session already carries annotations (code, editor,
   *  description or PR comment). False flips the primary into the
   *  zero-annotation fast path. */
  hasFeedback: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  /** The incumbent Send Feedback action. Always plain send, never the note. */
  onSend: () => void;
  note: ReviewSubmitNoteControl;
}

/**
 * The joined split Send control for agent-mode code review. See the module doc
 * for the interaction contract; the load-bearing detail is that Send Feedback
 * and Send-with-additional-feedback are DIFFERENT buttons — the incumbent never
 * changes meaning, and the note panel carries its own action.
 */
export const ReviewSendControl: React.FC<ReviewSendControlProps> = ({
  hasFeedback,
  disabled = false,
  isLoading = false,
  onSend,
  note,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  // A submit in flight (or an approve/exit) must not leave the panel hanging
  // over a toolbar whose buttons have all gone disabled.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const submitNote = useCallback(
    (value: string) => {
      if (value.trim().length === 0) {
        // Empty note: keep the panel open and put the cursor back in the
        // field. The action stays visually live (see ReviewNoteSendButton).
        containerRef.current
          ?.querySelector<HTMLTextAreaElement>('[data-review-note-input]')
          ?.focus();
        return;
      }
      setOpen(false);
      setText('');
      note.onSubmit(value);
    },
    [note],
  );

  /** The incumbent action. With feedback: plain send, exactly as before this
   *  control existed. With none: sending nothing only raised the "No
   *  Annotations" dialog, so the click opens the note panel instead. */
  const primaryAction = useCallback(() => {
    if (hasFeedback) onSend();
    else setOpen(true);
  }, [hasFeedback, onSend]);

  return (
    <div ref={containerRef} className="relative">
      {/* One pill, two segments: a hairline divider where they meet. */}
      <div className="inline-flex items-center">
        <Button
          variant="outline"
          size="xs"
          onClick={primaryAction}
          disabled={disabled || open}
          title={
            open
              ? 'Close the note to send without it'
              : hasFeedback
                ? 'Send feedback'
                : 'Send Feedback: write a quick note'
          }
          iconLeft={<Send className="size-3.5" />}
          className={`rounded-r-none border-r-0 transition-opacity ${open ? 'opacity-40' : ''}`}
        >
          {/* Same responsive spans FeedbackButton renders at
              labelBreakpoint="lg", so the toolbar width is unchanged. */}
          <span className="hidden lg:inline xl:hidden">{isLoading ? 'Sending...' : 'Send'}</span>
          <span className="hidden xl:inline">{isLoading ? 'Sending...' : 'Send Feedback'}</span>
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-review-note-toggle="true"
          aria-expanded={open}
          aria-label="Add a note and send with feedback"
          title="Add a note and send with feedback"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          className={`rounded-l-none px-1.5 ${open ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
        >
          <svg
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </Button>
      </div>
      {open && (
        <div
          data-review-note-composer="anchored"
          className="absolute right-0 top-full z-50 mt-1.5 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1.5 shadow-xl"
        >
          <ReviewNoteField
            text={text}
            onTextChange={setText}
            onSubmit={submitNote}
            onClose={close}
            disabled={disabled}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
            <span className="text-[11px] leading-snug text-muted-foreground">{submitHint}</span>
            <ReviewNoteSendButton
              onClick={() => submitNote(text)}
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
};

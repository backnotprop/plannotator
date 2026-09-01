import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@plannotator/ui/components/ui/button';
import { submitHint } from '@plannotator/ui/utils/platform';

/**
 * One-step "send with a note" for the annotate surfaces.
 *
 * The note itself is not owned here: App creates it as a GLOBAL_COMMENT at
 * submit time so it rides `exportAnnotations` and the `/api/feedback`
 * annotations array with no server change. This component only owns the
 * affordance and the typed text (deliberately local, so a keystroke never
 * re-renders the whole header).
 *
 * Interaction contract:
 * - The control is ONE joined split button: [Send Feedback | v]. The left
 *   segment is always the incumbent plain send, unchanged; the caret is a
 *   separate segment of the same pill.
 * - The caret opens a panel BELOW the pill with a multi-line note field and
 *   its own distinct action, "Submit with feedback", which sends the note
 *   together with everything already in the session. The two actions never
 *   share a button.
 * - The note field: Enter inserts a newline, Mod+Enter submits with feedback,
 *   Esc closes the panel and keeps the half-typed text.
 */
export interface AnnotateSubmitNoteControl {
  /** Submit this note together with any annotations already in the session. */
  onSubmit: (text: string) => void;
}

export const ANNOTATE_NOTE_PLACEHOLDER = 'Add a note...';

/** One line tall at rest, grows with content, then scrolls. */
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

interface AnnotateNoteFieldProps {
  text: string;
  onTextChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onClose: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** The multi-line note field. Controlled: the owner keeps the text so closing
 *  and reopening does not discard a half-typed note. */
const AnnotateNoteField: React.FC<AnnotateNoteFieldProps> = ({
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
        // Stop here: the surrounding surfaces (the HTML pinpoint ladder,
        // popovers, the plan-diff exit) all treat a bare Escape as theirs.
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
      placeholder={ANNOTATE_NOTE_PLACEHOLDER}
      aria-label={ANNOTATE_NOTE_PLACEHOLDER}
      data-annotate-note-input="true"
      className="block w-full resize-none overflow-y-auto rounded-md border border-border bg-background px-2.5 py-1.5 text-sm leading-snug text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/40"
      style={{ maxHeight: NOTE_MAX_HEIGHT_PX }}
    />
  );
};

/** The compact touch review surface's always-expanded note field. Owns its own
 *  text so `CompactPlanReview` stays a presentational list. */
export const AnnotateNoteSheet: React.FC<{
  note: AnnotateSubmitNoteControl;
  disabled?: boolean;
  hint?: string;
}> = ({ note, disabled = false, hint }) => {
  const [text, setText] = useState('');
  return (
    <div data-annotate-note-composer="sheet" className="rounded-xl border border-border bg-background/40 p-2">
      <AnnotateNoteField
        text={text}
        onTextChange={setText}
        onSubmit={(value) => {
          note.onSubmit(value);
          setText('');
        }}
        onClose={() => setText('')}
        disabled={disabled}
        // The sheet is always expanded; focusing it would raise the touch
        // keyboard every time the Review surface opens.
        autoFocus={false}
      />
      <p className="mt-1.5 px-0.5 text-right text-[11px] leading-snug text-muted-foreground">
        {hint ?? `${submitHint} to send`}
      </p>
    </div>
  );
};

interface AnnotateSendControlProps {
  /** True when the session already carries annotations or document edits.
   *  False flips the primary action into the zero-annotation fast path. */
  hasFeedback: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  /** The incumbent Send Feedback action. Always plain send, never the note. */
  onSend: () => void;
  note: AnnotateSubmitNoteControl;
}

/**
 * The joined split Send control for annotate sessions. See the module doc for
 * the interaction contract; the load-bearing detail is that Send Feedback and
 * Submit-with-feedback are DIFFERENT buttons — the incumbent never changes
 * meaning, and the note panel carries its own action.
 */
export const AnnotateSendControl: React.FC<AnnotateSendControlProps> = ({
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

  const submitNote = useCallback(
    (value: string) => {
      setOpen(false);
      setText('');
      note.onSubmit(value);
    },
    [note],
  );

  /** The incumbent action. With feedback: plain send, exactly as before this
   *  control existed. With none: sending nothing was never useful (the old
   *  header hid the button entirely), so the click opens the note panel. */
  const primaryAction = useCallback(() => {
    if (hasFeedback) onSend();
    else setOpen(true);
  }, [hasFeedback, onSend]);

  const canSubmitNote = text.trim().length > 0;

  return (
    <div ref={containerRef} className="relative">
      {/* One pill, two segments: a hairline divider where they meet. */}
      <div className="inline-flex items-center">
        <Button
          variant="outline"
          size="xs"
          onClick={primaryAction}
          disabled={disabled}
          title={hasFeedback ? 'Send Feedback' : 'Send Feedback: write a quick note'}
          iconLeft={<Send className="size-3.5" />}
          className="rounded-r-none border-r-0"
        >
          {isLoading ? 'Sending...' : 'Send Feedback'}
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-annotate-note-toggle="true"
          aria-expanded={open}
          aria-label="Add a note and submit with feedback"
          title="Add a note and submit with feedback"
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
          data-annotate-note-composer="anchored"
          className="absolute right-0 top-full z-50 mt-1.5 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1.5 shadow-xl"
        >
          <AnnotateNoteField
            text={text}
            onTextChange={setText}
            onSubmit={submitNote}
            onClose={close}
            disabled={disabled}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
            <span className="text-[11px] leading-snug text-muted-foreground">{submitHint}</span>
            <Button
              variant="outline"
              size="xs"
              data-annotate-note-send="true"
              onClick={() => submitNote(text)}
              disabled={disabled || !canSubmitNote}
              title="Send with additional feedback"
              iconLeft={<Send className="size-3.5" />}
            >
              Send with additional feedback
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

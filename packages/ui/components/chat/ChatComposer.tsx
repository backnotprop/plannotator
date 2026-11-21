import { Send, Square } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../../lib/utils';
import { isImeCompositionKey } from '../../utils/commentSubmitKey';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { CHAT_SEND_BUTTON, CHAT_STOP_BUTTON, FOCUS_RING } from './chatRecipes';

/**
 * The text box's own box: border, radius, padding and type size. Spelled once
 * so a host's layer painted over the field (`overlay`) can share its metrics.
 * The scrollbar gutter is reserved, so a field that scrolls wraps where the
 * layer does. 16 px below md keeps iOS Safari from zooming on focus.
 */
export const CHAT_COMPOSER_FIELD_BOX =
  'rounded-md border px-3 py-2 text-base md:text-sm [scrollbar-gutter:stable]';

export interface ChatComposerProps {
  /** The field's text. The composer is controlled: it holds none itself, so
   * `onChange` must set this in the same tick or typing and IME input are lost. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Enter in the field, Mod+Enter included, and the Send button. It runs even
   * while `busy` or with an empty box, so a host decides what those mean. */
  readonly onSend: () => void;
  /** False: plain Enter is a new line and Mod+Enter or the button sends. For a
   * touch keyboard, which has no Shift to make a new line with. */
  readonly sendOnEnter?: boolean;
  /** Stop, while `busy`. */
  readonly onStop?: () => void;
  /** A reply is running: the Send button becomes Stop. */
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** The field's accessible name. */
  readonly label?: string;
  readonly placeholder?: string;
  readonly sendLabel?: string;
  readonly stopLabel?: string;
  /** The host's handle on the field. */
  readonly composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Above the box (errors, queued messages). */
  readonly notices?: React.ReactNode;
  /** The quiet context line under the box. */
  readonly below?: React.ReactNode;
  /** The row with Send, left of it. */
  readonly toolbar?: React.ReactNode;
  /** In the box's positioned wrapper, before the field (a host's own menu). */
  readonly assist?: React.ReactNode;
  /** Painted over the field, in the field's own box. */
  readonly overlay?: React.ReactNode;
  /** Extra field classes. */
  readonly fieldClassName?: string;
  /** The id of the element describing what the message carries. */
  readonly describedBy?: string;
  /** With a host's menu in `assist`: whether it is open and which row is active. */
  readonly expanded?: boolean;
  readonly activeDescendant?: string;
  /** Files pasted into the field. Absent: the paste is left to the browser. */
  readonly onFiles?: (files: readonly File[]) => void;
  /** Pasted text, before the field takes it: true when the host took it. */
  readonly onPasteText?: (text: string) => boolean;
  /** The caret or the selection moved. */
  readonly onCaret?: (field: HTMLTextAreaElement) => void;
  /** An IME composition started (true) or ended (false). */
  readonly onComposing?: (composing: boolean) => void;
  /** Runs before the composer's own keys; `preventDefault` keeps Enter from sending. */
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** The message box. It has no picker of its own; a host adds one through `assist`. */
export function ChatComposer({
  value,
  onChange,
  onSend,
  sendOnEnter = true,
  onStop,
  busy = false,
  disabled,
  label = 'Message',
  placeholder,
  sendLabel = 'Send',
  stopLabel = 'Stop',
  composerRef,
  notices,
  below,
  toolbar,
  assist,
  overlay,
  fieldClassName,
  describedBy,
  expanded,
  activeDescendant,
  onFiles,
  onPasteText,
  onCaret,
  onComposing,
  onKeyDown,
}: ChatComposerProps) {
  return (
    <div className="flex max-h-[60%] shrink-0 flex-col gap-2 border-t border-border px-3 pb-2 pt-2.5">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto empty:hidden">{notices}</div>
      <div className="relative shrink-0">
        {assist}
        <Textarea
          ref={composerRef}
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label}
          aria-autocomplete={expanded === undefined ? undefined : 'list'}
          aria-expanded={expanded}
          aria-activedescendant={activeDescendant}
          aria-describedby={describedBy}
          // The box grows with its text up to 128 px, then scrolls inside itself.
          className={cn(
            CHAT_COMPOSER_FIELD_BOX,
            'field-sizing-content max-h-32 min-h-16 resize-none bg-card shadow-none',
            FOCUS_RING,
            fieldClassName,
          )}
          onChange={(event) => onChange(event.target.value)}
          onSelect={(event) => onCaret?.(event.currentTarget)}
          onClick={(event) => onCaret?.(event.currentTarget)}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
              onCaret?.(event.currentTarget);
            }
          }}
          onCompositionStart={() => onComposing?.(true)}
          onCompositionEnd={() => onComposing?.(false)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length > 0 && onFiles !== undefined) {
              event.preventDefault();
              onFiles(files);
              return;
            }
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (text !== '' && onPasteText?.(text) === true) event.preventDefault();
          }}
          onKeyDown={(event) => {
            // Enter, in any chord, does not bubble past the React root, so a
            // bubble listener on window or document (a Send elsewhere on the
            // page) does not hear it. Capture listeners and native listeners on
            // the box's ancestors still do, and keyup is not stopped.
            const enter = event.key === 'Enter';
            if (enter) event.stopPropagation();
            // Safari's Enter that commits a composition has isComposing false
            // and keyCode 229; this checks both.
            if (isImeCompositionKey(event)) return;
            onKeyDown?.(event);
            if (!enter || event.defaultPrevented) return;
            const mod = event.metaKey || event.ctrlKey;
            if (!mod && (event.shiftKey || !sendOnEnter)) return; // a new line
            event.preventDefault();
            if (!event.shiftKey) onSend();
          }}
        />
        {overlay}
      </div>
      {below}
      <div className="flex min-w-0 shrink-0 items-center gap-1" data-chat-composer-toolbar>
        {toolbar}
        <div className="ml-auto shrink-0">
          {busy ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={stopLabel}
              className={CHAT_STOP_BUTTON}
              onClick={onStop}
            >
              <Square aria-hidden="true" className="size-3" />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label={sendLabel}
              className={CHAT_SEND_BUTTON}
              disabled={disabled}
              onClick={onSend}
            >
              <Send aria-hidden="true" className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

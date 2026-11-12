import { Send, Square } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../../lib/utils';
import { isImeCompositionKey } from '../../utils/commentSubmitKey';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { CHAT_SEND_BUTTON, CHAT_STOP_BUTTON, FOCUS_RING } from './chatRecipes';

export const CHAT_COMPOSER_FIELD_BOX =
  'rounded-md border px-3 py-2 text-base md:text-sm [scrollbar-gutter:stable]';

export interface ChatComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly sendOnEnter?: boolean;
  readonly onStop?: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly placeholder?: string;
  readonly sendLabel?: string;
  readonly stopLabel?: string;
  readonly composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  readonly notices?: React.ReactNode;
  readonly below?: React.ReactNode;
  readonly toolbar?: React.ReactNode;
  readonly assist?: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly fieldClassName?: string;
  readonly describedBy?: string;
  readonly expanded?: boolean;
  readonly activeDescendant?: string;
  readonly onFiles?: (files: readonly File[]) => void;
  readonly onPasteText?: (text: string) => boolean;
  readonly onCaret?: (field: HTMLTextAreaElement) => void;
  readonly onComposing?: (composing: boolean) => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

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
            const enter = event.key === 'Enter';
            if (enter) event.stopPropagation();
            if (isImeCompositionKey(event)) return;
            onKeyDown?.(event);
            if (!enter || event.defaultPrevented) return;
            const mod = event.metaKey || event.ctrlKey;
            if (!mod && (event.shiftKey || !sendOnEnter)) return;
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

import { useRef, useState } from 'react';
import { INBOX_THREAD_NAME_MAX } from '@plannotator/core/inbox-types';
import { shownThreadName, typeThreadName, type ThreadNameState } from './model';

/** At most `INBOX_THREAD_NAME_MAX` code points; `maxLength` would count UTF-16 units and stop an emoji name early. */
export function capThreadName(value: string): string {
  const points = [...value];
  return points.length > INBOX_THREAD_NAME_MAX ? points.slice(0, INBOX_THREAD_NAME_MAX).join('') : value;
}

export const THREAD_NAME_PLACEHOLDER = 'Name this thread';

function widthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x1f300 ? 2 : 1;
  }
  return n;
}

export const THREAD_NAME_PASTE_WORDS = 8;

export function pasteOverflows(current: string, pasted: string): boolean {
  return (
    /[\r\n]/.test(pasted) ||
    [...current].length + [...pasted].length > INBOX_THREAD_NAME_MAX ||
    pasted.trim().split(/\s+/).filter(Boolean).length >= THREAD_NAME_PASTE_WORDS
  );
}

export const THREAD_NAME_OVERFLOW_NOTE = 'Too long for a name, so it went into your message.';
export const THREAD_NAME_ATTACHED_NOTE = 'Too long for a name, so it was attached to your message.';

export function ThreadNameChip(props: {
  state: ThreadNameState;
  suggested: string;
  hint?: string;
  onChange: (state: ThreadNameState) => void;
  onDone: () => void;
  onOverflow: (text: string) => string | void;
  error?: string | null;
  action?: { label: string; name: string; onPress: () => void; disabled?: boolean; picture?: React.ReactNode } | null;
  idBase: string;
}) {
  const { state, suggested, hint, onChange, onDone, onOverflow, error = null, action = null, idBase } = props;
  const [note, setNote] = useState<string | null>(null);
  // Emptied while focused: show it empty until focus leaves, then follow the message again.
  const [clearing, setClearing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const value = clearing && !state.edited ? '' : shownThreadName(state, suggested);
  const mode = state.edited ? 'edited' : 'auto';
  const columns = Math.min(40, Math.max(widthOf(value || THREAD_NAME_PLACEHOLDER), 4)) + 1;
  const errorId = `${idBase}-err`;
  const hintId = `${idBase}-hint`;
  const noteId = `${idBase}-note`;
  const auto = !state.edited && value !== '';

  return (
    <span className="ib-cp-tnamew">
      <span
        className="ib-key ib-cp-tname"
        data-compose-thread-name={mode}
        data-auto={auto ? '' : undefined}
        data-empty={value === '' ? '' : undefined}
        data-invalid={error && !action ? '' : undefined}
        data-offer={error && action ? '' : undefined}
        onMouseDown={(event) => {
          if (event.target === inputRef.current) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="ib-cp-tname-in"
          aria-label="Thread name"
          aria-describedby={[error ? errorId : null, hintId, note ? noteId : null].filter(Boolean).join(' ')}
          aria-invalid={error && !action ? true : undefined}
          placeholder={THREAD_NAME_PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="next"
          dir="auto"
          value={value}
          style={{ width: `${columns}ch` }}
          onChange={(event) => {
            const next = typeThreadName(capThreadName(event.target.value));
            setClearing(!next.edited);
            setNote(null);
            onChange(next);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text/plain');
            if (!text || !pasteOverflows(event.currentTarget.value, text)) return;
            event.preventDefault();
            event.stopPropagation();
            setNote(onOverflow(text) || THREAD_NAME_OVERFLOW_NOTE);
          }}
          onBlur={() => setClearing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              onDone();
            }
          }}
        />
        {auto && (
          <span className="ib-cp-tname-auto" aria-hidden="true">
            auto
          </span>
        )}
      </span>
      <span id={hintId} className="ib-sr">
        {state.edited ? 'Your name for the thread.' : (hint ?? 'Named from your message until you type here.')}
      </span>
      {note && !error && (
        <span className="ib-cp-tname-note" id={noteId} role="status" data-compose-thread-name-note="">
          {note}
        </span>
      )}
      {error && (
        <span className="ib-cp-tname-err" data-offer={action ? '' : undefined}>
          <span id={errorId} role={action ? 'status' : 'alert'} data-compose-thread-name-error="">
            {error}
          </span>
          {action && (
            <span className="ib-cp-tname-to">
              {action.picture}
              <button type="button" className="ib-lnk ib-cp-tname-go" aria-label={action.name} disabled={action.disabled} onClick={action.onPress} data-compose-thread-name-join="">
                {action.label}
              </button>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

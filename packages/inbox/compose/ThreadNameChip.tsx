/**
 * Compose's thread chip (the owner's 2026-10-16 note on #1956: "why can't I
 * just type in the little chip?"): the thread's name, drawn as the grey chip
 * the list shows, and a real text field. It follows the message while the
 * person has not typed in it (`suggested`, compose's short suggestion), and
 * stops following once they do. Emptied, it follows the message again, but
 * only once focus leaves it, so it never refills under the person's caret.
 *
 * While it follows the message its words are muted and a small "auto"
 * follows them; a screen reader hears the same through aria-describedby.
 * Nothing to suggest yet: an empty dashed chip saying "Name this thread".
 * `error` (the name is taken, or not a valid name) is said beside it.
 * Enter moves to the message; Escape is the dialog's (close or ask).
 *
 * Text pasted into it that is not a name (a line break, longer than a name
 * may be, or a whole sentence: dictation lands here when the chip has focus)
 * is never cut short: it goes to the message instead (`onOverflow`), and the
 * chip says so.
 *
 * Room left for later: joining an existing thread would be a ⌄ after the
 * chip, the way To has one.
 */
import { useRef, useState } from 'react';
import { INBOX_THREAD_NAME_MAX } from '@plannotator/core/inbox-types';
import { shownThreadName, typeThreadName, type ThreadNameState } from './model';

/** At most `INBOX_THREAD_NAME_MAX` code points; `maxLength` would count UTF-16 units and stop an emoji name early. */
export function capThreadName(value: string): string {
  const points = [...value];
  return points.length > INBOX_THREAD_NAME_MAX ? points.slice(0, INBOX_THREAD_NAME_MAX).join('') : value;
}

export const THREAD_NAME_PLACEHOLDER = 'Name this thread';

/** Columns of monospace text: CJK, Hangul and emoji take two. */
function widthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x1f300 ? 2 : 1;
  }
  return n;
}

/** Words a pasted name may have before it reads as a sentence (dictation), not a name. */
export const THREAD_NAME_PASTE_WORDS = 8;

/**
 * Pasted text that is not a thread name: a line break, longer than a name may
 * be once added, or a sentence (`THREAD_NAME_PASTE_WORDS` words or more).
 */
export function pasteOverflows(current: string, pasted: string): boolean {
  return (
    /[\r\n]/.test(pasted) ||
    [...current].length + [...pasted].length > INBOX_THREAD_NAME_MAX ||
    pasted.trim().split(/\s+/).filter(Boolean).length >= THREAD_NAME_PASTE_WORDS
  );
}

export const THREAD_NAME_OVERFLOW_NOTE = 'Too long for a name, so it went into your message.';
/** A paste of 32 KB or more into the chip goes to the message as a pasted text tile (approval "inbox-paste-attachment"). */
export const THREAD_NAME_ATTACHED_NOTE = 'Too long for a name, so it was attached to your message.';

export function ThreadNameChip(props: {
  state: ThreadNameState;
  suggested: string;
  onChange: (state: ThreadNameState) => void;
  onDone: () => void;
  /** Text pasted into the chip that cannot be a name: the caller puts it in the message (and may say how, in the note). */
  onOverflow: (text: string) => string | void;
  error?: string | null;
  idBase: string;
}) {
  const { state, suggested, onChange, onDone, onOverflow, error = null, idBase } = props;
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
        data-invalid={error ? '' : undefined}
        // The chip's padding (and a phone's larger hit area) puts the caret in the field.
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
          aria-invalid={error ? true : undefined}
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
            // Never cut short: the words go to the message, said beside the chip.
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
        {state.edited ? 'Your name for the thread.' : 'Named from your message until you type here.'}
      </span>
      {note && !error && (
        <span className="ib-cp-tname-note" id={noteId} role="status" data-compose-thread-name-note="">
          {note}
        </span>
      )}
      {error && (
        <span className="ib-cp-tname-err" id={errorId} role="alert" data-compose-thread-name-error="">
          {error}
        </span>
      )}
    </span>
  );
}

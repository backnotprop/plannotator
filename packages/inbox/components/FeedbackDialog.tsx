import { useEffect, useId, useRef, useState } from 'react';
import { FEEDBACK_CONTACT_MAX, FEEDBACK_MESSAGE_MAX, FEEDBACK_UNAVAILABLE, feedbackInputError, type FeedbackCategory } from '@plannotator/core/product-feedback';
import { Icon } from '../icons';
import { searchShipped, type SearchHit } from '../feedbackSearch';
import { Modal } from './Updates';

/** Shown under the box once the message is this close to the cap. */
const COUNT_FROM = FEEDBACK_MESSAGE_MAX - 400;
const SEARCH_PAUSE_MS = 250;

const NOTHING_TYPED = { message: '', category: null as FeedbackCategory | null, contact: '' };
/** What was typed and not sent, for the window's life: any close, even a stray press on the backdrop, loses nothing. */
let unsent = NOTHING_TYPED;
export function forgetUnsentFeedback() {
  unsent = NOTHING_TYPED;
}

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
];

export interface FeedbackDialogProps {
  /** This Inbox's version, named in the "what is sent" line. */
  version: string;
  phone: boolean;
  /** Sends through the Inbox's server; resolves, or rejects with an Error whose message is shown. */
  onSend: (input: { message: string; category: FeedbackCategory | null; contact: string | null }) => Promise<void>;
  /** "Prompt your agent to send feedback": copies the prompt (with what is typed so far) and closes; the window's toast says how it went. */
  onCopyPrompt: (draft: string) => void;
  onClose: () => void;
}

function lengthOf(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

/**
 * Sidebar → Feedback: a short form that sends the person's words about
 * Plannotator to its maintainers. A message; "These might help" links when a
 * search finds something similar; an optional category and an optional email;
 * a line saying what is sent; Send and Cancel; a
 * short "Sent" state. "Prompt your agent to send feedback" copies a prompt that has
 * the person's agent collect the feedback and send it with
 * `plannotator feedback` after the person says yes. Nothing is sent without
 * Send. No shortcut (owner rule); Escape and the backdrop close it, as every
 * Inbox dialog. On a phone it is a bottom sheet.
 */
export function FeedbackDialog({ version, phone, onSend, onCopyPrompt, onClose }: FeedbackDialogProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [message, setMessage] = useState(unsent.message);
  const [category, setCategory] = useState(unsent.category);
  const [contact, setContact] = useState(unsent.contact);
  const [phase, setPhase] = useState<'edit' | 'sending' | 'sent'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    let latest = true;
    const pause = setTimeout(() => void searchShipped(message).then((found) => latest && setHits(found)), SEARCH_PAUSE_MS);
    return () => {
      latest = false;
      clearTimeout(pause);
    };
  }, [message]);
  useEffect(() => {
    unsent = { message, category, contact };
  }, [message, category, contact]);
  const sending = phase === 'sending';
  const count = lengthOf(message.trim());

  useEffect(() => {
    const box = boxRef.current;
    box?.focus();
    // Kept words go on from their end.
    box?.setSelectionRange(box.value.length, box.value.length);
  }, []);
  useEffect(() => {
    if (phase === 'sent') doneRef.current?.focus();
  }, [phase]);

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };

  const send = async () => {
    if (sending) return;
    const input = { message, category, contact: contact.trim() || null };
    const invalid = feedbackInputError(input);
    if (invalid) {
      setError(invalid);
      boxRef.current?.focus();
      return;
    }
    setError(null);
    setPhase('sending');
    try {
      await onSend({ ...input, message: message.trim() });
      forgetUnsentFeedback();
      setPhase('sent');
    } catch (cause) {
      setPhase('edit');
      setError(cause instanceof Error && cause.message ? cause.message : FEEDBACK_UNAVAILABLE);
    }
  };

  return (
    <Modal
      labelledBy={`ib-fbk-t-${uid}`}
      describedBy={phase === 'sent' ? undefined : `ib-fbk-what-${uid}`}
      testId="feedback"
      onClose={() => (sending ? undefined : close())}
      ownKeys
      // On a phone the opener (the Feedback row) was in the drawer, which closed: focus goes to the page heading, not <body>.
      fallbackFocus={pageHeading}
      className={`ib-fbk${phone ? ' ib-fbk-phone' : ''}`}
    >
      {phase === 'sent' ? (
        <div className="ib-fbk-sent" data-feedback-sent="">
          <Icon name="checkCircle" size={28} />
          <h2 id={`ib-fbk-t-${uid}`}>Thanks, it's sent</h2>
          <p className="ib-sub">Your feedback went to the Plannotator maintainers.</p>
          <div className="ib-acts-row">
            <button type="button" className="ib-btn ib-pri" ref={doneRef} data-feedback-done="" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="ib-fbk-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="ib-dlg-head">
            <h2 id={`ib-fbk-t-${uid}`}>Send feedback</h2>
            {!phone && (
              <button type="button" className="ib-btn ib-ghost ib-icon" aria-label="Close" onClick={close} disabled={sending}>
                <Icon name="x" />
              </button>
            )}
          </div>
          <label className="ib-bfield" htmlFor={`ib-fbk-msg-${uid}`}>
            <span className="ib-sr">Your feedback</span>
            <textarea
              id={`ib-fbk-msg-${uid}`}
              ref={boxRef}
              className="ib-fbk-msg"
              rows={phone ? 5 : 6}
              value={message}
              placeholder="What works, what doesn't, what you'd like…"
              aria-invalid={error ? true : undefined}
              aria-errormessage={error ? `ib-fbk-err-${uid}` : undefined}
              readOnly={sending}
              data-feedback-message=""
              onChange={(event) => {
                setMessage(event.target.value);
                if (error) setError(null);
              }}
            />
          </label>
          {count >= COUNT_FROM && (
            <p className={`ib-fbk-count${count > FEEDBACK_MESSAGE_MAX ? ' ib-fbk-over' : ''}`} aria-live="polite" data-feedback-count="">
              {count > FEEDBACK_MESSAGE_MAX
                ? `${(count - FEEDBACK_MESSAGE_MAX).toLocaleString('en-US')} over the limit`
                : `${(FEEDBACK_MESSAGE_MAX - count).toLocaleString('en-US')} characters left`}
            </p>
          )}
          <div className="ib-fbk-rel" role="status" data-feedback-related="">
            {hits.length > 0 && <p className="ib-fbk-rel-h">These might help</p>}
            {hits.length > 0 && (
              <ul>
                {hits.map((hit) => (
                  <li key={hit.href + hit.title}>
                    <a href={hit.href} target="_blank" rel="noopener noreferrer">
                      {hit.title}
                    </a>
                    {hit.definition && `. ${hit.definition}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Seen, not read twice: the group and the field already say "(optional)" to a screen reader. */}
          <p className="ib-fbk-optional" aria-hidden="true" data-feedback-optional="">
            Category and email are optional
          </p>
          <div className="ib-fbk-row">
            <div className="ib-fbk-cats" role="group" aria-label="Category (optional)">
              {CATEGORIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="ib-fbk-cat"
                  aria-pressed={category === option.value}
                  data-feedback-category={option.value}
                  disabled={sending}
                  // A second press clears it: the category is optional.
                  onClick={() => setCategory((current) => (current === option.value ? null : option.value))}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <input
              className="ib-fbk-contact"
              type="text"
              inputMode="email"
              autoComplete="email"
              aria-label="Email (optional)"
              placeholder="Email (optional)"
              maxLength={FEEDBACK_CONTACT_MAX}
              value={contact}
              readOnly={sending}
              data-feedback-contact=""
              onChange={(event) => setContact(event.target.value)}
              // Enter does not send (no new keys in the Inbox): only the Send button does.
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </div>
          <p className="ib-fbk-what" id={`ib-fbk-what-${uid}`} data-feedback-what="">
            <Icon name="info" />
            <span>
              Sends your message (and the category and email, if you add them), Plannotator {version}, the name of your OS and the names of the
              agents you use. Nothing from your threads or files.
            </span>
          </p>
          {error && (
            <p className="ib-callout ib-err ib-fbk-err" id={`ib-fbk-err-${uid}`} role="alert" data-feedback-error="">
              <Icon name="warn" />
              <span>{error}</span>
            </p>
          )}
          <div className="ib-acts-row ib-fbk-acts">
            <button type="button" className="ib-btn ib-ghost ib-left" data-feedback-copy-prompt="" disabled={sending} onClick={() => onCopyPrompt(message)}>
              <Icon name="copy" />
              Prompt your agent to send feedback
            </button>
            <button type="button" className="ib-btn" onClick={close} disabled={sending}>
              Cancel
            </button>
            <button type="submit" className="ib-btn ib-pri" aria-disabled={sending || undefined} data-feedback-send="">
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Focus after the dialog when its opener is gone: the page's heading (as AgentNoteDialog and SoundIntro do). */
function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

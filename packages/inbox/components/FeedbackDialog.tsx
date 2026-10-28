import { useEffect, useId, useRef, useState } from 'react';
import { FEEDBACK_CONTACT_MAX, FEEDBACK_MESSAGE_MAX, FEEDBACK_UNAVAILABLE, feedbackInputError, type FeedbackCategory } from '@plannotator/core/product-feedback';
import { Icon } from '../icons';
import { Modal } from './Updates';

/** Shown under the box once the message is this close to the cap. */
const COUNT_FROM = FEEDBACK_MESSAGE_MAX - 400;

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
 * Plannotator to its maintainers. A message, an optional category and an
 * optional email; a line saying exactly what is sent; Send and Cancel; a
 * short "Sent" state. "Prompt your agent to send feedback" copies a prompt that has
 * the person's agent collect the feedback and send it with
 * `plannotator feedback` after the person says yes. Nothing is sent without
 * Send. No shortcut (owner rule); Escape and the backdrop close it, as every
 * Inbox dialog. On a phone it is a bottom sheet.
 */
export function FeedbackDialog({ version, phone, onSend, onCopyPrompt, onClose }: FeedbackDialogProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [contact, setContact] = useState('');
  const [phase, setPhase] = useState<'edit' | 'sending' | 'sent'>('edit');
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);
  const sending = phase === 'sending';
  const count = lengthOf(message.trim());

  useEffect(() => {
    boxRef.current?.focus();
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
              Sends only your message (and the category and email, if you add them), Plannotator {version}, the name of your OS and that it came
              from the Inbox. Nothing from your threads or files.
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

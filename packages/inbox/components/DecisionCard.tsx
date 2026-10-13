import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InboxDecisionDraft } from '@plannotator/core/inbox-types';
import { DecisionDiamond, Icon } from '../icons';

/** The card's width in the record (3.1). */
const CARD_WIDTH = 400;
const GAP = 6;

/**
 * "Record as a decision": the full card of the approved decision toggle
 * (`inbox-decision-toggle` 2026-10-06, option A; the window record's 3.1),
 * opened from the words of a question's "Records a decision" tag and placed
 * under them, right edges aligned. "Decision" holds the draft (the answer,
 * focused), "Why (optional)" holds "Asked by <agent>: <question>", and "In
 * <project>, when you send" says where and when it records. The card only
 * keeps the words: Done saves them and turns recording on; the decision is
 * written at Send. Cancel, Escape and a click outside keep nothing.
 */
export function DecisionCard({
  anchor,
  drafted,
  draft,
  projectName,
  onCancel,
  onDone,
}: {
  /** The tag's words the card opened from. */
  anchor: HTMLElement;
  /** The drafted words: the answer as a statement (null when nothing is picked), and the Why line. */
  drafted: { text: string | null; reason: string };
  /** The words kept by an earlier Done, or null. */
  draft: InboxDecisionDraft | null;
  projectName: string;
  onCancel: () => void;
  onDone: (draft: InboxDecisionDraft | null) => Promise<void>;
}) {
  const id = useId();
  const card = useRef<HTMLFormElement>(null);
  const statement = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const [text, setText] = useState(draft?.text ?? drafted.text ?? '');
  const [reason, setReason] = useState(draft?.reason ?? drafted.reason);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  // Under the tag, right edges aligned; above it when the window has no room below.
  useLayoutEffect(() => {
    const position = () => {
      const tag = anchor.getBoundingClientRect();
      const height = card.current?.offsetHeight ?? 0;
      const left = Math.min(Math.max(12, tag.right - CARD_WIDTH), window.innerWidth - CARD_WIDTH - 12);
      const below = tag.bottom + GAP;
      const top = below + height > window.innerHeight - 12 && tag.top - GAP - height > 12 ? tag.top - GAP - height : below;
      setPlace({ top, left });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [anchor]);

  // The statement takes focus once the card is placed (it is hidden until then).
  useLayoutEffect(() => {
    if (!place || focused.current) return;
    focused.current = true;
    statement.current?.focus();
  }, [place]);

  useLayoutEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (card.current?.contains(target) || anchor.contains(target)) return;
      onCancel();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onCancel]);

  const submit = async () => {
    const statement = text.trim();
    if (!statement) {
      setError('Write the decision first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Unedited words stay the draft, which follows the answer.
      const keptText = statement === (drafted.text ?? '') ? null : statement;
      const keptReason = reason.trim() === drafted.reason ? null : reason.trim();
      await onDone(keptText === null && keptReason === null ? null : { text: keptText, reason: keptReason });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The decision was not kept.');
      setSaving(false);
    }
  };

  return createPortal(
    <div className="pn-inbox ib-deccard-layer">
      <form
        ref={card}
        className="ib-deccard"
        role="dialog"
        aria-labelledby={`${id}-title`}
        data-decision-card=""
        style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h4 id={`${id}-title`}>
          <DecisionDiamond />
          Record as a decision
        </h4>
        <label htmlFor={`${id}-text`}>Decision</label>
        <textarea ref={statement} id={`${id}-text`} className="ib-ta" value={text} rows={2} onChange={(event) => setText(event.target.value)} />
        <label htmlFor={`${id}-reason`}>
          Why <span>(optional)</span>
        </label>
        <textarea id={`${id}-reason`} className="ib-ta" value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
        <div className="ib-in" data-decision-card-where="">
          <Icon name="folder" size={14} />
          In {projectName}, when you send
        </div>
        {error && (
          <div className="ib-error" role="alert">
            {error}
          </div>
        )}
        <div className="ib-bt">
          <button type="button" className="ib-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri" disabled={saving}>
            Done
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

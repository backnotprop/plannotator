import type { OptionSet } from '../optionSets';
import { Icon } from '../icons';

/**
 * The card over a question's picture choices in full screen (approval
 * "inbox-option-card-lean", 2026-11-01): one row, the choice on screen. Its
 * letter, its name, "Recommended" in plain text when it is, and, off a phone,
 * ‹ Previous and Next › (they do what `[` and `]` do, and stay put, marked
 * disabled, at the ends). The count stays in the toolbar's pill; the question,
 * the dots and the end note are gone (the live region still says "Last option"
 * and where the other files are: `optionAnnouncement`). A phone swipes instead
 * of showing arrows. It is always one height, so the picture fits clear above
 * it (`--ib-optcap-h`); a long name gives way with an ellipsis, in full on hover.
 */
export function OptionCaption({ set, index, phone = false, onStep }: { set: OptionSet; index: number; phone?: boolean; onStep?: (dir: 1 | -1) => void }) {
  const choice = set.choices[index];
  if (!choice) return null;
  const prev = set.choices[index - 1];
  const next = set.choices[index + 1];
  const arrow = (dir: 1 | -1, to: OptionSet['choices'][number] | undefined) => (
    <button
      type="button"
      className="ib-optcap-step"
      aria-label={to ? `${dir < 0 ? 'Previous' : 'Next'} option: ${to.label}` : `${dir < 0 ? 'Previous' : 'Next'} option: this is the ${dir < 0 ? 'first' : 'last'}`}
      aria-disabled={to ? undefined : true}
      onClick={() => to && onStep?.(dir)}
      data-option-step={dir < 0 ? 'prev' : 'next'}
    >
      <Icon name={dir < 0 ? 'chevL' : 'chevR'} size={15} />
    </button>
  );
  return (
    <div className="ib-optcap" data-option-caption={choice.letter}>
      {!phone && arrow(-1, prev)}
      {!choice.lettered && (
        <span className="ib-optcap-letter" aria-hidden="true">
          {choice.letter}
        </span>
      )}
      <b
        className="ib-optcap-label"
        onMouseEnter={(event) => {
          // The full name on hover, only when it is cut.
          const el = event.currentTarget;
          if (el.scrollWidth > el.clientWidth) el.title = choice.label;
          else el.removeAttribute('title');
        }}
      >
        {!choice.lettered && <span className="sr-only">{`Option ${choice.letter}: `}</span>}
        {choice.label}
      </b>
      {choice.recommended && (
        <span className="ib-optcap-rec" data-option-recommended="">
          Recommended
        </span>
      )}
      {!phone && arrow(1, next)}
    </div>
  );
}

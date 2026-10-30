import { optionEndLine, type OptionSet } from '../optionSets';
import { Icon } from '../icons';

/**
 * The caption over a question's picture choices in full screen (approval
 * "inbox-image-swipe", "Option caption", `shots/1-…`, `shots/3-…`): the
 * choice on screen (its letter, its label, Recommended when it is), the
 * question in small text, one dot per choice, the one on screen long. At the
 * last choice it says where the thread's other files are: under the pill
 * (`4/4 ⌄`), whose sheet lists every file. It stays while the set is open, in
 * place of the step chip, above the toolbar.
 */
export function OptionCaption({ set, index, otherFiles, note }: { set: OptionSet; index: number; otherFiles: number; note: string | null }) {
  const choice = set.choices[index];
  if (!choice) return null;
  const end = optionEndLine(set, index, otherFiles, note);
  const total = set.choices.length;
  return (
    <div className="ib-optcap" data-option-caption={choice.letter}>
      <div className="ib-optcap-top">
        {!choice.lettered && (
          <span className="ib-optcap-letter" aria-hidden="true">
            {choice.letter}
          </span>
        )}
        <b className="ib-optcap-label">
          {!choice.lettered && <span className="sr-only">{`Option ${choice.letter}: `}</span>}
          {choice.label}
        </b>
        {choice.recommended && (
          <span className="ib-optcap-rec" data-option-recommended="">
            Recommended
          </span>
        )}
      </div>
      <div className="ib-optcap-q">
        <span className="ib-optcap-prompt">{set.prompt}</span>
        <span className="ib-optcap-dots" aria-hidden="true" data-option-dots={`${index + 1}/${total}`}>
          {set.choices.map((c, i) => (
            <i key={c.attachmentId} className={i === index ? 'ib-on' : undefined} />
          ))}
        </span>
      </div>
      {end && (
        <div className="ib-optcap-end" data-option-end="">
          {end.note}
          {end.others > 0 && (
            <>
              {` · the thread's ${end.others} other ${end.others === 1 ? 'file is' : 'files are'} under `}
              <b className="ib-optcap-pill">
                {index + 1}/{total}
                <Icon name="chevD" size={11} />
              </b>
            </>
          )}
        </div>
      )}
    </div>
  );
}

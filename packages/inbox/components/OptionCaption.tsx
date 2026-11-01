import { useEffect, useState } from 'react';
import { optionEndLine, type OptionSet } from '../optionSets';
import { Icon } from '../icons';

/** How long a phone's end note stays in the question's place once a choice is on screen. */
export const OPTION_NOTE_MS = 2400;

/**
 * The caption over a question's picture choices in full screen (approval
 * "inbox-image-swipe", "Option caption", `shots/1-…`, `shots/3-…`): the
 * choice on screen (its letter, its label, Recommended when it is), the
 * question in small text, one dot per choice, the one on screen long. At the
 * last choice it says where the thread's other files are: under the pill
 * (`4/4 ⌄`), whose sheet lists every file. It stays while the set is open, in
 * place of the step chip, above the toolbar.
 *
 * On a phone it is always one height, because the image fits above it (approval
 * "inbox-option-card-phone"): the end note takes the question's line for
 * `OPTION_NOTE_MS` after a step (and while the pane's own note shows, a swipe
 * past the end), then the question comes back.
 */
export function OptionCaption({ set, index, otherFiles, note, phone = false }: { set: OptionSet; index: number; otherFiles: number; note: string | null; phone?: boolean }) {
  // The choice whose note has had its time; a step away starts it over.
  const here = `${set.id}:${index}`;
  const [noted, setNoted] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setNoted(here), OPTION_NOTE_MS);
    return () => {
      clearTimeout(timer);
      setNoted(null);
    };
  }, [here]);
  const choice = set.choices[index];
  if (!choice) return null;
  const end = optionEndLine(set, index, otherFiles, note);
  const total = set.choices.length;
  const endPill = end && end.others > 0 && (
    <b className="ib-optcap-pill">
      {index + 1}/{total}
      <Icon name="chevD" size={11} />
    </b>
  );
  const noteInLine = phone && end !== null && (noted !== here || note !== null);
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
        {noteInLine ? (
          <span className="ib-optcap-prompt" data-option-end="">
            {end.note}
            {end.others > 0 && <>{` · ${end.others} other ${end.others === 1 ? 'file' : 'files'} under `}</>}
            {endPill}
          </span>
        ) : (
          <span className="ib-optcap-prompt">{set.prompt}</span>
        )}
        <span className="ib-optcap-dots" aria-hidden="true" data-option-dots={`${index + 1}/${total}`}>
          {set.choices.map((c, i) => (
            <i key={c.attachmentId} className={i === index ? 'ib-on' : undefined} />
          ))}
        </span>
      </div>
      {end && !phone && (
        <div className="ib-optcap-end" data-option-end="">
          {end.note}
          {end.others > 0 && (
            <>
              {` · the thread's ${end.others} other ${end.others === 1 ? 'file is' : 'files are'} under `}
              {endPill}
            </>
          )}
        </div>
      )}
    </div>
  );
}

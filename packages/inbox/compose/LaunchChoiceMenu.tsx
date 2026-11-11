import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { Icon } from '../icons';
import { launchChoiceButton, launchModelRows, shortLaunchModel } from './launchChoice';

/**
 * Compose's Model and Effort for a new session (docs/agent-guides/inbox-launch.md "Model and effort"): a quiet button
 * after "in <folder>" on To's line (a phone's start line), and its menu, drawn as the folder menu is (the picker's
 * rows, captions and check). Nothing to press for someone who leaves it: the button reads "Default model", and a Send
 * carries nothing. A pick keeps the menu open (Model and Effort are two picks); a press outside, Escape or the phone's
 * Back closes it. No keys of its own beyond Tab, Enter and Escape.
 */
export function LaunchChoiceButton({ choice, choices, open, onToggle, className }: { choice: InboxLaunchChoice; choices: InboxLaunchChoices; open: boolean; onToggle: () => void; className: string }) {
  const words = launchChoiceButton(choice, choices);
  return (
    <button
      type="button"
      className={`${className} ib-cp-lchbtn`}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={`Model and ${choices.effort_word.toLowerCase()}: ${words}. Change`}
      data-compose-choice={words}
      onClick={onToggle}
    >
      <span>{words}</span>
      <Icon name="chevD" size={13} />
    </button>
  );
}

export function LaunchChoiceMenu({
  choice,
  choices,
  phone,
  onChoice,
  onClose,
}: {
  choice: InboxLaunchChoice;
  choices: InboxLaunchChoices;
  phone: boolean;
  onChoice: (next: InboxLaunchChoice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('.ib-cp-lchbtn')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };
  /** Escape and Back: closed, and focus on the button that opened it. */
  const back = () => {
    const button = ref.current?.ownerDocument.querySelector<HTMLButtonElement>('.ib-cp-lchbtn');
    onClose();
    button?.focus();
  };
  const effortWord = choices.effort_word;
  const column = (field: 'model' | 'effort', caption: string, values: string[], fallback: string | undefined, show: (value: string) => string) => (
    <div className="ib-cp-list ib-cp-lchcol" role="group" aria-label={caption} data-compose-choice-menu={field}>
      <div className="ib-cp-cap">{caption}</div>
      {[null, ...values].map((value) => {
        const on = (choice[field] ?? null) === value;
        return (
          <button
            key={value ?? ''}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            className="ib-cp-opt ib-cp-lchopt"
            data-compose-choice-value={value ?? 'default'}
            onClick={() => {
              const next = { ...choice };
              if (value === null) delete next[field];
              else next[field] = value;
              onChoice(next);
            }}
          >
            <span className="ib-cp-op">
              {value === null ? 'Default' : show(value)}
              {value === null && fallback && <span className="ib-cp-of"> {show(fallback)}</span>}
            </span>
            <span className="ib-cp-check" aria-hidden="true">
              {on && <Icon name="check" size={15} />}
            </span>
          </button>
        );
      })}
    </div>
  );
  const models = launchModelRows(choice, choices);
  return (
    <div className="ib-cp-picker ib-cp-lch" ref={ref} role="menu" aria-label={`Model and ${effortWord.toLowerCase()}`} data-compose-choices="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={back}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>Model and {effortWord.toLowerCase()}</span>
        </div>
      )}
      <div className="ib-cp-lchcols">
        {models.length > 0 && column('model', 'Model', models, choices.default?.model, shortLaunchModel)}
        {choices.efforts.length > 0 && column('effort', effortWord, choices.efforts, choices.default?.effort, (v) => v)}
      </div>
    </div>
  );
}

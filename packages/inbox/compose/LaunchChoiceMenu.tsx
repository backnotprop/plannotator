import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { Icon } from '../icons';
import { launchEffortsFor } from '@plannotator/core/inbox-launch-choice';
import { launchChoiceButton, launchModelRows, pickLaunchModel, shortLaunchModel } from './launchChoice';

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
  const back = () => {
    const button = ref.current?.ownerDocument.querySelector<HTMLButtonElement>('.ib-cp-lchbtn');
    onClose();
    button?.focus();
  };
  const effortWord = choices.effort_word;
  const column = (field: 'model' | 'effort', caption: string, values: string[], show: (value: string) => string) => (
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
              if (field === 'model') return onChoice(pickLaunchModel(choice, choices, value));
              const next = { ...choice };
              if (value === null) delete next.effort;
              else next.effort = value;
              onChoice(next);
            }}
          >
            <span className="ib-cp-op">
              {value === null ? 'Default' : show(value)}
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
  const efforts = launchEffortsFor(choices, choice.model);
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
        {models.length > 0 && column('model', 'Model', models, shortLaunchModel)}
        {efforts.length > 0 && column('effort', effortWord, efforts, (v) => v)}
      </div>
    </div>
  );
}

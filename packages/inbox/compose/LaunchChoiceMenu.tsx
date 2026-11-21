import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { Icon } from '../icons';
import { launchEffortsFor } from '@plannotator/core/inbox-launch-choice';
import { launchChoiceButton, launchChoiceButtonParts, launchChoiceMenuName, launchChoiceNotice, launchDefaultRow, launchModelRows, pickLaunchModel, shortLaunchModel } from './launchChoice';
import { filterLaunchModels, LAUNCH_MODEL_FILTER_FROM } from './modelFilter';

export function LaunchChoiceButton({ choice, choices, open, onToggle, className }: { choice: InboxLaunchChoice; choices: InboxLaunchChoices; open: boolean; onToggle: () => void; className: string }) {
  const words = launchChoiceButton(choice, choices);
  const parts = launchChoiceButtonParts(choice, choices);
  return (
    <button
      type="button"
      className={`${className} ib-cp-lchbtn`}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={`${launchChoiceMenuName(choices)}: ${words}. Change`}
      data-compose-choice={words}
      onClick={onToggle}
    >
      {parts ? (
        // A long default gives way inside its brackets only: "Default (qwen2.5-coder:32b-instruc…) · build".
        <span className="ib-cp-lchw">
          <span>{parts.lead}</span>
          <span className="ib-cp-lchdn">{parts.name}</span>
          <span>{parts.tail}</span>
        </span>
      ) : (
        <span>{words}</span>
      )}
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
  const noticeId = useId();
  /** Where focus goes as the menu opens: the filter (not on a touch screen), else the checked row. */
  const placeFocus = () => {
    const filter = ref.current?.querySelector<HTMLInputElement>('[data-compose-choice-filter]');
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (filter && !touch) filter.focus();
    else ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  };
  useEffect(() => {
    placeFocus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('.ib-cp-lchbtn')) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const models = launchModelRows(choice, choices);
  const efforts = launchEffortsFor(choices, choice.model);
  // OpenCode's list being read or not readable: Default, then one line that says so.
  const notice = launchChoiceNotice(choices);
  // The list read while the menu is open (or its failure) can take away the focused row (a long list's column
  // replaces the plain one): focus goes where a fresh open puts it, and is never taken from a row still in the menu.
  const kind = choices.reading ? 'reading' : choices.unread ? 'unread' : models.length >= LAUNCH_MODEL_FILTER_FROM ? 'filter' : 'list';
  const kindWas = useRef(kind);
  useEffect(() => {
    if (kindWas.current === kind) return;
    kindWas.current = kind;
    const menu = ref.current;
    if (menu && !menu.contains(menu.ownerDocument.activeElement)) placeFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
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
  const column = (field: 'model' | 'effort' | 'primary_agent', caption: string, values: string[], show: (value: string) => string, notice: string | null = null) => (
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
            title={value ?? undefined}
            // The line under Default says why it is the only row: read as its description.
            aria-describedby={value === null && notice ? noticeId : undefined}
            onClick={() => {
              if (field === 'model') return onChoice(pickLaunchModel(choice, choices, value));
              const next = { ...choice };
              if (value === null) delete next[field];
              else next[field] = value;
              onChoice(next);
            }}
          >
            {value === null && field === 'model' ? (
              <DefaultName choices={choices} />
            ) : (
              <span className="ib-cp-op">{value === null ? 'Default' : show(value)}</span>
            )}
            <span className="ib-cp-check" aria-hidden="true">
              {on && <Icon name="check" size={15} />}
            </span>
          </button>
        );
      })}
      {notice && (
        <div className="ib-cp-opt ib-cp-fnotice" role="menuitem" aria-disabled="true" aria-labelledby={noticeId} data-compose-choice-notice={choices.reading ? 'reading' : (choices.unread ?? '')}>
          {choices.reading ? <span className="ib-spin" aria-hidden="true" /> : <Icon name="info" size={15} />}
          <span className="ib-cp-op" id={noticeId}>
            {notice}
          </span>
        </div>
      )}
    </div>
  );
  return (
    <div className="ib-cp-picker ib-cp-lch" ref={ref} role="menu" aria-label={launchChoiceMenuName(choices)} data-compose-choices="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={back}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>{launchChoiceMenuName(choices)}</span>
        </div>
      )}
      <div className="ib-cp-lchcols">
        {models.length >= LAUNCH_MODEL_FILTER_FROM ? (
          <ModelFilterColumn models={models} picked={choice.model ?? null} choices={choices} onPick={(value) => onChoice(pickLaunchModel(choice, choices, value))} />
        ) : (
          (models.length > 0 || notice) && column('model', 'Model', models, shortLaunchModel, notice)
        )}
        {efforts.length > 0 && column('effort', effortWord, efforts, (v) => v)}
        {/* OpenCode's own agents (build, plan, …), the session's from its start. */}
        {choices.primary_agents && choices.primary_agents.length > 0 && column('primary_agent', 'Agent', choices.primary_agents, (v) => v)}
      </div>
    </div>
  );
}

const providerOf = (model: string) => (model.indexOf('/') > 0 ? model.slice(0, model.indexOf('/')) : null);
const idOf = (model: string) => (model.indexOf('/') > 0 ? model.slice(model.indexOf('/') + 1) : model);

/** The model menu's Default row: "Default (big-pickle)" with its provider muted after it (under it in a narrow column). */
function DefaultName({ choices }: { choices: InboxLaunchChoices }) {
  const row = launchDefaultRow(choices);
  if (!row.provider && row.name === 'Default') return <span className="ib-cp-op">Default</span>;
  return (
    <span className="ib-cp-op ib-cp-lchname ib-cp-lchdef">
      <span>{row.name}</span>
      {row.provider && <span className="ib-cp-lchprov">{row.provider}</span>}
    </span>
  );
}

function ModelFilterColumn({ models, picked, choices, onPick }: { models: string[]; picked: string | null; choices: InboxLaunchChoices; onPick: (value: string | null) => void }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const shown = query.trim() ? filterLaunchModels(models, query) : models;
  const rows: (string | null)[] = [null, ...shown];
  const [hl, setHl] = useState(() => Math.max(0, rows.indexOf(picked)));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${hl}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hl, query]);
  const onFilter = (next: string) => {
    setQuery(next);
    const found = next.trim() ? filterLaunchModels(models, next) : models;
    setHl(next.trim() ? (found.length > 0 ? 1 : 0) : Math.max(0, [null, ...found].indexOf(picked)));
  };
  const pick = (value: string | null) => {
    setQuery('');
    setHl(Math.max(0, [null, ...models].indexOf(value)));
    onPick(value);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHl((at) => (at + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (hl < rows.length) pick(rows[hl]!);
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) event.currentTarget.blur();
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      onFilter('');
    }
  };
  return (
    <div ref={list} className="ib-cp-list ib-cp-lchcol" role="group" aria-label="Model" data-compose-choice-menu="model" data-filterable="" data-typing={typing ? '' : undefined}>
      <div className="ib-cp-cap">Model</div>
      <div className="ib-cp-filter ib-cp-lchfilter">
        <Icon name="search" size={14} />
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${uid}-rows`}
          aria-activedescendant={`${uid}-${hl}`}
          aria-label="Find a model"
          placeholder="Find a model"
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-compose-choice-filter=""
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={onKey}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
        />
      </div>
      <div id={`${uid}-rows`} className="ib-cp-lchrows">
        {rows.map((value, i) => (
          <button
            key={value ?? ''}
            id={`${uid}-${i}`}
            type="button"
            role="menuitemradio"
            aria-checked={picked === value}
            className={`ib-cp-opt ib-cp-lchopt${hl === i ? ' ib-hl' : ''}`}
            data-compose-choice-value={value ?? 'default'}
            data-row={i}
            title={value ?? undefined}
            onClick={() => pick(value)}
          >
            {value === null ? (
              <DefaultName choices={choices} />
            ) : (
              <span className="ib-cp-op ib-cp-lchname">
                <span>{idOf(value)}</span>
                {providerOf(value) && <span className="ib-cp-lchprov">{providerOf(value)}</span>}
              </span>
            )}
            <span className="ib-cp-check" aria-hidden="true">
              {picked === value && <Icon name="check" size={15} />}
            </span>
          </button>
        ))}
        {shown.length === 0 && <div className="ib-cp-none">No matching models</div>}
      </div>
    </div>
  );
}

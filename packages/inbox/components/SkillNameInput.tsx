/**
 * A saved emoji's name field, where "/" attaches a skill (approval "inbox-reactions-every-message", item 6, take B):
 * typing "/" opens the reply box's own skill list (the same hook and list, Plannotator's skills first), and a pick
 * writes `/name` into the field. "Test it /test-it" names the emoji and gives it a skill. The field's words are
 * painted as a skill while they are only one, and only a skill there is.
 *
 * In this one-line field "/" only ever means a skill, so once a letter is typed a row is active (`firstActive`): the
 * one named exactly what was typed, else the first. "/tid" then Enter takes it and keeps it, as a pick then Enter
 * would; Tab takes it and stays. A bare "/" has none, so its Enter is the field's.
 */
import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import { SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { INBOX_REACTION_LABEL_MAX } from '@plannotator/core/inbox-types';
import { builtinSkillIcon } from './BuiltinSkillIcon';
import { inboxSkillFilter } from '../skills';
import { knownReactionSkill } from '../reactions';

const anySkill = inboxSkillFilter(true);
export const NAME_OR_SKILL = 'Name, or / for a skill';

export function SkillNameInput({
  inputRef,
  value,
  onChange,
  onEnter,
  label,
  data,
  own,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (text: string) => void;
  onEnter: () => void;
  label: string;
  data: 'name-field' | 'edit-name';
  /** The emoji's skill as saved: it stays a skill here even when this computer has none of that name. */
  own?: string;
}) {
  const listId = useId();
  const skills = useSkillReferenceAutocomplete({
    text: value,
    setText: onChange,
    textareaRef: inputRef as unknown as RefObject<HTMLTextAreaElement | null>,
    enabled: true,
    catalogFilter: anySkill,
    hostRowsFirst: true,
    quietOnDelete: true,
    bareEscapeDismisses: true,
    firstActive: true,
  });
  // Enter on the list: the pick is written first, and kept once the field holds it (the host reads its own words).
  const [keepPick, setKeepPick] = useState(0);
  useEffect(() => {
    if (keepPick > 0) onEnter();
  }, [keepPick]); // eslint-disable-line react-hooks/exhaustive-deps -- once per Enter, with the words of that render
  const only = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/.exec(value);
  const onlySkill = !!only && knownReactionSkill(only[1]!, own) !== null;
  return (
    <span className="ib-sknf">
      {skills.menu && <SkillReferenceMenu id={listId} items={skills.menu.items} activeIndex={skills.menu.activeIndex} onSelect={skills.select} groupHostRows rowIcon={builtinSkillIcon} prefer="above" />}
      <input
        ref={inputRef}
        className="ib-namer-in"
        {...{ [`data-${data}`]: '' }}
        data-skill={onlySkill ? '' : undefined}
        type="text"
        value={value}
        placeholder={NAME_OR_SKILL}
        maxLength={INBOX_REACTION_LABEL_MAX + 66}
        autoComplete="off"
        enterKeyHint="done"
        aria-label={label}
        aria-controls={skills.menu ? listId : undefined}
        aria-activedescendant={skills.menu?.activeIndex != null ? `${listId}-option-${skills.menu.activeIndex}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          skills.onEdit((e.nativeEvent as InputEvent).inputType);
        }}
        onSelect={skills.onSelect}
        onKeyDown={(e) => {
          const picking = e.key === 'Enter' && skills.menu?.activeIndex != null;
          if (skills.onKeyDown(e as unknown as ReactKeyboardEvent<HTMLTextAreaElement>)) {
            if (picking) setKeepPick((n) => n + 1);
            return;
          }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </span>
  );
}

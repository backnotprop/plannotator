/**
 * A saved emoji's name field, where "/" attaches a skill (approval "inbox-reactions-every-message", item 6, take B):
 * typing "/" opens the reply box's own skill list (the same hook and list, Plannotator's skills first), and a pick
 * writes `/name` into the field. "Test it /test-it" names the emoji and gives it a skill. The field's words are
 * painted as a skill while they are only one.
 */
import { useId, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import { SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { INBOX_REACTION_LABEL_MAX } from '@plannotator/core/inbox-types';
import { builtinSkillIcon } from './BuiltinSkillIcon';
import { inboxSkillFilter } from '../skills';

const anySkill = inboxSkillFilter(true);
export const NAME_OR_SKILL = 'Name, or / for a skill';

export function SkillNameInput({
  inputRef,
  value,
  onChange,
  onEnter,
  label,
  data,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (text: string) => void;
  onEnter: () => void;
  label: string;
  data: 'name-field' | 'edit-name';
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
  });
  const onlySkill = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\s*$/.test(value);
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
        onChange={(e) => {
          onChange(e.target.value);
          skills.onEdit((e.nativeEvent as InputEvent).inputType);
        }}
        onSelect={skills.onSelect}
        onKeyDown={(e) => {
          if (skills.onKeyDown(e as unknown as ReactKeyboardEvent<HTMLTextAreaElement>)) return;
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </span>
  );
}

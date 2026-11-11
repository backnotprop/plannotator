import React from 'react';
import { MentionPicker } from './MentionPicker';
import type { MentionMenuState } from '../hooks/useMentionAutocomplete';

/**
 * Internal glue between `useMentionAutocomplete` and `MentionPicker`: the id→index lookup, the
 * no-op hover and the `aria-activedescendant` string that every composer mounting an `@` menu
 * would otherwise repeat verbatim.
 */

export const MentionAutocompleteMenu: React.FC<{
  /** Listbox id the driving textarea points `aria-controls` at. */
  readonly id: string;
  readonly menu: MentionMenuState | null;
  readonly onSelect: (index: number) => void;
}> = ({ id, menu, onSelect }) => {
  if (menu === null) return null;
  return (
    <MentionPicker
      id={id}
      people={menu.items}
      emptyNotice={menu.emptyNotice}
      heading={menu.heading}
      active={menu.activeIndex}
      anchor={menu.anchor}
      onPick={(person) => {
        const index = menu.items.findIndex((p) => p.id === person.id);
        if (index >= 0) onSelect(index);
      }}
      onHover={() => {}}
    />
  );
};

/** `aria-activedescendant` for the textarea driving that menu: the id of the arrow-focused row. */
export function mentionActiveOptionId(
  listboxId: string,
  menu: MentionMenuState | null,
): string | undefined {
  if (menu === null || menu.activeIndex === null) return undefined;
  return `${listboxId}-option-${menu.activeIndex}`;
}

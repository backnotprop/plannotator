import React from 'react';
import { MentionPicker } from './MentionPicker';
import type { MentionMenuState } from '../hooks/useMentionAutocomplete';

/**
 * Internal glue between `useMentionAutocomplete` and `MentionPicker`: the
 * id→index lookup, the no-op hover and the `aria-activedescendant` string
 * that every composer mounting an `@` menu would otherwise repeat verbatim.
 *
 * Not a host seam — hosts pass `mentionSource` and never see this. It exists
 * so the third mount (the annotation card's edit box) did not become a third
 * copy of the same fifteen lines.
 */

/**
 * The picker for a `useMentionAutocomplete` result. Renders nothing while no
 * menu is open — which, with no `MentionSource`, is always.
 */
export const MentionAutocompleteMenu: React.FC<{
  /** Listbox id the driving textarea points `aria-controls` at. */
  readonly id: string;
  readonly menu: MentionMenuState | null;
  /** `useMentionAutocomplete`'s `select`. */
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

/**
 * `aria-activedescendant` for the textarea driving that menu: the id of the
 * arrow-focused row, or `undefined` while nothing is active (the menu opens
 * with nothing preselected) and while no menu is open at all.
 */
export function mentionActiveOptionId(
  listboxId: string,
  menu: MentionMenuState | null,
): string | undefined {
  if (menu === null || menu.activeIndex === null) return undefined;
  return `${listboxId}-option-${menu.activeIndex}`;
}

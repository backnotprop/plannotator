import React from 'react';
import { MentionPicker } from './MentionPicker';
import type { MentionMenuState } from '../hooks/useMentionAutocomplete';

export const MentionAutocompleteMenu: React.FC<{
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

export function mentionActiveOptionId(
  listboxId: string,
  menu: MentionMenuState | null,
): string | undefined {
  if (menu === null || menu.activeIndex === null) return undefined;
  return `${listboxId}-option-${menu.activeIndex}`;
}

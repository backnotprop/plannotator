import type React from 'react';

export interface SelectionActionContext {
  text: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  element: HTMLElement;
}

export interface SelectionAction {
  id: string;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
  onSelect: (ctx: SelectionActionContext) => void;
}

export function buildSelectionActionContext(
  element: HTMLElement,
  text: string,
): SelectionActionContext {
  const blockEl = element.closest<HTMLElement>('[data-block-id]');
  const blockId = blockEl?.dataset.blockId ?? '';
  let startOffset = 0;
  if (blockEl && text) {
    const blockText = blockEl.textContent || '';
    const before = blockText.split(text)[0];
    startOffset = before === blockText ? 0 : before?.length || 0;
  }
  return { text, blockId, startOffset, endOffset: startOffset + text.length, element };
}

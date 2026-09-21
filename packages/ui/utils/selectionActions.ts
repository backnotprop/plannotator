/**
 * Host selection actions — the opt-in seam that lets a host put its own
 * commands on the selection toolbar beside (or instead of) the quick labels.
 *
 * The package renders the button and the dropdown and hands back the
 * selection context; it creates NO annotation of its own. What an action does
 * is entirely the host's business. Plannotator supplies none of these, so
 * nothing here runs in Plannotator's apps.
 */

import type React from 'react';

/** What the toolbar knows about the selection an action was invoked on. */
export interface SelectionActionContext {
  /** The selected text (the toolbar's copy text, else the element's text). */
  text: string;
  /** The enclosing `[data-block-id]`, or '' on surfaces that have none (raw HTML). */
  blockId: string;
  /** Offset of the selection within the block's text, 0 when unknown. */
  startOffset: number;
  /** `startOffset + text.length` — so on a block-less surface it is the
   *  selection's length, not 0. */
  endOffset: number;
  /** The element the toolbar is anchored to. */
  element: HTMLElement;
}

export interface SelectionAction {
  id: string;
  label: string;
  /** Optional dimmed second line under the label. */
  detail?: string;
  /** Optional leading icon; a colored bar is drawn when absent. */
  icon?: React.ReactNode;
  onSelect: (ctx: SelectionActionContext) => void;
}

/**
 * Build the context for an invoked action from what the toolbar has: its
 * anchor element and the selected text. The block lookup and the offset
 * arithmetic deliberately reproduce `createAnnotationFromSource`'s, so an
 * action sees the same coordinates an annotation created from the same
 * selection would carry.
 *
 * ONE deliberate deviation: when the selection is not found inside the block
 * at all — a selection spanning two blocks, where the anchor sits in the
 * first — `String.split` yields the whole block text and the annotation path
 * would report `blockText.length`. A host gets 0 instead, since an offset
 * past the end of the block is worse than an admitted "unknown".
 */
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

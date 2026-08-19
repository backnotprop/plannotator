import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Modal document-navigation commands shared by plan review and annotate mode.
 *
 * The bindings are active only while the opted-in document focus surface owns
 * focus; native controls and annotation composers remain outside this scope.
 */
export const vimSelectionShortcuts = defineShortcutScope({
  id: 'vim-selection',
  title: 'Vim selection',
  shortcuts: {
    moveDown: {
      description: 'Next block or semantic sibling',
      bindings: ['J'],
      section: 'Vim Document Navigation',
      displayOrder: 10,
    },
    moveUp: {
      description: 'Previous block or semantic sibling',
      bindings: ['K'],
      section: 'Vim Document Navigation',
      displayOrder: 20,
    },
    documentStart: {
      description: 'Start of document',
      bindings: ['G G'],
      section: 'Vim Document Navigation',
      displayOrder: 30,
      preventDefault: true,
    },
    documentEnd: {
      description: 'End of document',
      bindings: ['Shift+G'],
      section: 'Vim Document Navigation',
      displayOrder: 40,
    },
    moveOut: {
      description: 'Move to containing target',
      bindings: ['H'],
      section: 'Vim Document Navigation',
      displayOrder: 50,
    },
    refine: {
      description: 'Refine into child or text',
      bindings: ['L'],
      section: 'Vim Document Navigation',
      displayOrder: 60,
    },
    visual: {
      description: 'Toggle precise Visual selection',
      bindings: ['V'],
      section: 'Vim Document Navigation',
      displayOrder: 70,
    },
    visualBlock: {
      description: 'Toggle whole-block Visual selection',
      bindings: ['Shift+V'],
      section: 'Vim Document Navigation',
      hint: 'Use j / k to extend by whole blocks.',
      displayOrder: 80,
    },
    wordForward: {
      description: 'Move to next word',
      bindings: ['W'],
      section: 'Vim Text Navigation',
      displayOrder: 90,
    },
    wordBackward: {
      description: 'Move to previous word',
      bindings: ['B'],
      section: 'Vim Text Navigation',
      displayOrder: 100,
    },
    wordEnd: {
      description: 'Move to end of word',
      bindings: ['E'],
      section: 'Vim Text Navigation',
      displayOrder: 110,
    },
    lineStart: {
      description: 'Move to start of line',
      bindings: ['0'],
      section: 'Vim Text Navigation',
      displayOrder: 120,
    },
    lineEnd: {
      description: 'Move to end of line',
      bindings: ['$'],
      section: 'Vim Text Navigation',
      displayOrder: 130,
    },
    previousTextBlock: {
      description: 'Move to previous text block',
      bindings: ['{'],
      section: 'Vim Text Navigation',
      displayOrder: 140,
    },
    nextTextBlock: {
      description: 'Move to next text block',
      bindings: ['}'],
      section: 'Vim Text Navigation',
      displayOrder: 150,
    },
    swapSelectionEnds: {
      description: 'Swap selection ends',
      bindings: ['O'],
      section: 'Vim Text Navigation',
      displayOrder: 160,
    },
    activeAnnotation: {
      description: 'Use active annotation mode',
      bindings: ['Enter'],
      section: 'Vim Annotation Actions',
      displayOrder: 170,
    },
    annotationMenu: {
      description: 'Open annotation actions',
      bindings: ['Space'],
      section: 'Vim Annotation Actions',
      displayOrder: 180,
    },
    comment: {
      description: 'Comment selection or target',
      bindings: ['C'],
      section: 'Vim Annotation Actions',
      displayOrder: 190,
    },
    redline: {
      description: 'Redline selection or target',
      bindings: ['D'],
      section: 'Vim Annotation Actions',
      displayOrder: 200,
    },
    markup: {
      description: 'Markup selection or target',
      bindings: ['M'],
      section: 'Vim Annotation Actions',
      displayOrder: 210,
    },
    label: {
      description: 'Label selection or target',
      bindings: ['T'],
      section: 'Vim Annotation Actions',
      displayOrder: 220,
    },
    copy: {
      description: 'Copy selection or target',
      bindings: ['Y'],
      section: 'Vim Annotation Actions',
      displayOrder: 230,
    },
    cancel: {
      description: 'Cancel current Vim state',
      bindings: ['Escape'],
      section: 'Vim Annotation Actions',
      displayOrder: 240,
    },
    help: {
      description: 'Toggle key map',
      bindings: ['?'],
      section: 'Vim Annotation Actions',
      displayOrder: 250,
    },
  },
});

/** Stable action identifiers emitted by the Vim selection shortcut scope. */
export type VimSelectionActionId = keyof typeof vimSelectionShortcuts.shortcuts;

/** Vim navigation state used to make HUD command descriptions contextual. */
export type VimSelectionHudContext =
  | 'inactive'
  | 'block'
  | 'inline'
  | 'text'
  | 'visual'
  | 'visual-block'
  | 'action';

/**
 * Return the user-facing HUD description for a handled Vim action.
 *
 * Contextual movement keys keep one registered shortcut while accurately
 * describing whether they moved by document structure, line, or character.
 */
export function describeVimSelectionAction(
  actionId: VimSelectionActionId,
  context: VimSelectionHudContext,
): string {
  switch (actionId) {
    case 'moveDown':
      if (context === 'inline') return 'Next semantic sibling';
      if (context === 'text' || context === 'visual') return 'Next line';
      if (context === 'visual-block') return 'Extend to next block';
      return 'Next block';
    case 'moveUp':
      if (context === 'inline') return 'Previous semantic sibling';
      if (context === 'text' || context === 'visual') return 'Previous line';
      if (context === 'visual-block') return 'Extend to previous block';
      return 'Previous block';
    case 'moveOut':
      return context === 'text' || context === 'visual'
        ? 'Move left one character'
        : 'Move to containing target';
    case 'refine':
      return context === 'text' || context === 'visual'
        ? 'Move right one character'
        : 'Refine into child or text';
    case 'visual':
      return context === 'visual'
        ? 'Return to Normal mode'
        : 'Start Visual selection';
    case 'visualBlock':
      return context === 'visual-block'
        ? 'Return to block navigation'
        : 'Select the whole block';
    case 'documentStart':
    case 'documentEnd':
    case 'wordForward':
    case 'wordBackward':
    case 'wordEnd':
    case 'lineStart':
    case 'lineEnd':
    case 'previousTextBlock':
    case 'nextTextBlock':
    case 'swapSelectionEnds':
    case 'activeAnnotation':
    case 'annotationMenu':
    case 'comment':
    case 'redline':
    case 'markup':
    case 'label':
    case 'copy':
    case 'cancel':
    case 'help':
      return vimSelectionShortcuts.shortcuts[actionId].description;
  }
}

/** Parse an unknown bridge value into a registered Vim action identifier. */
export function isVimSelectionActionId(
  value: unknown,
): value is VimSelectionActionId {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(vimSelectionShortcuts.shortcuts, value);
}

/** Bind Vim selection handlers to the opted-in document focus surface. */
export const useVimSelectionShortcuts = createShortcutScopeHook(vimSelectionShortcuts);

import {
  describeVimSelectionAction,
  vimSelectionShortcuts,
  type VimSelectionActionId,
  type VimSelectionHudContext,
} from '../shortcuts/plan-review/vimSelection.shortcuts';

export type VimHudPhase =
  | 'BLOCK'
  | 'INLINE'
  | 'LINE'
  | 'WORD'
  | 'TEXT'
  | 'VISUAL'
  | 'ACTION';

export interface VimHudCommand {
  readonly sequence: number;
  readonly actionId: VimSelectionActionId;
  readonly key: string;
  readonly description: string;
  readonly context: VimSelectionHudContext;
}

export type VimHudLegendGroupId =
  | 'structure'
  | 'text'
  | 'selection'
  | 'annotation'
  | 'control';

export interface VimHudLegendItem {
  readonly actionId: VimSelectionActionId;
  readonly key: string;
  readonly description: string;
}

export interface VimHudLegendGroup {
  readonly id: VimHudLegendGroupId;
  readonly title: string;
  readonly description: string;
  readonly items: readonly VimHudLegendItem[];
}

interface VimHudLegendGroupSpec {
  readonly id: VimHudLegendGroupId;
  readonly title: string;
  readonly description: string;
  readonly context: VimSelectionHudContext;
  readonly actionIds: readonly VimSelectionActionId[];
}

const VIM_HUD_LEGEND_GROUP_SPECS: readonly VimHudLegendGroupSpec[] = [
  {
    id: 'structure',
    title: 'Document',
    description: 'Move by blocks and semantic structure',
    context: 'block',
    actionIds: [
      'moveDown',
      'moveUp',
      'documentStart',
      'documentEnd',
      'moveOut',
      'refine',
    ],
  },
  {
    id: 'text',
    title: 'Text',
    description: 'Move by characters, lines, words, and paragraphs',
    context: 'text',
    actionIds: [
      'moveOut',
      'refine',
      'moveDown',
      'moveUp',
      'wordForward',
      'wordBackward',
      'wordEnd',
      'lineStart',
      'lineEnd',
      'previousTextBlock',
      'nextTextBlock',
    ],
  },
  {
    id: 'selection',
    title: 'Select',
    description: 'Grow an exact or whole-block selection',
    context: 'block',
    actionIds: ['visual', 'visualBlock', 'swapSelectionEnds'],
  },
  {
    id: 'annotation',
    title: 'Annotate',
    description: 'Act on the current target or selection',
    context: 'block',
    actionIds: [
      'activeAnnotation',
      'annotationMenu',
      'comment',
      'redline',
      'markup',
      'label',
      'copy',
    ],
  },
  {
    id: 'control',
    title: 'Control',
    description: 'Back out or show this key map',
    context: 'block',
    actionIds: ['cancel', 'help'],
  },
];

function normalizeVimHudKey(
  actionId: VimSelectionActionId,
  rawKey: string,
): string {
  if (actionId === 'documentStart') return 'gg';
  if (rawKey === 'Escape') return 'esc';
  if (rawKey === 'Enter') return 'enter';
  if (rawKey === ' ' || rawKey === 'Space' || rawKey === 'Spacebar') return 'space';
  return rawKey;
}

function formatVimLegendKey(
  actionId: VimSelectionActionId,
  binding: string,
): string {
  if (actionId === 'documentStart') return 'gg';
  if (actionId === 'documentEnd') return 'G';
  if (actionId === 'visualBlock') return 'V';
  if (binding === 'Escape') return 'esc';
  if (binding === 'Enter') return 'enter';
  if (binding === 'Space') return 'space';
  return binding.length === 1 ? binding.toLowerCase() : binding;
}

export function createVimHudCommand(
  sequence: number,
  actionId: VimSelectionActionId,
  rawKey: string,
  context: VimSelectionHudContext,
): VimHudCommand {
  return {
    sequence,
    actionId,
    key: normalizeVimHudKey(actionId, rawKey),
    description: describeVimSelectionAction(actionId, context),
    context,
  };
}

export function getVimHudLegendGroups(): readonly VimHudLegendGroup[] {
  return VIM_HUD_LEGEND_GROUP_SPECS.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    items: group.actionIds.map((actionId) => {
      const shortcut = vimSelectionShortcuts.shortcuts[actionId];
      return {
        actionId,
        key: formatVimLegendKey(actionId, shortcut.bindings[0] ?? ''),
        description: describeVimSelectionAction(actionId, group.context),
      };
    }),
  }));
}

export function isVimHudLegendGroupActive(
  groupId: VimHudLegendGroupId,
  phase: VimHudPhase,
): boolean {
  switch (phase) {
    case 'BLOCK':
    case 'INLINE':
      return groupId === 'structure';
    case 'LINE':
    case 'WORD':
    case 'TEXT':
      return groupId === 'text';
    case 'VISUAL':
      return groupId === 'selection';
    case 'ACTION':
      return groupId === 'annotation';
  }
}

export function getVimHudPhase(
  state: VimSelectionHudContext,
  actionId?: VimSelectionActionId,
): VimHudPhase {
  switch (state) {
    case 'action':
      return 'ACTION';
    case 'visual':
    case 'visual-block':
      return 'VISUAL';
    case 'inline':
      return 'INLINE';
    case 'block':
    case 'inactive':
      return 'BLOCK';
    case 'text':
      switch (actionId) {
        case 'moveDown':
        case 'moveUp':
        case 'lineStart':
        case 'lineEnd':
          return 'LINE';
        case 'wordForward':
        case 'wordBackward':
        case 'wordEnd':
          return 'WORD';
        case 'previousTextBlock':
        case 'nextTextBlock':
          return 'BLOCK';
        case 'documentStart':
        case 'documentEnd':
        case 'moveOut':
        case 'refine':
        case 'visual':
        case 'visualBlock':
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
        case undefined:
          return 'TEXT';
      }
  }
}

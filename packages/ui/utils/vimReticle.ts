import type { SemanticTarget } from './blockTargeting';
import type { VimRestorableState } from './vimNavigation';
import type { VimHudCommand } from './vimHud';

const CURSOR_DESCRIPTORS: Partial<
  Record<VimHudCommand['actionId'], string>
> = {
  moveDown: 'NEXT LINE',
  moveUp: 'PREVIOUS LINE',
  lineStart: 'LINE START',
  lineEnd: 'LINE END',
  wordForward: 'NEXT WORD',
  wordBackward: 'PREVIOUS WORD',
  wordEnd: 'WORD END',
  previousTextBlock: 'PREVIOUS TEXT',
  nextTextBlock: 'NEXT TEXT',
  documentStart: 'DOCUMENT START',
  documentEnd: 'DOCUMENT END',
};

const VISUAL_DESCRIPTORS: Partial<
  Record<VimHudCommand['actionId'], string>
> = {
  visual: 'RANGE START',
  visualBlock: 'BLOCK RANGE',
  wordForward: 'NEXT WORD',
  wordBackward: 'PREVIOUS WORD',
  wordEnd: 'EXACT TOKEN',
  lineStart: 'TO LINE START',
  lineEnd: 'TO LINE END',
  moveDown: 'NEXT LINE',
  moveUp: 'PREVIOUS LINE',
  previousTextBlock: 'PREVIOUS BLOCK',
  nextTextBlock: 'NEXT BLOCK',
  swapSelectionEnds: 'SWAPPED ENDS',
};

type VimReticleSemanticTarget = Pick<SemanticTarget, 'kind' | 'label'>;

function semanticDescriptor(target: VimReticleSemanticTarget): string {
  switch (target.kind) {
    case 'code':
      return 'CODE';
    case 'math':
      return 'FORMULA';
    case 'table':
      return 'TABLE';
    case 'row':
      return 'ROW';
    case 'cell':
      return 'CELL';
    case 'group':
      return target.label.toUpperCase();
    case 'inline':
    case 'block':
      return (target.label.split(':')[0] || target.kind).toUpperCase();
  }
}

function cursorDescriptor(command: VimHudCommand | null): string {
  if (!command) return 'TEXT';
  if (command.actionId === 'moveOut' || command.actionId === 'refine') {
    const characterMotion = command.context === 'text' || command.context === 'visual';
    if (command.actionId === 'moveOut') {
      return characterMotion ? 'PREVIOUS CHARACTER' : 'TEXT';
    }
    return characterMotion ? 'NEXT CHARACTER' : 'INLINE TEXT';
  }
  return CURSOR_DESCRIPTORS[command.actionId] ?? 'TEXT';
}

/** Build the concise target label shared with the approved Vim demo. */
export function getVimReticleLabel(
  state: VimRestorableState,
  target: VimReticleSemanticTarget | null,
  command: VimHudCommand | null,
): string {
  if (state.phase === 'text') return `CURSOR · ${cursorDescriptor(command)}`;
  if (state.phase === 'visual') {
    return `VISUAL · ${
      command ? VISUAL_DESCRIPTORS[command.actionId] ?? 'RANGE' : 'RANGE'
    }`;
  }
  if (state.phase === 'visual-block') return 'VISUAL · BLOCK RANGE';
  return `${state.phase === 'inline' ? 'INLINE' : 'BLOCK'} · ${
    target ? semanticDescriptor(target) : 'TARGET'
  }`;
}

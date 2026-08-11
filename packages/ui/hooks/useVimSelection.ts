import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  useVimSelectionShortcuts,
  type VimSelectionActionId,
} from '../shortcuts';
import type { EditorMode } from '../types';
import {
  buildSemanticTargetGraph,
  createSemanticTargetRange,
  findInitialSemanticTarget,
  getOwningBlockTarget,
  getSemanticTargetChildren,
  moveSemanticTarget,
  resolveSemanticTarget,
  type SemanticTarget,
  type SemanticTargetGraph,
} from '../utils/blockTargeting';
import { copyTextPreservingFocus } from '../utils/clipboard';
import { isDocumentKeyboardControl } from '../utils/domSelection';
import {
  createVimHudCommand,
  type VimHudCommand,
} from '../utils/vimHud';
import {
  applyNativeTextSelection,
  createInitialVimSelectionState,
  createRangeBetweenTextPositions,
  getTextElementBounds,
  moveTextPosition,
  resolveTextPosition,
  serializeTextPosition,
  type VimBlockState,
  type VimInlineState,
  type VimRestorableState,
  type VimSelectionState,
  type VimTextMotion,
  type VimTextPosition,
  type VimTextState,
  type VimVisualBlockState,
  type VimVisualState,
} from '../utils/vimNavigation';
import { scrollVimTargetIntoView } from '../utils/vimScroll';
import { useVimDocumentFocus } from './useVimDocumentFocus';

/** Inputs required by the Markdown semantic Vim controller. */
export interface UseVimSelectionOptions {
  readonly containerRef: RefObject<HTMLElement | null>;
  /** The element that actually scrolls (ScrollViewportContext value). */
  readonly scrollViewport?: HTMLElement | null;
  readonly enabled: boolean;
  readonly hudEnabled: boolean;
  readonly blocked: boolean;
  readonly activeMode: EditorMode;
  /** Identity that changes when the rendered document is replaced. */
  readonly contentVersion?: unknown;
  readonly onHighlightRange: (range: Range, modeOverride?: EditorMode) => void;
  readonly onCodeBlockAction: (
    blockId: string,
    element: HTMLElement,
    modeOverride?: EditorMode,
  ) => void;
  readonly onMathAction: (element: HTMLElement, modeOverride?: EditorMode) => void;
  /** Clear pointer-owned feedback after a handled keyboard command. */
  readonly onHandledCommand?: () => void;
}

/** State and event handlers rendered by the Markdown Viewer. */
export interface UseVimSelectionReturn {
  readonly state: VimSelectionState;
  readonly focused: boolean;
  readonly helpOpen: boolean;
  readonly hudCommand: VimHudCommand | null;
  readonly activeTarget: SemanticTarget | null;
  readonly onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
  readonly onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onHelpOpenChange: (open: boolean) => void;
  readonly onHudFocusLeave: () => void;
}

function selectionModeForAction(key: string): EditorMode | null {
  if (key === 'c') return 'comment';
  if (key === 'd') return 'redline';
  if (key === 't') return 'quickLabel';
  if (key === 'm' || key === ' ' || key === 'Space' || key === 'Spacebar') {
    return 'selection';
  }
  return null;
}

function motionFromTextKey(key: string): VimTextMotion | null {
  if (key === 'h') return 'left';
  if (key === 'l') return 'right';
  if (key === 'w') return 'word-forward';
  if (key === 'b') return 'word-backward';
  if (key === 'e') return 'word-end';
  if (key === '{') return 'block-backward';
  if (key === '}') return 'block-forward';
  return null;
}

function semanticStateForTarget(target: SemanticTarget): VimBlockState | VimInlineState {
  return target.kind === 'inline' || target.kind === 'row' || target.kind === 'cell'
    ? { phase: 'inline', targetKey: target.key }
    : { phase: 'block', targetKey: target.key };
}

function targetKeyForState(state: VimSelectionState): string | null {
  switch (state.phase) {
    case 'inactive':
      return null;
    case 'action':
      return state.returnTo.targetKey;
    case 'block':
    case 'inline':
    case 'text':
    case 'visual':
    case 'visual-block':
      return state.targetKey;
  }
}

function targetKeyForPosition(
  graph: SemanticTargetGraph,
  currentTargetKey: string,
  position: VimTextPosition,
): string {
  const current = resolveSemanticTarget(graph, currentTargetKey);
  if (current?.blockId === position.blockId) return currentTargetKey;
  return graph.blockKeys
    .map((key) => resolveSemanticTarget(graph, key))
    .find((target) => target?.blockId === position.blockId)
    ?.key ?? currentTargetKey;
}

function clampPositionToSemanticTarget(
  graph: SemanticTargetGraph,
  targetKey: string,
  position: VimTextPosition,
  direction: 'forward' | 'backward',
): VimTextPosition {
  const target = resolveSemanticTarget(graph, targetKey);
  if (!target || (target.kind !== 'inline' && target.kind !== 'row' && target.kind !== 'cell')) {
    return position;
  }
  const bounds = getTextElementBounds(graph.container, target.element);
  if (!bounds) return position;
  if (position.blockId !== bounds.start.blockId) {
    return direction === 'forward' ? bounds.end : bounds.start;
  }
  if (position.textOffset <= bounds.start.textOffset) return bounds.start;
  if (position.textOffset >= bounds.end.textOffset) return bounds.end;
  return {
    blockId: position.blockId,
    textOffset: position.textOffset,
    affinity: position.affinity,
  };
}

function moveWithNativeSelection(
  container: HTMLElement,
  state: VimTextState | VimVisualState,
  direction: 'forward' | 'backward',
  granularity: 'line' | 'lineboundary',
): VimTextPosition | null {
  const anchor = state.phase === 'visual' ? state.anchor : null;
  const selection = applyNativeTextSelection(container, state.cursor, anchor);
  if (!selection || typeof selection.modify !== 'function') return null;
  selection.modify(state.phase === 'text' ? 'move' : 'extend', direction, granularity);
  if (!selection.focusNode) return null;
  return serializeTextPosition(container, selection.focusNode, selection.focusOffset);
}

function selectedTextRange(
  container: HTMLElement,
  state: VimVisualState,
): Range | null {
  const range = createRangeBetweenTextPositions(container, state.anchor, state.cursor);
  return range && !range.collapsed ? range : null;
}

function visualBlockPoints(
  graph: SemanticTargetGraph,
  state: VimVisualBlockState,
): { anchor: VimTextPosition; cursor: VimTextPosition } | null {
  const anchorTarget = resolveSemanticTarget(graph, state.anchorTargetKey);
  const cursorTarget = resolveSemanticTarget(graph, state.targetKey);
  if (!anchorTarget || !cursorTarget) return null;
  const anchorBounds = getTextElementBounds(graph.container, anchorTarget.element);
  const cursorBounds = getTextElementBounds(graph.container, cursorTarget.element);
  if (!anchorBounds || !cursorBounds) return null;

  const anchorIndex = graph.blockKeys.indexOf(anchorTarget.key);
  const cursorIndex = graph.blockKeys.indexOf(cursorTarget.key);
  return cursorIndex >= anchorIndex
    ? { anchor: anchorBounds.start, cursor: cursorBounds.end }
    : { anchor: anchorBounds.end, cursor: cursorBounds.start };
}

function visualBlockRange(
  graph: SemanticTargetGraph,
  state: VimVisualBlockState,
): Range | null {
  const points = visualBlockPoints(graph, state);
  if (!points) return null;
  const range = createRangeBetweenTextPositions(
    graph.container,
    points.anchor,
    points.cursor,
  );
  return range && !range.collapsed ? range : null;
}

function applyVisualBlockSelection(
  graph: SemanticTargetGraph,
  state: VimVisualBlockState,
): void {
  const points = visualBlockPoints(graph, state);
  if (points) applyNativeTextSelection(graph.container, points.cursor, points.anchor);
}

/**
 * Own semantic block navigation and precise text selection while the rendered
 * document has focus.
 *
 * The shortcut listener is attached only to the rendered document element.
 * Disabling the opt-in setting makes it inert, and native controls inside the
 * document retain their own keys.
 */
export function useVimSelection({
  containerRef,
  scrollViewport,
  enabled,
  hudEnabled,
  blocked,
  activeMode,
  contentVersion,
  onHighlightRange,
  onCodeBlockAction,
  onMathAction,
  onHandledCommand,
}: UseVimSelectionOptions): UseVimSelectionReturn {
  const [state, setStateValue] = useState<VimSelectionState>(
    createInitialVimSelectionState,
  );
  const stateRef = useRef(state);
  const [focused, setFocused] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [hudCommand, setHudCommand] = useState<VimHudCommand | null>(null);
  const hudSequenceRef = useRef(0);
  const restoreFocusRef = useRef(false);
  const wasBlockedRef = useRef(blocked);
  const pointerFocusRef = useRef(false);
  const restoringFocusRef = useRef(false);

  // Read the live scroll viewport without adding a dependency to every
  // navigation callback below.
  const scrollViewportRef = useRef(scrollViewport);
  scrollViewportRef.current = scrollViewport;

  const setState = useCallback((next: VimSelectionState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const needsLiveTarget = enabled && (
    state.phase === 'block'
    || state.phase === 'inline'
    || state.phase === 'action'
  );
  const liveGraph = needsLiveTarget && containerRef.current
    ? buildSemanticTargetGraph(containerRef.current)
    : null;
  const activeTarget = liveGraph
    ? resolveSemanticTarget(liveGraph, targetKeyForState(state))
    : null;

  const initializeSemanticNavigation = useCallback((): VimBlockState | null => {
    const container = containerRef.current;
    if (!container) return null;
    const graph = buildSemanticTargetGraph(container);
    const initial = findInitialSemanticTarget(graph, scrollViewportRef.current);
    if (!initial) return null;
    const next: VimBlockState = { phase: 'block', targetKey: initial.key };
    setState(next);
    window.getSelection()?.removeAllRanges();
    scrollVimTargetIntoView(initial.element, scrollViewportRef.current);
    return next;
  }, [containerRef, setState]);

  useEffect(() => {
    if (!enabled) {
      setState(createInitialVimSelectionState());
      setFocused(false);
      setHelpOpen(false);
      setHudCommand(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (!focused) return;
    if (restoringFocusRef.current) {
      restoringFocusRef.current = false;
      return;
    }
    if (pointerFocusRef.current) {
      pointerFocusRef.current = false;
      return;
    }
    initializeSemanticNavigation();
  }, [
    contentVersion,
    enabled,
    focused,
    initializeSemanticNavigation,
    setState,
  ]);

  useEffect(() => {
    setHudCommand(null);
  }, [contentVersion, hudEnabled]);

  useEffect(() => {
    const wasBlocked = wasBlockedRef.current;
    wasBlockedRef.current = blocked;
    if (wasBlocked && !blocked && stateRef.current.phase === 'action') {
      const returnTo = stateRef.current.returnTo;
      setState(returnTo);
      const container = containerRef.current;
      if (container) {
        const graph = buildSemanticTargetGraph(container);
        if (returnTo.phase === 'text' || returnTo.phase === 'visual') {
          applyNativeTextSelection(
            graph.container,
            returnTo.cursor,
            returnTo.phase === 'visual' ? returnTo.anchor : null,
          );
        } else if (returnTo.phase === 'visual-block') {
          applyVisualBlockSelection(graph, returnTo);
        }
      }
    }
    if (wasBlocked && !blocked) {
      const shouldRestoreFocus = restoreFocusRef.current;
      restoreFocusRef.current = false;
      if (
        shouldRestoreFocus
        && enabled
        && (document.activeElement === document.body || document.activeElement === null)
      ) {
        const container = containerRef.current;
        if (container) {
          restoringFocusRef.current = true;
          container.focus({ preventScroll: true });
        }
      }
    }
  }, [blocked, containerRef, enabled, setState]);

  const setSemanticTarget = useCallback((target: SemanticTarget) => {
    setState(semanticStateForTarget(target));
    window.getSelection()?.removeAllRanges();
    scrollVimTargetIntoView(target.element, scrollViewportRef.current);
  }, [setState]);

  const updateTextState = useCallback((
    graph: SemanticTargetGraph,
    next: VimTextState | VimVisualState,
  ) => {
    const targetKey = targetKeyForPosition(graph, next.targetKey, next.cursor);
    const normalized = { ...next, targetKey };
    setState(normalized);
    applyNativeTextSelection(
      graph.container,
      normalized.cursor,
      normalized.phase === 'visual' ? normalized.anchor : null,
    );
    const cursorParent = resolveTextPosition(graph.container, normalized.cursor)
      ?.node.parentElement;
    if (cursorParent) scrollVimTargetIntoView(cursorParent, scrollViewportRef.current);
  }, [setState]);

  const enterTextAtTarget = useCallback((
    graph: SemanticTargetGraph,
    target: SemanticTarget,
  ): boolean => {
    const bounds = getTextElementBounds(graph.container, target.element);
    if (!bounds) return false;
    updateTextState(graph, {
      phase: 'text',
      targetKey: target.key,
      cursor: bounds.start,
    });
    return true;
  }, [updateTextState]);

  const enterVisualAtTarget = useCallback((
    graph: SemanticTargetGraph,
    target: SemanticTarget,
  ): boolean => {
    const bounds = getTextElementBounds(graph.container, target.element);
    if (!bounds) return false;
    updateTextState(graph, {
      phase: 'visual',
      targetKey: target.key,
      anchor: bounds.start,
      cursor: bounds.start,
    });
    return true;
  }, [updateTextState]);

  const enterVisualBlock = useCallback((
    graph: SemanticTargetGraph,
    target: SemanticTarget,
  ): boolean => {
    const block = getOwningBlockTarget(graph, target);
    const next: VimVisualBlockState = {
      phase: 'visual-block',
      anchorTargetKey: block.key,
      targetKey: block.key,
    };
    if (!getTextElementBounds(graph.container, block.element)) return false;
    setState(next);
    applyVisualBlockSelection(graph, next);
    scrollVimTargetIntoView(block.element, scrollViewportRef.current);
    return true;
  }, [setState]);

  const runTargetAction = useCallback((
    target: SemanticTarget,
    returnTo: VimBlockState | VimInlineState,
    modeOverride?: EditorMode,
  ): boolean => {
    const effectiveMode = modeOverride ?? activeMode;
    const beginAction = () => {
      restoreFocusRef.current = effectiveMode !== 'redline';
      setState(
        effectiveMode !== 'redline'
          ? { phase: 'action', returnTo }
          : returnTo,
      );
    };

    if (target.kind === 'code') {
      beginAction();
      onCodeBlockAction(target.blockId, target.element, modeOverride);
      return true;
    }
    if (target.kind === 'math') {
      beginAction();
      onMathAction(target.element, modeOverride);
      return true;
    }
    const range = createSemanticTargetRange(target);
    if (!range) return false;
    beginAction();
    onHighlightRange(range, modeOverride);
    return true;
  }, [
    activeMode,
    onCodeBlockAction,
    onHighlightRange,
    onMathAction,
    setState,
  ]);

  const runRangeAction = useCallback((
    graph: SemanticTargetGraph,
    range: Range,
    returnTo: VimVisualState | VimVisualBlockState,
    modeOverride?: EditorMode,
  ): boolean => {
    const effectiveMode = modeOverride ?? activeMode;
    const immediateReturn: VimRestorableState = returnTo.phase === 'visual'
      ? {
          phase: 'text' as const,
          targetKey: returnTo.targetKey,
          cursor: returnTo.cursor,
        }
      : (() => {
          const target = resolveSemanticTarget(graph, returnTo.targetKey);
          return target ? semanticStateForTarget(target) : returnTo;
        })();
    restoreFocusRef.current = effectiveMode !== 'redline';
    setState(
      effectiveMode !== 'redline'
        ? { phase: 'action', returnTo }
        : immediateReturn,
    );
    onHighlightRange(range, modeOverride);
    return true;
  }, [activeMode, onHighlightRange, setState]);

  const actionForCurrentState = useCallback((
    graph: SemanticTargetGraph,
    current: VimRestorableState,
    modeOverride?: EditorMode,
  ): boolean => {
    if (current.phase === 'visual') {
      const range = selectedTextRange(graph.container, current);
      return range
        ? runRangeAction(graph, range, current, modeOverride)
        : false;
    }
    if (current.phase === 'visual-block') {
      const range = visualBlockRange(graph, current);
      return range
        ? runRangeAction(graph, range, current, modeOverride)
        : false;
    }

    const target = resolveSemanticTarget(graph, current.targetKey);
    if (!target) return false;
    return runTargetAction(
      target,
      semanticStateForTarget(target),
      modeOverride,
    );
  }, [runRangeAction, runTargetAction]);

  const copyCurrentState = useCallback((
    graph: SemanticTargetGraph,
    current: VimRestorableState,
  ): boolean => {
    if (current.phase === 'visual') {
      const range = selectedTextRange(graph.container, current);
      if (!range) return false;
      copyTextPreservingFocus(range.toString(), graph.container);
      updateTextState(graph, {
        phase: 'text',
        targetKey: current.targetKey,
        cursor: current.cursor,
      });
      return true;
    }
    if (current.phase === 'visual-block') {
      const range = visualBlockRange(graph, current);
      if (!range) return false;
      copyTextPreservingFocus(range.toString(), graph.container);
      const target = resolveSemanticTarget(graph, current.targetKey);
      if (target) setSemanticTarget(target);
      return true;
    }
    const target = resolveSemanticTarget(graph, current.targetKey);
    if (!target) return false;
    copyTextPreservingFocus(
      target.element.textContent?.trim() ?? '',
      graph.container,
    );
    return true;
  }, [setSemanticTarget, updateTextState]);

  const handleSemanticKey = useCallback((
    graph: SemanticTargetGraph,
    current: VimBlockState | VimInlineState,
    key: string,
  ): boolean => {
    const target = resolveSemanticTarget(graph, current.targetKey);
    if (!target) return false;

    if (key === 'j' || key === 'k' || key === '{' || key === '}') {
      const previous = key === 'k' || key === '{';
      setSemanticTarget(moveSemanticTarget(
        graph,
        target,
        current.phase === 'inline' && (key === 'j' || key === 'k')
          ? previous
            ? 'previous-sibling'
            : 'next-sibling'
          : previous
            ? 'previous-block'
            : 'next-block',
      ));
      return true;
    }
    if (key === 'h' || key === 'H') {
      const parent = moveSemanticTarget(graph, target, 'parent');
      if (parent.key !== target.key) setSemanticTarget(parent);
      return true;
    }
    if (key === 'l') {
      const child = getSemanticTargetChildren(graph, target)[0];
      if (!child) return enterTextAtTarget(graph, target);
      setSemanticTarget(child);
      return true;
    }
    if (key === 'v') return enterVisualAtTarget(graph, target);
    if (key === 'V') return enterVisualBlock(graph, target);
    if (key === 'Enter') return actionForCurrentState(graph, current);
    if (key === 'y') return copyCurrentState(graph, current);
    const actionMode = selectionModeForAction(key);
    return actionMode
      ? actionForCurrentState(graph, current, actionMode)
      : false;
  }, [
    actionForCurrentState,
    copyCurrentState,
    enterTextAtTarget,
    enterVisualAtTarget,
    enterVisualBlock,
    setSemanticTarget,
  ]);

  const handleTextKey = useCallback((
    graph: SemanticTargetGraph,
    current: VimTextState | VimVisualState,
    key: string,
  ): boolean => {
    if (key === 'v') {
      if (current.phase === 'visual') {
        updateTextState(graph, {
          phase: 'text',
          targetKey: current.targetKey,
          cursor: current.cursor,
        });
      } else {
        updateTextState(graph, {
          phase: 'visual',
          targetKey: current.targetKey,
          cursor: current.cursor,
          anchor: current.cursor,
        });
      }
      return true;
    }
    if (key === 'V') {
      const target = resolveSemanticTarget(graph, current.targetKey);
      return target ? enterVisualBlock(graph, target) : false;
    }
    if (key === 'o' && current.phase === 'visual') {
      updateTextState(graph, {
        ...current,
        anchor: current.cursor,
        cursor: current.anchor,
      });
      return true;
    }
    if (key === 'Enter') {
      return current.phase === 'visual'
        ? actionForCurrentState(graph, current)
        : false;
    }
    if (key === 'y') {
      return current.phase === 'visual'
        ? copyCurrentState(graph, current)
        : false;
    }
    const actionMode = selectionModeForAction(key);
    if (actionMode) {
      return current.phase === 'visual'
        ? actionForCurrentState(graph, current, actionMode)
        : false;
    }
    if (key === 'G') {
      updateTextState(graph, {
        ...current,
        cursor: moveTextPosition(
          graph.container,
          current.cursor,
          'document-end',
          scrollViewportRef.current,
        ),
      });
      return true;
    }
    if (key === 'j' || key === 'k' || key === '0' || key === '$') {
      const direction = key === 'j' || key === '$' ? 'forward' : 'backward';
      const granularity = key === 'j' || key === 'k' ? 'line' : 'lineboundary';
      const nativePosition = moveWithNativeSelection(
        graph.container,
        current,
        direction,
        granularity,
      );
      const fallback: VimTextMotion = key === 'j'
        ? 'block-forward'
        : key === 'k'
          ? 'block-backward'
          : key === '0'
            ? 'line-start'
            : 'line-end';
      updateTextState(graph, {
        ...current,
        cursor: clampPositionToSemanticTarget(
          graph,
          current.targetKey,
          nativePosition
            ?? moveTextPosition(
              graph.container,
              current.cursor,
              fallback,
              scrollViewportRef.current,
            ),
          direction,
        ),
      });
      return true;
    }
    const motion = motionFromTextKey(key);
    if (!motion) return false;
    const nextPosition = moveTextPosition(
      graph.container,
      current.cursor,
      motion,
      scrollViewportRef.current,
    );
    updateTextState(graph, {
      ...current,
      cursor: motion === 'block-backward' || motion === 'block-forward'
        ? nextPosition
        : clampPositionToSemanticTarget(
            graph,
            current.targetKey,
            nextPosition,
            motion === 'left' || motion === 'word-backward' ? 'backward' : 'forward',
          ),
    });
    return true;
  }, [
    actionForCurrentState,
    copyCurrentState,
    enterVisualBlock,
    updateTextState,
  ]);

  const handleVisualBlockKey = useCallback((
    graph: SemanticTargetGraph,
    current: VimVisualBlockState,
    key: string,
  ): boolean => {
    if (key === 'V') {
      const target = resolveSemanticTarget(graph, current.targetKey);
      if (target) setSemanticTarget(target);
      return true;
    }
    if (key === 'j' || key === 'k') {
      const target = resolveSemanticTarget(graph, current.targetKey);
      if (!target) return false;
      const next = moveSemanticTarget(
        graph,
        target,
        key === 'j' ? 'next-block' : 'previous-block',
      );
      const nextState: VimVisualBlockState = {
        ...current,
        targetKey: getOwningBlockTarget(graph, next).key,
      };
      setState(nextState);
      applyVisualBlockSelection(graph, nextState);
      scrollVimTargetIntoView(next.element, scrollViewportRef.current);
      return true;
    }
    if (key === 'o') {
      const next: VimVisualBlockState = {
        phase: 'visual-block',
        anchorTargetKey: current.targetKey,
        targetKey: current.anchorTargetKey,
      };
      setState(next);
      applyVisualBlockSelection(graph, next);
      return true;
    }
    if (key === 'Enter') return actionForCurrentState(graph, current);
    if (key === 'y') return copyCurrentState(graph, current);
    const actionMode = selectionModeForAction(key);
    return actionMode
      ? actionForCurrentState(graph, current, actionMode)
      : false;
  }, [
    actionForCurrentState,
    copyCurrentState,
    setSemanticTarget,
    setState,
  ]);

  const escapeCurrentState = useCallback((
    graph: SemanticTargetGraph,
    current: VimSelectionState,
  ) => {
    switch (current.phase) {
      case 'inactive':
        return;
      case 'action':
        setState(current.returnTo);
        return;
      case 'visual':
        updateTextState(graph, {
          phase: 'text',
          targetKey: current.targetKey,
          cursor: current.cursor,
        });
        return;
      case 'text': {
        const target = resolveSemanticTarget(graph, current.targetKey);
        if (target) setSemanticTarget(target);
        return;
      }
      case 'visual-block': {
        const target = resolveSemanticTarget(graph, current.targetKey);
        if (target) setSemanticTarget(target);
        return;
      }
      case 'inline': {
        const target = resolveSemanticTarget(graph, current.targetKey);
        const parent = target
          ? moveSemanticTarget(graph, target, 'parent')
          : null;
        if (parent && parent.key !== target?.key) {
          setSemanticTarget(parent);
        } else {
          setState(createInitialVimSelectionState());
          window.getSelection()?.removeAllRanges();
        }
        return;
      }
      case 'block':
        setState(createInitialVimSelectionState());
        window.getSelection()?.removeAllRanges();
    }
  }, [setSemanticTarget, setState, updateTextState]);

  const jumpToDocumentBlock = useCallback((
    graph: SemanticTargetGraph,
    end: boolean,
  ): boolean => {
    const current = stateRef.current;
    if (current.phase === 'text' || current.phase === 'visual') {
      updateTextState(graph, {
        ...current,
        cursor: moveTextPosition(
          graph.container,
          current.cursor,
          end ? 'document-end' : 'document-start',
          scrollViewportRef.current,
        ),
      });
      return true;
    }
    const currentTarget = resolveSemanticTarget(graph, targetKeyForState(current))
      ?? findInitialSemanticTarget(graph, scrollViewportRef.current);
    if (!currentTarget) return false;
    setSemanticTarget(moveSemanticTarget(
      graph,
      currentTarget,
      end ? 'last-block' : 'first-block',
    ));
    return true;
  }, [setSemanticTarget, updateTextState]);

  const canHandleShortcut = useCallback((event: KeyboardEvent) => (
    enabled
    && !blocked
    && focused
    && !event.isComposing
    && !isDocumentKeyboardControl(event.target)
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  ), [blocked, enabled, focused]);

  const recordHudCommand = useCallback((
    actionId: VimSelectionActionId,
    event: KeyboardEvent,
    context: VimSelectionState['phase'],
  ) => {
    if (!hudEnabled) return;
    hudSequenceRef.current += 1;
    setHudCommand(createVimHudCommand(
      hudSequenceRef.current,
      actionId,
      event.key,
      context,
    ));
  }, [hudEnabled]);

  const onKeyDown = useCallback((
    event: KeyboardEvent,
    actionId: VimSelectionActionId,
  ) => {
    if (!canHandleShortcut(event)) return;

    if (stateRef.current.phase === 'action') {
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    const graph = buildSemanticTargetGraph(container);
    const key = event.key;
    const context = stateRef.current.phase;
    let handled = false;

    if (helpOpen) {
      if (key === 'Escape' || key === '?') {
        setHelpOpen(false);
        handled = true;
      }
    } else if (key === '?') {
      setHelpOpen(true);
      handled = true;
    } else if (key === 'Escape') {
      if (stateRef.current.phase !== 'inactive') {
        escapeCurrentState(graph, stateRef.current);
        handled = true;
      }
    } else {
      let current = stateRef.current;
      if (current.phase === 'inactive') {
        current = initializeSemanticNavigation()
          ?? createInitialVimSelectionState();
      }

      if (key === 'G') {
        handled = jumpToDocumentBlock(graph, true);
      } else if (current.phase === 'block' || current.phase === 'inline') {
        handled = handleSemanticKey(graph, current, key);
      } else if (current.phase === 'text' || current.phase === 'visual') {
        handled = handleTextKey(graph, current, key);
      } else if (current.phase === 'visual-block') {
        handled = handleVisualBlockKey(graph, current, key);
      }
    }

    if (handled) {
      onHandledCommand?.();
      recordHudCommand(actionId, event, context);
      event.preventDefault();
      event.stopPropagation();
    }
  }, [
    canHandleShortcut,
    containerRef,
    escapeCurrentState,
    handleSemanticKey,
    handleTextKey,
    handleVisualBlockKey,
    helpOpen,
    initializeSemanticNavigation,
    jumpToDocumentBlock,
    onHandledCommand,
    recordHudCommand,
  ]);

  const onDocumentStart = useCallback((event: KeyboardEvent) => {
    if (!canHandleShortcut(event) || stateRef.current.phase === 'action') return;
    const container = containerRef.current;
    if (!container) return;
    const context = stateRef.current.phase;
    if (jumpToDocumentBlock(buildSemanticTargetGraph(container), false)) {
      onHandledCommand?.();
      recordHudCommand('documentStart', event, context);
      event.preventDefault();
      event.stopPropagation();
    }
  }, [
    canHandleShortcut,
    containerRef,
    jumpToDocumentBlock,
    onHandledCommand,
    recordHudCommand,
  ]);

  const shortcutHandler = (actionId: VimSelectionActionId) => ({
    when: canHandleShortcut,
    handle: (event: KeyboardEvent) => onKeyDown(event, actionId),
  });
  useVimSelectionShortcuts({
    target: containerRef.current,
    handlers: {
      moveDown: shortcutHandler('moveDown'),
      moveUp: shortcutHandler('moveUp'),
      documentStart: { when: canHandleShortcut, handle: onDocumentStart },
      documentEnd: shortcutHandler('documentEnd'),
      moveOut: shortcutHandler('moveOut'),
      refine: shortcutHandler('refine'),
      visual: shortcutHandler('visual'),
      visualBlock: shortcutHandler('visualBlock'),
      wordForward: shortcutHandler('wordForward'),
      wordBackward: shortcutHandler('wordBackward'),
      wordEnd: shortcutHandler('wordEnd'),
      lineStart: shortcutHandler('lineStart'),
      lineEnd: shortcutHandler('lineEnd'),
      previousTextBlock: shortcutHandler('previousTextBlock'),
      nextTextBlock: shortcutHandler('nextTextBlock'),
      swapSelectionEnds: shortcutHandler('swapSelectionEnds'),
      activeAnnotation: shortcutHandler('activeAnnotation'),
      annotationMenu: shortcutHandler('annotationMenu'),
      comment: shortcutHandler('comment'),
      redline: shortcutHandler('redline'),
      markup: shortcutHandler('markup'),
      label: shortcutHandler('label'),
      copy: shortcutHandler('copy'),
      cancel: shortcutHandler('cancel'),
      help: shortcutHandler('help'),
    },
  });

  const onFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (!enabled || event.target !== event.currentTarget) return;
    setFocused(true);
  }, [enabled]);

  const onBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (
      event.relatedTarget instanceof Element
      && event.relatedTarget.closest('[data-vim-key-hud]')
    ) {
      return;
    }
    setFocused(false);
  }, []);

  const onHudFocusLeave = useCallback(() => {
    if (containerRef.current === document.activeElement) return;
    setFocused(false);
  }, [containerRef]);

  const focusDocument = useCallback((): boolean => {
    const container = containerRef.current;
    if (!enabled || !container) return false;
    if (document.activeElement === container) return false;
    restoringFocusRef.current = stateRef.current.phase !== 'inactive';
    container.focus({ preventScroll: true });
    return document.activeElement === container;
  }, [containerRef, enabled]);

  useVimDocumentFocus({
    enabled,
    blocked,
    focusDocument,
  });

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!enabled || isDocumentKeyboardControl(event.target)) return;
    setState(createInitialVimSelectionState());
    window.getSelection()?.removeAllRanges();
    if (document.activeElement !== event.currentTarget) {
      pointerFocusRef.current = true;
      event.currentTarget.focus({ preventScroll: true });
    }
  }, [enabled, setState]);

  return {
    state,
    focused,
    helpOpen,
    hudCommand,
    activeTarget,
    onFocus,
    onBlur,
    onMouseDown,
    onHelpOpenChange: setHelpOpen,
    onHudFocusLeave,
  };
}

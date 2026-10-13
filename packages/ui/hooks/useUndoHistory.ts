import { useRef } from 'react';
import {
  createUndoHistoryState,
  recordUndoAction,
  takeRedoAction,
  takeUndoAction,
  type HistoryDirection,
  type UndoHistoryState,
} from '../utils/undoHistory';

/** Imperative bounded history API used by surface-specific command adapters. */
export interface UndoHistoryApi<TAction> {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  record: (action: TAction) => void;
  /**
   * Coalesce into the newest undo entry: when it is still `expected` (the
   * same object), replace it with `next`, or drop it when `next` is null.
   * Returns false, changing nothing, when anything was recorded, undone or
   * cleared since. Used to fold a typing burst into one entry.
   */
  replaceLast: (expected: TAction, next: TAction | null) => boolean;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
}

interface UndoHistoryOptions<TAction> {
  context: string;
  apply: (action: TAction, direction: HistoryDirection) => void;
  capacity?: number;
}

/**
 * Keep one bounded stack for the active surface context while replaying
 * actions through the latest adapter callbacks. A context change starts a
 * fresh baseline synchronously, before any shortcut can reach the new view.
 */
export function useUndoHistory<TAction>({
  context,
  apply,
  capacity = 50,
}: UndoHistoryOptions<TAction>): UndoHistoryApi<TAction> {
  const optionsRef = useRef({ apply, capacity });
  optionsRef.current = { apply, capacity };
  const historyRef = useRef<{
    context: string;
    state: UndoHistoryState<TAction>;
  }>({ context, state: createUndoHistoryState<TAction>() });
  if (historyRef.current.context !== context) {
    historyRef.current = { context, state: createUndoHistoryState<TAction>() };
  }
  const apiRef = useRef<UndoHistoryApi<TAction> | null>(null);

  if (!apiRef.current) {
    apiRef.current = {
      get canUndo() {
        return historyRef.current.state.past.length > 0;
      },
      get canRedo() {
        return historyRef.current.state.future.length > 0;
      },
      record(action) {
        const history = historyRef.current;
        history.state = recordUndoAction(history.state, action, optionsRef.current.capacity);
      },
      replaceLast(expected, next) {
        const history = historyRef.current;
        const { past, future } = history.state;
        if (past.length === 0 || past[past.length - 1] !== expected || future.length > 0) return false;
        history.state = {
          past: next === null ? past.slice(0, -1) : [...past.slice(0, -1), next],
          future,
        };
        return true;
      },
      undo() {
        const history = historyRef.current;
        const step = takeUndoAction(history.state);
        if (step.action === null) return false;
        history.state = step.state;
        optionsRef.current.apply(step.action, 'undo');
        return true;
      },
      redo() {
        const history = historyRef.current;
        const step = takeRedoAction(history.state, optionsRef.current.capacity);
        if (step.action === null) return false;
        history.state = step.state;
        optionsRef.current.apply(step.action, 'redo');
        return true;
      },
      clear() {
        historyRef.current.state = createUndoHistoryState<TAction>();
      },
    };
  }

  return apiRef.current;
}

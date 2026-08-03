import { useEffect, useRef } from 'react';
import type { ShortcutDefinition, ShortcutScopeDefinition } from './core';
import { matchesKeyName, matchesShortcutBinding, parseDoubleTapBinding } from './core';

type ShortcutActionId<TScope extends ShortcutScopeDefinition<any>> = keyof TScope['shortcuts'] & string;

export interface ShortcutHandlerConfig {
  when?: (event: KeyboardEvent) => boolean;
  handle: (event: KeyboardEvent) => void;
}

export type ShortcutHandler = ((event: KeyboardEvent) => void) | ShortcutHandlerConfig;

export type ShortcutHandlers<TScope extends ShortcutScopeDefinition<any>> = Partial<
  Record<ShortcutActionId<TScope>, ShortcutHandler>
>;

type ShortcutEventTarget = 'window' | 'document' | EventTarget | null;

export interface UseShortcutScopeOptions<TScope extends ShortcutScopeDefinition<any>> {
  scope: TScope;
  handlers: ShortcutHandlers<TScope>;
  target?: ShortcutEventTarget;
  stopOnMatch?: boolean;
}

function normalizeShortcutHandler(handler: ShortcutHandler): ShortcutHandlerConfig {
  if (typeof handler === 'function') {
    return { handle: handler };
  }

  return handler;
}

// TODO(migration): no cross-scope arbitration. When two scopes bind the
// same key (e.g. `Escape` in both an outer editor scope and an inner
// dialog scope), both `useShortcutScope` listeners fire on a single
// keypress. Add `if (event.defaultPrevented) return false;` at the top
// of this function once shortcut definitions consistently set
// `preventDefault: true` (or once we flip the default). Until then,
// callers must guard with `when` to prevent double-handling.
export function dispatchShortcutEvent<TScope extends ShortcutScopeDefinition<any>>(
  scope: TScope,
  handlers: ShortcutHandlers<TScope>,
  event: KeyboardEvent,
  options?: { stopOnMatch?: boolean },
): boolean {
  const stopOnMatch = options?.stopOnMatch ?? true;
  let handled = false;

  for (const [actionId, shortcut] of Object.entries(scope.shortcuts) as Array<[
    ShortcutActionId<TScope>,
    ShortcutDefinition,
  ]>) {
    const handler = handlers[actionId];
    if (!handler) continue;
    if (!shortcut.bindings.some(binding => matchesShortcutBinding(event, binding))) continue;

    const { when, handle } = normalizeShortcutHandler(handler);
    if (when && !when(event)) continue;

    if (shortcut.preventDefault) {
      event.preventDefault();
    }

    handle(event);
    handled = true;

    if (stopOnMatch) {
      return true;
    }
  }

  return handled;
}

function getEventTarget(target: ShortcutEventTarget): EventTarget | null {
  if (target === 'window') {
    return typeof window === 'undefined' ? null : window;
  }
  if (target === 'document') {
    return typeof document === 'undefined' ? null : document;
  }
  return target;
}

export function useShortcutScope<TScope extends ShortcutScopeDefinition<any>>({
  scope,
  handlers,
  target = 'window',
  stopOnMatch = true,
}: UseShortcutScopeOptions<TScope>) {
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const eventTarget = getEventTarget(target);
    if (!eventTarget || !('addEventListener' in eventTarget)) return;

    const handleKeyDown = (event: Event) => {
      dispatchShortcutEvent(scope, handlersRef.current, event as KeyboardEvent, { stopOnMatch });
    };

    eventTarget.addEventListener('keydown', handleKeyDown as EventListener);
    return () => {
      eventTarget.removeEventListener('keydown', handleKeyDown as EventListener);
    };
  }, [scope, stopOnMatch, target]);
}

export function createShortcutScopeHook<TScope extends ShortcutScopeDefinition<any>>(scope: TScope) {
  return function useScopedShortcutScope(options: Omit<UseShortcutScopeOptions<TScope>, 'scope'>) {
    useShortcutScope({ scope, ...options });
  };
}

// --- Multi-press shortcut support ---
//
// `useShortcutScope` only dispatches single-press bindings — anything with
// whitespace (e.g. `"Alt Alt"`) or the `hold` token (e.g. `"Alt hold"`)
// short-circuits in `matchesShortcutBinding`. Multi-press bindings need a
// dedicated hook that knows their semantics:
//
//   - Double-tap → `useDoubleTapShortcuts` below.
//   - Hold       → no shared hook yet; wire by hand in the consuming
//                  component until one is built. The `Alt hold` binding in
//                  `inputMethodShortcuts` is currently driven by the
//                  bespoke `useInputMethodSwitch` hook in the plan editor.
//
// TODO: when the App.tsx migration starts touching hold semantics, add a
// `useHoldShortcuts` here paired with a `parseHoldBinding` in core.ts so the
// registry-driven path actually fires.

// --- Double-tap shortcut support ---

export type DoubleTapHandlers<TScope extends ShortcutScopeDefinition<any>> = Partial<
  Record<ShortcutActionId<TScope>, ShortcutHandler>
>;

export interface UseDoubleTapShortcutsOptions<TScope extends ShortcutScopeDefinition<any>> {
  scope: TScope;
  handlers: DoubleTapHandlers<TScope>;
  /** Max gap between two key releases to count as a double-tap (default: 300ms). */
  window?: number;
}

/**
 * Hook for handling double-tap shortcuts (bindings like `"Alt Alt"`).
 *
 * Double-tap is detected on keyup: if the same key is released twice
 * within `window` ms, the handler fires. Regular (keydown) bindings
 * in the same scope are ignored — use `useShortcutScope` for those.
 */
export function useDoubleTapShortcuts<TScope extends ShortcutScopeDefinition<any>>({
  scope,
  handlers,
  window: tapWindow = 300,
}: UseDoubleTapShortcutsOptions<TScope>) {
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; }, [handlers]);

  useEffect(() => {
    // Pre-parse which actions have double-tap bindings
    const doubleTapActions: Array<{ actionId: ShortcutActionId<TScope>; keyName: string; preventDefault: boolean }> = [];
    for (const [actionId, shortcut] of Object.entries(scope.shortcuts) as Array<[
      ShortcutActionId<TScope>,
      ShortcutDefinition,
    ]>) {
      for (const binding of shortcut.bindings) {
        const keyName = parseDoubleTapBinding(binding);
        if (keyName) {
          doubleTapActions.push({ actionId, keyName, preventDefault: shortcut.preventDefault === true });
        }
      }
    }

    if (doubleTapActions.length === 0) return;

    // Track last keyup timestamp per key
    const lastKeyUp = new Map<string, number>();
    // A tap only counts when the key went down and came up ALONE. Without this,
    // any two releases of (say) Shift within the window fire the action: typing
    // two capitalized words, extending a selection with two Shift+Clicks, or
    // pressing a Mod+Shift+<key> chord twice. cleanPress marks a press as solo
    // until any other key or pointer interaction intervenes.
    const cleanPress = new Map<string, boolean>();
    const MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift'];

    const invalidateSequence = () => {
      cleanPress.clear();
      lastKeyUp.clear();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      let tracked = false;
      for (const { keyName } of doubleTapActions) {
        if (matchesKeyName(event, keyName)) {
          tracked = true;
          if (!event.repeat) cleanPress.set(keyName, true);
        }
      }
      // Any non-tracked keydown breaks both the current press and the sequence.
      if (!tracked) invalidateSequence();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      for (const { actionId, keyName, preventDefault } of doubleTapActions) {
        if (!matchesKeyName(event, keyName)) continue;

        // Release with another modifier still held (Mod+Shift+B) or after a
        // non-solo press: not a tap, and it resets the sequence.
        const otherModifierHeld = MODIFIER_KEYS.some(
          (m) => m !== keyName && event.getModifierState(m),
        );
        if (otherModifierHeld || cleanPress.get(keyName) !== true) {
          lastKeyUp.delete(keyName);
          cleanPress.delete(keyName);
          continue;
        }
        cleanPress.delete(keyName); // release consumes the press

        const handler = handlersRef.current[actionId];
        if (!handler) continue;

        const { when, handle } = normalizeShortcutHandler(handler);
        if (when && !when(event)) continue;

        const now = Date.now();
        const prev = lastKeyUp.get(keyName) ?? 0;
        if (now - prev < tapWindow) {
          if (preventDefault) event.preventDefault();
          handle(event);
          lastKeyUp.set(keyName, 0); // reset so triple-tap doesn't re-fire
        } else {
          lastKeyUp.set(keyName, now);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp);
    // Pointer interaction mid-press (Shift+Click selection) breaks the tap.
    window.addEventListener('mousedown', invalidateSequence, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', invalidateSequence, true);
    };
  }, [scope, tapWindow]);
}

export function createDoubleTapShortcutsHook<TScope extends ShortcutScopeDefinition<any>>(scope: TScope) {
  return function useScopedDoubleTap(options: Omit<UseDoubleTapShortcutsOptions<TScope>, 'scope'>) {
    useDoubleTapShortcuts({ scope, ...options });
  };
}

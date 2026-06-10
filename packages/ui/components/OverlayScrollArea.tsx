import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from 'react';

/**
 * Native scroll container.
 *
 * Was an `overlayscrollbars-react` wrapper (#509 "Zed-style overlay scrollbars").
 * Replaced with **native OS scrollbars** — the element you render IS the scroll node,
 * so the deferred-init event dance, the force-recompute ResizeObserver, and the
 * inner-viewport indirection are all gone. Scrollbar appearance is native, styled
 * globally via `scrollbar-width: thin` + `scrollbar-color` in theme.css/styles.css.
 *
 * The public API is preserved on purpose (name, `onViewportReady`, the imperative
 * handle) so existing consumers don't change — they just receive the host element,
 * which now genuinely is the scrolling element.
 *
 * NOTE: do NOT reintroduce a `::-webkit-scrollbar { width: 6px }` rule — that thin
 * rail was the original "can't grab the scrollbar" bug (#354).
 */
export interface OverlayScrollAreaHandle {
  /** The DOM element that scrolls, or null before mount. */
  getViewport(): HTMLElement | null;
}

export interface OverlayScrollAreaProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** Root element tag (default 'div'). Use 'main' for the primary plan viewport. */
  element?: ElementType;
  children?: ReactNode;
  /** Fires with the scroll element on mount, and `null` on unmount. */
  onViewportReady?: (viewport: HTMLElement | null) => void;
  /** Horizontal overflow (default 'hidden'). */
  overflowX?: 'hidden' | 'scroll' | 'visible' | 'auto';
  /** Vertical overflow (default 'auto'). */
  overflowY?: 'hidden' | 'scroll' | 'visible' | 'auto';
}

export const OverlayScrollArea = forwardRef<
  OverlayScrollAreaHandle,
  OverlayScrollAreaProps
>(function OverlayScrollArea(
  {
    element = 'div',
    children,
    onViewportReady,
    overflowX = 'hidden',
    overflowY = 'auto',
    style,
    ...rest
  },
  ref,
) {
  const elRef = useRef<HTMLElement | null>(null);
  // Hold the latest callback without changing the ref-callback identity, so the
  // element isn't detached/reattached on every parent render.
  const onReadyRef = useRef(onViewportReady);
  onReadyRef.current = onViewportReady;

  const getViewport = useCallback((): HTMLElement | null => elRef.current, []);
  useImperativeHandle(ref, () => ({ getViewport }), [getViewport]);

  const setEl = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
    onReadyRef.current?.(node);
  }, []);

  const Comp = element as ElementType;
  const mergedStyle: CSSProperties = { overflowX, overflowY, ...style };

  return (
    <Comp ref={setEl as React.Ref<HTMLElement>} style={mergedStyle} {...rest}>
      {children}
    </Comp>
  );
});

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { InputMethod } from '../types';
import {
  buildSemanticTargetGraph,
  createSemanticTargetRange,
  resolveSemanticTargetAtPoint,
  type SemanticTarget,
} from '../utils/blockTargeting';

/** Inputs for pointer Pinpoint targeting within one rendered document. */
export interface UsePinpointOptions {
  containerRef: RefObject<HTMLElement | null>;
  inputMethod: InputMethod;
  /** Disable when toolbar/popover/diff is active */
  enabled: boolean;
  /** Submit a text range through the shared annotation pipeline. */
  onSelectRange: (range: Range) => void;
  /** Handle code block clicks (needs special annotation path) */
  onCodeBlockClick: (blockId: string, element: HTMLElement) => void;
}

/** Live pointer-owned state returned by `usePinpoint`. */
export interface UsePinpointReturn {
  /** Live target from the canonical semantic graph under the pointer. */
  hoverTarget: SemanticTarget | null;
  /** Release pointer-owned feedback so keyboard navigation can take over. */
  clearHover: () => void;
}

/**
 * Resolve pointer hover and clicks through the canonical semantic target graph.
 *
 * The hook mutates only its transient hover marker and removes it when disabled
 * or unmounted.
 */
export function usePinpoint({
  containerRef,
  inputMethod,
  enabled,
  onSelectRange,
  onCodeBlockClick,
}: UsePinpointOptions): UsePinpointReturn {
  const [hoverTarget, setHoverTarget] = useState<SemanticTarget | null>(null);
  const hoverElementRef = useRef<HTMLElement | null>(null);

  const isActive = inputMethod === 'pinpoint' && enabled;
  const clearHover = useCallback(() => {
    hoverElementRef.current?.removeAttribute('data-pinpoint-hover');
    hoverElementRef.current = null;
    setHoverTarget(null);
  }, []);

  // Clear hover when deactivated
  useEffect(() => {
    if (!isActive) {
      clearHover();
    }
  }, [clearHover, isActive]);

  // Mousemove / touchstart — resolve target and update hover state
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    let graph = buildSemanticTargetGraph(container);
    let graphIsDirty = false;
    const liveGraph = () => {
      if (graphIsDirty) {
        graph = buildSemanticTargetGraph(container);
        graphIsDirty = false;
      }
      return graph;
    };
    const observer = new MutationObserver(() => {
      graphIsDirty = true;
    });
    observer.observe(container, { childList: true, subtree: true });

    const updateHover = (clientX: number, clientY: number, target: HTMLElement) => {
      const resolved = resolveSemanticTargetAtPoint(
        liveGraph(),
        target,
        { clientX, clientY },
      );

      if (resolved) {
        if (resolved.element !== hoverElementRef.current) {
          hoverElementRef.current?.removeAttribute('data-pinpoint-hover');
          resolved.element.setAttribute('data-pinpoint-hover', '');
          hoverElementRef.current = resolved.element;
          setHoverTarget(resolved);
        }
      } else {
        clearHover();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      updateHover(e.clientX, e.clientY, e.target as HTMLElement);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
      if (target) updateHover(touch.clientX, touch.clientY, target);
    };

    const handleMouseLeave = () => {
      clearHover();
    };

    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });

    return () => {
      observer.disconnect();
      hoverElementRef.current?.removeAttribute('data-pinpoint-hover');
      hoverElementRef.current = null;
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('touchstart', handleTouchStart);
    };
  }, [clearHover, isActive, containerRef]);

  // Click — create Range and trigger web-highlighter
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const resolved = resolveSemanticTargetAtPoint(
        buildSemanticTargetGraph(container),
        target,
        { clientX: e.clientX, clientY: e.clientY },
      );
      if (!resolved) return;

      // Prevent link navigation in pinpoint mode
      const link = (target.closest('a') as HTMLAnchorElement | null);
      if (link && container.contains(link)) {
        e.preventDefault();
      }

      // Clear hover state
      resolved.element.removeAttribute('data-pinpoint-hover');
      setHoverTarget(null);

      if (resolved.kind === 'code') {
        // Route to existing code block annotation path
        const codeBlockContainer = container.querySelector(`[data-block-id="${resolved.blockId}"]`) as HTMLElement;
        if (codeBlockContainer) {
          onCodeBlockClick(resolved.blockId, codeBlockContainer);
        }
        return;
      }

      // Create a text-level Range spanning the target element's content.
      // web-highlighter needs ranges anchored to text nodes, not elements.
      const range = createSemanticTargetRange(resolved);
      if (!range) return;

      onSelectRange(range);
    };

    // Use capture phase so we get the click before links navigate
    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [isActive, containerRef, onCodeBlockClick, onSelectRange]);

  return { hoverTarget, clearHover };
}

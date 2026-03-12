import { useEffect, useState, useCallback, type RefObject } from 'react';
import type Highlighter from '@plannotator/web-highlighter';
import type { InputMethod } from '../types';
import { resolvePinpointTarget, type PinpointTarget } from '../utils/blockTargeting';

export interface UsePinpointOptions {
  containerRef: RefObject<HTMLElement | null>;
  highlighterRef: RefObject<Highlighter | null>;
  inputMethod: InputMethod;
  /** Disable when toolbar/popover/diff is active */
  enabled: boolean;
  /** Handle code block clicks (needs special annotation path) */
  onCodeBlockClick: (blockId: string, element: HTMLElement) => void;
}

export interface UsePinpointReturn {
  hoverTarget: { element: HTMLElement; label: string } | null;
}

export function usePinpoint({
  containerRef,
  highlighterRef,
  inputMethod,
  enabled,
  onCodeBlockClick,
}: UsePinpointOptions): UsePinpointReturn {
  const [hoverTarget, setHoverTarget] = useState<{ element: HTMLElement; label: string } | null>(null);

  const isActive = inputMethod === 'pinpoint' && enabled;

  // Clear hover when deactivated
  useEffect(() => {
    if (!isActive) {
      setHoverTarget((prev) => {
        if (prev) prev.element.removeAttribute('data-pinpoint-hover');
        return null;
      });
    }
  }, [isActive]);

  // Mousemove / touchstart — resolve target and update hover state
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    let prevElement: HTMLElement | null = null;

    const updateHover = (clientX: number, clientY: number, target: HTMLElement) => {
      const resolved = resolvePinpointTarget(target, container, { clientX, clientY });

      if (resolved) {
        if (resolved.element !== prevElement) {
          prevElement?.removeAttribute('data-pinpoint-hover');
          resolved.element.setAttribute('data-pinpoint-hover', '');
          prevElement = resolved.element;
          setHoverTarget({ element: resolved.element, label: resolved.label });
        }
      } else {
        if (prevElement) {
          prevElement.removeAttribute('data-pinpoint-hover');
          prevElement = null;
          setHoverTarget(null);
        }
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
      prevElement?.removeAttribute('data-pinpoint-hover');
      prevElement = null;
      setHoverTarget(null);
    };

    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });

    return () => {
      prevElement?.removeAttribute('data-pinpoint-hover');
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('touchstart', handleTouchStart);
    };
  }, [isActive, containerRef]);

  // Click — create Range and trigger web-highlighter
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    const handleClick = (e: MouseEvent) => {
      // Read highlighter at click time, not effect setup time.
      // On remount (e.g. after exiting plan diff), the highlighter init effect
      // may not have run yet when this effect sets up, but it will be ready by
      // the time the user clicks.
      const highlighter = highlighterRef.current;
      if (!highlighter) return;

      const target = e.target as HTMLElement;
      const resolved = resolvePinpointTarget(target, container, { clientX: e.clientX, clientY: e.clientY });
      if (!resolved) return;

      // Prevent link navigation in pinpoint mode
      const link = (target.closest('a') as HTMLAnchorElement | null);
      if (link && container.contains(link)) {
        e.preventDefault();
      }

      // Clear hover state
      resolved.element.removeAttribute('data-pinpoint-hover');
      setHoverTarget(null);

      if (resolved.isCodeBlock) {
        // Route to existing code block annotation path
        const codeBlockContainer = container.querySelector(`[data-block-id="${resolved.blockId}"]`) as HTMLElement;
        if (codeBlockContainer) {
          onCodeBlockClick(resolved.blockId, codeBlockContainer);
        }
        return;
      }

      // Create a text-level Range spanning the target element's content.
      // web-highlighter needs ranges anchored to text nodes, not elements.
      const range = createTextRange(resolved.element);
      if (!range) return;

      // Set browser selection so web-highlighter's mouseup handler picks it up
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      // Drive web-highlighter programmatically — fires CREATE event
      highlighter.fromRange(range);

      // Clean up browser selection
      window.getSelection()?.removeAllRanges();
    };

    // Use capture phase so we get the click before links navigate
    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [isActive, containerRef, highlighterRef, onCodeBlockClick]);

  return { hoverTarget };
}

/**
 * Create a Range anchored to text nodes (not elements).
 * web-highlighter's painter expects text-node-level ranges.
 */
function createTextRange(element: HTMLElement): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);

  let firstNode: Text | null = null;
  let lastNode: Text | null = null;

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!firstNode) firstNode = node;
    lastNode = node;
  }

  if (!firstNode || !lastNode) return null;

  const range = document.createRange();
  range.setStart(firstNode, 0);
  range.setEnd(lastNode, lastNode.length);
  return range;
}

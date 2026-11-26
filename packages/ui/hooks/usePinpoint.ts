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
import { followableLinkOf } from '../utils/followableLink';

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
 * Whether the document's selection is a drag that covers `link`: the click
 * that ends such a drag neither follows nor pins (the HTML viewer's
 * `dragEndedClick`).
 */
function dragSelectionReaches(link: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  try {
    return selection.getRangeAt(0).intersectsNode(link);
  } catch {
    return false;
  }
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

    // Cmd/Ctrl state, read from each pointer move and from the keys, and the
    // last pointer position so a key press can redraw the hover in place.
    let modifierHeld = false;
    let lastPointer: { clientX: number; clientY: number; target: HTMLElement } | null = null;

    const updateHover = (clientX: number, clientY: number, target: HTMLElement) => {
      // A followable link shows no pin outline until Cmd/Ctrl is held, so the
      // outline matches what a click will do (a plain click follows it).
      if (!modifierHeld && followableLinkOf(target)) {
        clearHover();
        return;
      }
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
      modifierHeld = e.metaKey || e.ctrlKey;
      lastPointer = { clientX: e.clientX, clientY: e.clientY, target: e.target as HTMLElement };
      updateHover(e.clientX, e.clientY, e.target as HTMLElement);
    };

    const handleModifierKey = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' && e.key !== 'Control') return;
      modifierHeld = e.metaKey || e.ctrlKey;
      if (lastPointer) updateHover(lastPointer.clientX, lastPointer.clientY, lastPointer.target);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // Touch has no modifier: a tap on a link follows it, so it gets no hover.
      modifierHeld = false;
      lastPointer = null;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
      if (target) updateHover(touch.clientX, touch.clientY, target);
    };

    const handleMouseLeave = () => {
      lastPointer = null;
      clearHover();
    };

    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('keydown', handleModifierKey);
    window.addEventListener('keyup', handleModifierKey);

    return () => {
      observer.disconnect();
      hoverElementRef.current?.removeAttribute('data-pinpoint-hover');
      hoverElementRef.current = null;
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('keydown', handleModifierKey);
      window.removeEventListener('keyup', handleModifierKey);
    };
  }, [clearHover, isActive, containerRef]);

  // Click — create Range and trigger web-highlighter
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // A `:::question` card's form controls are the answer UI, never a pin
      // target: a click on a radio, a checkbox or a text box answers.
      const inQuestion = !!target.closest?.('fieldset.question-block');
      if (inQuestion && target.closest('input, textarea, select')) return;

      // A plain click on a followable link follows it, Cmd/Ctrl-click pins it
      // (same rule as the HTML viewer, owner's ruling `html-link-click`).
      // Returning here leaves the click to the link's own handler, the same
      // path Select mode takes. The click that ends a drag over the link
      // neither follows nor pins.
      const followable = followableLinkOf(target);
      if (followable && container.contains(followable) && !e.metaKey && !e.ctrlKey) {
        clearHover();
        if (dragSelectionReaches(followable)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      const resolved = resolveSemanticTargetAtPoint(
        buildSemanticTargetGraph(container),
        target,
        { clientX: e.clientX, clientY: e.clientY },
      );
      if (!resolved) return;

      // Pinning a choice's text must not also pick the choice: the row is a
      // <label>, which would forward this click to its radio or checkbox.
      if (inQuestion && target.closest('[data-question-option]')) {
        e.preventDefault();
      }

      // A click that pins a link (Cmd/Ctrl, or one that goes nowhere) must not
      // also follow it: stop the link's own handler (linked doc, anchor) too.
      const link = (target.closest('a') as HTMLAnchorElement | null);
      if (link && container.contains(link)) {
        e.preventDefault();
        e.stopPropagation();
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

    // Use capture phase so we get the click before a link's own handler
    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [clearHover, isActive, containerRef, onCodeBlockClick, onSelectRange]);

  return { hoverTarget, clearHover };
}

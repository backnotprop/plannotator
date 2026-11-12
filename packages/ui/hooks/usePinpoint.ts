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

export interface UsePinpointOptions {
  containerRef: RefObject<HTMLElement | null>;
  inputMethod: InputMethod;
  enabled: boolean;
  onSelectRange: (range: Range) => void;
  onCodeBlockClick: (blockId: string, element: HTMLElement) => void;
}

export interface UsePinpointReturn {
  hoverTarget: SemanticTarget | null;
  clearHover: () => void;
}

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

  useEffect(() => {
    if (!isActive) {
      clearHover();
    }
  }, [clearHover, isActive]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const inQuestion = !!target.closest?.('fieldset.question-block');
      if (inQuestion && target.closest('input, textarea, select')) return;
      const resolved = resolveSemanticTargetAtPoint(
        buildSemanticTargetGraph(container),
        target,
        { clientX: e.clientX, clientY: e.clientY },
      );
      if (!resolved) return;

      if (inQuestion && target.closest('[data-question-option]')) {
        e.preventDefault();
      }

      const link = (target.closest('a') as HTMLAnchorElement | null);
      if (link && container.contains(link)) {
        e.preventDefault();
      }

      resolved.element.removeAttribute('data-pinpoint-hover');
      setHoverTarget(null);

      if (resolved.kind === 'code') {
        const codeBlockContainer = container.querySelector(`[data-block-id="${resolved.blockId}"]`) as HTMLElement;
        if (codeBlockContainer) {
          onCodeBlockClick(resolved.blockId, codeBlockContainer);
        }
        return;
      }

      const range = createSemanticTargetRange(resolved);
      if (!range) return;

      onSelectRange(range);
    };

    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [isActive, containerRef, onCodeBlockClick, onSelectRange]);

  return { hoverTarget, clearHover };
}

import { useEffect, useRef, useCallback } from 'react';
import type { InputMethod } from '../types';

const DOUBLE_TAP_WINDOW = 300;
const HOLD_THRESHOLD = 300;

export function useInputMethodSwitch(
  inputMethod: InputMethod,
  onChange: (method: InputMethod) => void,
) {
  const stateRef = useRef<'idle' | 'held' | 'tapped'>('idle');
  const downTimestampRef = useRef(0);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const originalMethodRef = useRef<InputMethod>(inputMethod);

  useEffect(() => {
    if (stateRef.current === 'idle') {
      originalMethodRef.current = inputMethod;
    }
  }, [inputMethod]);

  const otherMethod = useCallback(
    (m: InputMethod): InputMethod => (m === 'drag' ? 'pinpoint' : 'drag'),
    [],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || e.repeat) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (document.querySelector('[data-quick-label-picker]')) return;

      if (stateRef.current === 'idle') {
        originalMethodRef.current = inputMethod;
        downTimestampRef.current = Date.now();
        stateRef.current = 'held';
        onChange(otherMethod(inputMethod));
      } else if (stateRef.current === 'tapped') {
        clearTimeout(revertTimerRef.current);
        stateRef.current = 'idle';
        originalMethodRef.current = otherMethod(originalMethodRef.current);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;

      if (stateRef.current === 'held') {
        const holdDuration = Date.now() - downTimestampRef.current;

        if (holdDuration >= HOLD_THRESHOLD) {
          onChange(originalMethodRef.current);
          stateRef.current = 'idle';
        } else {
          stateRef.current = 'tapped';
          revertTimerRef.current = setTimeout(() => {
            if (stateRef.current === 'tapped') {
              onChange(originalMethodRef.current);
              stateRef.current = 'idle';
            }
          }, DOUBLE_TAP_WINDOW);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      clearTimeout(revertTimerRef.current);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [inputMethod, onChange, otherMethod]);
}

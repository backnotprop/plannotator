import { useEffect, useRef, useCallback } from 'react';
import type { InputMethod } from '../types';

const DOUBLE_TAP_WINDOW = 300; // ms — max gap between taps for double-tap
const HOLD_THRESHOLD = 300;    // ms — hold longer than this = temporary switch

/**
 * Alt/Option key to switch between input methods:
 * - Hold Alt: temporarily switch, reverts on release
 * - Double-tap Alt: permanently toggle
 */
export function useInputMethodSwitch(
  inputMethod: InputMethod,
  onChange: (method: InputMethod) => void,
) {
  const stateRef = useRef<'idle' | 'held' | 'tapped'>('idle');
  const downTimestampRef = useRef(0);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const originalMethodRef = useRef<InputMethod>(inputMethod);

  // Keep originalMethod in sync when user changes it via UI
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
      // Don't interfere when user is typing
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      // Don't interfere when a quick label picker is open (it uses Alt+N shortcuts)
      if (document.querySelector('[data-quick-label-picker]')) return;

      if (stateRef.current === 'idle') {
        // First press — switch immediately
        originalMethodRef.current = inputMethod;
        downTimestampRef.current = Date.now();
        stateRef.current = 'held';
        onChange(otherMethod(inputMethod));
      } else if (stateRef.current === 'tapped') {
        // Second press within window — make it permanent
        clearTimeout(revertTimerRef.current);
        stateRef.current = 'idle';
        // Already switched from first tap, just persist it
        originalMethodRef.current = otherMethod(originalMethodRef.current);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;

      if (stateRef.current === 'held') {
        const holdDuration = Date.now() - downTimestampRef.current;

        if (holdDuration >= HOLD_THRESHOLD) {
          // Long hold — revert immediately
          onChange(originalMethodRef.current);
          stateRef.current = 'idle';
        } else {
          // Short tap — wait for possible second tap
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

import { useRef } from 'react';
import type React from 'react';
import { isImeCompositionKey } from '@plannotator/ui/utils/commentSubmitKey';

export function useImeCancelHold() {
  const at = useRef(-Infinity);
  return {
    onKeyDownCapture: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && isImeCompositionKey(event)) at.current = event.timeStamp;
    },
    held: (event: React.SyntheticEvent) => event.timeStamp - at.current < 100,
  };
}

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { type QuickLabel, getQuickLabels } from '../utils/quickLabels';
import { QuickLabelDropdown } from './QuickLabelDropdown';

interface FloatingQuickLabelPickerProps {
  anchorEl: HTMLElement;
  /** Mouse coordinates at the moment of selection — picker appears here */
  cursorHint?: { x: number; y: number };
  onSelect: (label: QuickLabel) => void;
  onDismiss: () => void;
}

const PICKER_WIDTH = 192;
const GAP = 6;
const VIEWPORT_PADDING = 12;

function computePosition(
  anchorEl: HTMLElement,
  cursorHint?: { x: number; y: number },
): { top: number; left: number; flipAbove: boolean } {
  const rect = anchorEl.getBoundingClientRect();

  // Vertical: use anchor rect for above/below decision + placement
  const spaceBelow = window.innerHeight - rect.bottom;
  const flipAbove = spaceBelow < 220;
  const top = flipAbove ? rect.top - GAP : rect.bottom + GAP;

  // Horizontal: prefer cursor x, fallback to anchor right edge
  let left: number;
  if (cursorHint) {
    // Anchor left edge of picker at cursor x, nudge left slightly so
    // the first row's text is directly under the pointer
    left = cursorHint.x - 28;
  } else {
    // Fallback: right edge of anchor (where selection likely ended)
    left = rect.right - PICKER_WIDTH / 2;
  }

  // Clamp to viewport
  left = Math.max(VIEWPORT_PADDING, Math.min(left, window.innerWidth - PICKER_WIDTH - VIEWPORT_PADDING));

  return { top, left, flipAbove };
}

export const FloatingQuickLabelPicker: React.FC<FloatingQuickLabelPickerProps> = ({
  anchorEl,
  cursorHint,
  onSelect,
  onDismiss,
}) => {
  const [position, setPosition] = useState<{ top: number; left: number; flipAbove: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const quickLabels = useMemo(() => getQuickLabels(), []);

  // Position tracking
  useEffect(() => {
    const update = () => setPosition(computePosition(anchorEl, cursorHint));
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl, cursorHint]);

  // Keyboard: 1-9/0 or Alt+1-9/0 to apply label, Escape to dismiss
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }
      // Accept bare digit or Alt+digit — picker is open so digits mean labels
      const isDigit = (e.code >= 'Digit1' && e.code <= 'Digit9') || e.code === 'Digit0';
      if (isDigit && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const digit = parseInt(e.code.slice(5), 10);
        const index = digit === 0 ? 9 : digit - 1;
        if (index < quickLabels.length) {
          onSelect(quickLabels[index]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss, onSelect, quickLabels]);

  // Click outside to dismiss
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Defer to avoid catching the triggering click
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onDismiss]);

  if (!position) return null;

  const animName = position.flipAbove ? 'qlp-in-above' : 'qlp-in-below';

  return createPortal(
    <div
      ref={ref}
      data-quick-label-picker
      data-floating-picker="true"
      className="fixed z-[100]"
      style={{
        top: position.top,
        left: position.left,
        width: PICKER_WIDTH,
        ...(position.flipAbove ? { transform: 'translateY(-100%)' } : {}),
        animation: `${animName} 0.12s ease-out`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes qlp-in-below {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes qlp-in-above {
          from { opacity: 0; transform: translateY(-100%) translateY(4px); }
          to   { opacity: 1; transform: translateY(-100%); }
        }
      `}</style>

      <div className="bg-popover border border-border/60 rounded-lg shadow-xl overflow-hidden">
        <QuickLabelDropdown labels={quickLabels} onSelect={onSelect} animate />
      </div>
    </div>,
    document.body
  );
};

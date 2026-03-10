import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { type QuickLabel, getQuickLabels } from '../utils/quickLabels';
import { QuickLabelDropdown } from './QuickLabelDropdown';

interface FloatingQuickLabelPickerProps {
  anchorEl: HTMLElement;
  onSelect: (label: QuickLabel) => void;
  onDismiss: () => void;
}

export const FloatingQuickLabelPicker: React.FC<FloatingQuickLabelPickerProps> = ({
  anchorEl,
  onSelect,
  onDismiss,
}) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const quickLabels = useMemo(() => getQuickLabels(), []);

  // Position tracking
  useEffect(() => {
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      const dropdownHeight = 120; // approximate
      const gap = 8;

      const hasSpaceAbove = rect.top > dropdownHeight + gap;
      const top = hasSpaceAbove
        ? rect.top - gap
        : rect.bottom + gap;

      setPosition({
        top,
        left: rect.left + rect.width / 2,
      });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [anchorEl]);

  // Keyboard: Alt+1..8 and Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.altKey && e.code >= 'Digit1' && e.code <= 'Digit8') {
        e.preventDefault();
        const index = parseInt(e.code.slice(5), 10) - 1;
        if (index < quickLabels.length) {
          onSelect(quickLabels[index]);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss, onSelect, quickLabels]);

  // Click outside to dismiss
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };

    // Use setTimeout to avoid dismissing from the same click that triggered the picker
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onDismiss]);

  if (!position) return null;

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] bg-popover border border-border rounded-lg shadow-2xl p-2 min-w-[220px]"
      style={{
        top: position.top,
        left: position.left,
        transform: 'translate(-50%, -100%)',
        animation: 'floating-picker-in 0.15s ease-out',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <style>{`
        @keyframes floating-picker-in {
          from { opacity: 0; transform: translate(-50%, -100%) translateY(8px); }
          to { opacity: 1; transform: translate(-50%, -100%) translateY(0); }
        }
      `}</style>
      <QuickLabelDropdown labels={quickLabels} onSelect={onSelect} />
    </div>,
    document.body
  );
};

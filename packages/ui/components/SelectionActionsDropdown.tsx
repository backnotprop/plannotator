import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SelectionAction } from '../utils/selectionActions';

/**
 * The host-actions dropdown: the same context-menu shape `QuickLabelDropdown`
 * draws (single column, accent bar, full-width rows) and the same floating
 * placement `FloatingQuickLabelPicker` computes, opened directly below the
 * toolbar's wand button.
 *
 * Keyboard here is arrows + Enter + Escape rather than the quick labels'
 * digit keys: a host's list is not a fixed ten with memorized numbers.
 * Nothing is preselected until the first arrow, so a stray Enter while the
 * dropdown is open never invokes a host command.
 */

const PICKER_WIDTH = 224;
const GAP = 6;
const VIEWPORT_PADDING = 12;
/** Room the dropdown wants below the anchor before it flips above. */
const FLIP_THRESHOLD = 220;

function computePosition(anchorEl: HTMLElement): { top: number; left: number; flipAbove: boolean } {
  const rect = anchorEl.getBoundingClientRect();
  const flipAbove = window.innerHeight - rect.bottom < FLIP_THRESHOLD;
  const top = flipAbove ? rect.top - GAP : rect.bottom + GAP;
  let left = rect.left + rect.width / 2 - PICKER_WIDTH / 2;
  left = Math.max(
    VIEWPORT_PADDING,
    Math.min(left, window.innerWidth - PICKER_WIDTH - VIEWPORT_PADDING),
  );
  return { top, left, flipAbove };
}

export const SelectionActionsDropdown: React.FC<{
  actions: SelectionAction[];
  activeIndex: number | null;
  onSelect: (action: SelectionAction) => void;
  onHover: (index: number) => void;
}> = ({ actions, activeIndex, onSelect, onHover }) => (
  <div className="py-1" onMouseDown={(e) => e.stopPropagation()}>
    {actions.map((action, index) => (
      <button
        key={action.id}
        type="button"
        role="option"
        aria-selected={activeIndex === index}
        data-selection-action={action.id}
        onClick={() => onSelect(action)}
        onMouseEnter={() => onHover(index)}
        className={`group w-full flex items-center gap-2 px-2 py-[5px] text-left transition-colors ${
          activeIndex === index ? 'bg-muted' : 'hover:bg-muted/60 active:bg-muted'
        }`}
      >
        {action.icon ? (
          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground">
            {action.icon}
          </span>
        ) : (
          <span className="w-[3px] self-stretch rounded-full flex-shrink-0 bg-primary/70" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] leading-tight text-foreground/85 group-hover:text-foreground truncate">
            {action.label}
          </span>
          {action.detail && (
            <span className="block text-[9px] leading-tight text-muted-foreground/70 truncate">
              {action.detail}
            </span>
          )}
        </span>
      </button>
    ))}
  </div>
);

export const FloatingSelectionActionsPicker: React.FC<{
  anchorEl: HTMLElement;
  actions: SelectionAction[];
  onSelect: (action: SelectionAction) => void;
  onDismiss: () => void;
}> = ({ anchorEl, actions, onSelect, onDismiss }) => {
  const [position, setPosition] = useState<{ top: number; left: number; flipAbove: boolean } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => setPosition(computePosition(anchorEl));
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => {
          if (actions.length === 0) return null;
          if (prev === null) return e.key === 'ArrowDown' ? 0 : actions.length - 1;
          return e.key === 'ArrowDown'
            ? (prev + 1) % actions.length
            : (prev - 1 + actions.length) % actions.length;
        });
        return;
      }
      if (e.key === 'Enter') {
        // Nothing preselected: Enter before the first arrow is not aimed here.
        if (activeIndex === null) return;
        e.preventDefault();
        const action = actions[activeIndex];
        if (action) onSelect(action);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [actions, activeIndex, onDismiss, onSelect]);

  // Click outside dismisses. Deferred capture-phase registration, so the click
  // that opened the dropdown does not immediately close it.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onDismiss]);

  if (!position) return null;

  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label="Actions"
      data-selection-actions-picker
      data-floating-picker="true"
      className="fixed z-[100]"
      style={{
        top: position.top,
        left: position.left,
        width: PICKER_WIDTH,
        ...(position.flipAbove ? { transform: 'translateY(-100%)' } : {}),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bg-popover border border-border/60 rounded-lg shadow-xl overflow-hidden">
        <SelectionActionsDropdown
          actions={actions}
          activeIndex={activeIndex}
          onSelect={onSelect}
          onHover={setActiveIndex}
        />
      </div>
    </div>,
    document.body,
  );
};

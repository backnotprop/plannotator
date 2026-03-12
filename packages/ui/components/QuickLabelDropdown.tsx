import React from 'react';
import { type QuickLabel, getLabelColors } from '../utils/quickLabels';

/**
 * Shared vertical label list used by both FloatingQuickLabelPicker
 * and the AnnotationToolbar's inline dropdown.
 *
 * Context-menu style: single column, colored accent bars, full-width rows.
 */
export const QuickLabelDropdown: React.FC<{
  labels: QuickLabel[];
  onSelect: (label: QuickLabel) => void;
  /** Enable staggered row entrance animation */
  animate?: boolean;
}> = ({ labels, onSelect, animate = false }) => {
  return (
    <div className="py-1" onMouseDown={(e) => e.stopPropagation()}>
      {animate && (
        <style>{`
          @keyframes qld-row-in {
            from { opacity: 0; transform: translateX(-3px); }
            to   { opacity: 1; transform: translateX(0); }
          }
        `}</style>
      )}
      {labels.map((label, index) => {
        const colors = getLabelColors(label.color);
        return (
          <button
            key={label.id}
            onClick={() => onSelect(label)}
            className="group w-full flex items-center gap-2 px-2 py-[5px] text-left transition-colors hover:bg-muted/60 active:bg-muted"
            style={animate ? {
              animationDelay: `${index * 18}ms`,
              animationName: 'qld-row-in',
              animationDuration: '0.1s',
              animationFillMode: 'both',
              animationTimingFunction: 'ease-out',
            } : undefined}
          >
            {/* Color accent bar */}
            <span
              className="w-[3px] self-stretch rounded-full flex-shrink-0"
              style={{ backgroundColor: colors.text }}
            />
            {/* Emoji */}
            <span className="text-xs leading-none flex-shrink-0">{label.emoji}</span>
            {/* Label text */}
            <span className="text-[11px] leading-tight text-foreground/85 group-hover:text-foreground truncate flex-1">
              {label.text}
            </span>
            {/* Shortcut hint */}
            {index < 10 && (
              <span className="text-[9px] tabular-nums text-muted-foreground/40 group-hover:text-muted-foreground/60 flex-shrink-0 font-mono">
                {index === 9 ? '0' : index + 1}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

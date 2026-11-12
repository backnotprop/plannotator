import React from 'react';
import { type QuickLabel, getLabelColors, quickLabelShortcutDigit } from '../utils/quickLabels';

export const QuickLabelDropdown: React.FC<{
  labels: QuickLabel[];
  onSelect: (label: QuickLabel) => void;
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
        const digit = quickLabelShortcutDigit(index);
        return (
          <button
            key={index}
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
            <span
              className="w-[3px] self-stretch rounded-full flex-shrink-0"
              style={{ backgroundColor: colors.text }}
            />
            <span className="text-xs leading-none flex-shrink-0">{label.emoji}</span>
            <span className="text-[11px] leading-tight text-foreground/85 group-hover:text-foreground truncate flex-1">
              {label.text}
            </span>
            {digit && (
              <span className="text-[9px] tabular-nums text-muted-foreground/40 group-hover:text-muted-foreground/60 flex-shrink-0 font-mono">
                {digit}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

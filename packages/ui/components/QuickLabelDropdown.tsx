import React from 'react';
import { type QuickLabel, getLabelColors } from '../utils/quickLabels';

export const QuickLabelDropdown: React.FC<{
  labels: QuickLabel[];
  onSelect: (label: QuickLabel) => void;
}> = ({ labels, onSelect }) => {
  const isMac = navigator.platform?.includes('Mac');
  const altKey = isMac ? '⌥' : 'Alt+';

  return (
    <div onMouseDown={(e) => e.stopPropagation()}>
      <div className="text-[10px] text-muted-foreground/60 px-1 mb-1.5 font-medium uppercase tracking-wide">Quick Labels</div>
      <div className="flex flex-wrap gap-1">
        {labels.map((label, index) => {
          const colors = getLabelColors(label.color);
          return (
            <button
              key={label.id}
              onClick={() => onSelect(label)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-opacity hover:opacity-75 active:opacity-60"
              style={{ backgroundColor: colors.bg, color: colors.text }}
              title={index < 8 ? `${altKey}${index + 1}` : undefined}
            >
              <span>{label.emoji}</span>
              <span>{label.text}</span>
              {index < 8 && (
                <span className="text-[9px] opacity-40 ml-0.5">{index + 1}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

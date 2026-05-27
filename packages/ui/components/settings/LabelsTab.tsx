import React, { useState } from 'react';
import {
  type QuickLabel,
  getQuickLabels,
  saveQuickLabels,
  resetQuickLabels,
  DEFAULT_QUICK_LABELS,
  getLabelColors,
  LABEL_COLOR_MAP,
} from '../../utils/quickLabels';
import { isMac, altKey } from '../../utils/platform';

export const LabelsTab: React.FC = () => {
  const [labels, setLabels] = useState<QuickLabel[]>(() => getQuickLabels());
  const [editingTipIndex, setEditingTipIndex] = useState<number | null>(null);
  const [editingTipValue, setEditingTipValue] = useState('');

  const updateLabels = (updated: QuickLabel[]) => {
    setLabels(updated);
    saveQuickLabels(updated);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Quick Labels</div>
          <div className="text-xs text-muted-foreground">
            Preset annotations for one-click feedback
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            resetQuickLabels();
            setLabels(DEFAULT_QUICK_LABELS);
          }}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          Reset to defaults
        </button>
      </div>

      <style>{`
        @keyframes tip-slide-open {
          from { max-height: 0; opacity: 0; }
          to   { max-height: 60px; opacity: 1; }
        }
      `}</style>

      <div className="space-y-1.5">
        {labels.map((label, index) => {
          const colors = getLabelColors(label.color);
          const hasTip = !!label.tip;
          const isEditingTip = editingTipIndex === index;
          return (
            <div key={index} className="rounded-lg overflow-hidden" style={{ backgroundColor: colors.bg }}>
              <div className="flex items-center gap-2 p-2">
                <span className="text-sm flex-shrink-0">{label.emoji}</span>
                <input
                  type="text"
                  value={label.text}
                  onChange={(e) => {
                    const updated = [...labels];
                    updated[index] = {
                      ...label,
                      text: e.target.value,
                      id: e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
                    };
                    updateLabels(updated);
                  }}
                  className="flex-1 px-2 py-1 bg-background/80 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (isEditingTip) {
                      setEditingTipIndex(null);
                    } else {
                      setEditingTipIndex(index);
                      setEditingTipValue(label.tip || '');
                    }
                  }}
                  className={`relative p-1 rounded flex-shrink-0 ${
                    hasTip
                      ? 'bg-foreground/10 text-foreground/70 hover:text-foreground border border-foreground/15'
                      : 'text-muted-foreground/30 hover:text-muted-foreground/60 border border-dashed border-muted-foreground/20 hover:border-muted-foreground/40'
                  }`}
                  title={hasTip ? `Tip: ${label.tip}` : 'Add AI instruction tip'}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  {hasTip && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-foreground/50" />}
                </button>
                <select
                  value={label.color}
                  onChange={(e) => {
                    const updated = [...labels];
                    updated[index] = { ...label, color: e.target.value };
                    updateLabels(updated);
                  }}
                  className="px-1.5 py-1 bg-background/80 rounded text-[10px] focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  {Object.keys(LABEL_COLOR_MAP).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <span className="text-[10px] text-muted-foreground font-mono w-8 text-center flex-shrink-0">
                  {index < 10 ? `${altKey}${isMac ? '' : '+'}${index === 9 ? '0' : index + 1}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    updateLabels(labels.filter((_, i) => i !== index));
                    if (editingTipIndex === index) setEditingTipIndex(null);
                  }}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex-shrink-0"
                  title="Remove label"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {isEditingTip && (
                <div className="flex items-center gap-1.5 px-2 pb-2 pt-0" style={{ animation: 'tip-slide-open 0.15s ease-out' }}>
                  <svg className="w-3 h-3 text-muted-foreground/40 flex-shrink-0 ml-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                  <input
                    type="text"
                    value={editingTipValue}
                    onChange={(e) => setEditingTipValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const updated = [...labels];
                        updated[index] = { ...label, tip: editingTipValue || undefined };
                        updateLabels(updated);
                        setEditingTipIndex(null);
                      }
                      if (e.key === 'Escape') setEditingTipIndex(null);
                    }}
                    placeholder="AI instruction tip…"
                    className="flex-1 px-2 py-1 bg-background/60 rounded text-[10px] text-muted-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    autoFocus
                    onFocus={(e) => { e.target.setSelectionRange(0, 0); e.target.scrollLeft = 0; }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const updated = [...labels];
                      updated[index] = { ...label, tip: editingTipValue || undefined };
                      updateLabels(updated);
                      setEditingTipIndex(null);
                    }}
                    className="p-1 rounded text-muted-foreground hover:text-green-500 hover:bg-green-500/10 flex-shrink-0"
                    title="Save tip"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {labels.length < 12 && (
        <button
          type="button"
          onClick={() => {
            updateLabels([...labels, { id: `custom-${Date.now()}`, emoji: '📌', text: 'New label', color: 'blue' }]);
          }}
          className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg hover:border-foreground/30"
        >
          + Add label
        </button>
      )}

      <div className="text-[10px] text-muted-foreground">
        Use {altKey}{isMac ? '' : '+'}1 through {altKey}{isMac ? '' : '+'}0 to apply a label instantly.
      </div>
    </div>
  );
};

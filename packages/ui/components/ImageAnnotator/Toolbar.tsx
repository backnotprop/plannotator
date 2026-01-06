import React from 'react';
import type { Tool } from './types';
import { COLORS } from './types';

interface ToolbarProps {
  tool: Tool;
  color: string;
  strokeSize: number;
  canUndo: boolean;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onStrokeSizeChange: (size: number) => void;
  onUndo: () => void;
  onClear: () => void;
  onSave: () => void;
}

const PenIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
);

const ArrowIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);

const CircleIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="10" />
  </svg>
);

const UndoIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
  </svg>
);

const ClearIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const MinusIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M5 12h14" />
  </svg>
);

const PlusIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const TOOLS: { id: Tool; icon: React.FC; label: string }[] = [
  { id: 'pen', icon: PenIcon, label: 'Pen (1)' },
  { id: 'arrow', icon: ArrowIcon, label: 'Arrow (2)' },
  { id: 'circle', icon: CircleIcon, label: 'Circle (3)' },
];

const STROKE_SIZES = [3, 6, 10, 16, 24];

export const Toolbar: React.FC<ToolbarProps> = ({
  tool,
  color,
  strokeSize,
  canUndo,
  onToolChange,
  onColorChange,
  onStrokeSizeChange,
  onUndo,
  onClear,
  onSave,
}) => {
  const currentSizeIndex = STROKE_SIZES.indexOf(strokeSize);
  const canDecrease = currentSizeIndex > 0;
  const canIncrease = currentSizeIndex < STROKE_SIZES.length - 1;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl">
      {/* Tools */}
      <div className="flex items-center gap-1">
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onToolChange(id)}
            title={label}
            className={`p-1.5 rounded transition-colors ${
              tool === id
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon />
          </button>
        ))}
      </div>

      <div className="w-px h-5 bg-border" />

      {/* Stroke size */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => canDecrease && onStrokeSizeChange(STROKE_SIZES[currentSizeIndex - 1])}
          disabled={!canDecrease}
          title="Smaller stroke"
          className={`p-1 rounded transition-colors ${
            canDecrease
              ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
              : 'text-muted-foreground/30 cursor-not-allowed'
          }`}
        >
          <MinusIcon />
        </button>
        <div
          className="w-5 h-5 flex items-center justify-center"
          title={`Stroke size: ${strokeSize}`}
        >
          <div
            className="rounded-full"
            style={{
              width: Math.min(strokeSize + 2, 16),
              height: Math.min(strokeSize + 2, 16),
              backgroundColor: color,
            }}
          />
        </div>
        <button
          type="button"
          onClick={() => canIncrease && onStrokeSizeChange(STROKE_SIZES[currentSizeIndex + 1])}
          disabled={!canIncrease}
          title="Larger stroke"
          className={`p-1 rounded transition-colors ${
            canIncrease
              ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
              : 'text-muted-foreground/30 cursor-not-allowed'
          }`}
        >
          <PlusIcon />
        </button>
      </div>

      <div className="w-px h-5 bg-border" />

      {/* Colors */}
      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onColorChange(c)}
            className={`w-5 h-5 rounded-full border-2 transition-transform ${
              color === c ? 'scale-110 border-foreground' : 'border-transparent hover:scale-105'
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      <div className="w-px h-5 bg-border" />

      {/* Undo */}
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Cmd+Z)"
        className={`p-1.5 rounded transition-colors ${
          canUndo
            ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
            : 'text-muted-foreground/30 cursor-not-allowed'
        }`}
      >
        <UndoIcon />
      </button>

      {/* Clear all */}
      <button
        type="button"
        onClick={onClear}
        title="Clear all"
        className="p-1.5 rounded transition-colors hover:bg-muted text-muted-foreground hover:text-destructive"
      >
        <ClearIcon />
      </button>

      <div className="w-px h-5 bg-border" />

      {/* Save */}
      <button
        type="button"
        onClick={onSave}
        title="Save (Esc)"
        className="p-1.5 rounded transition-colors bg-green-600 text-white hover:bg-green-500"
      >
        <CheckIcon />
      </button>
    </div>
  );
};

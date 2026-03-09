import React from 'react';
import type { ResizeHandleProps as BaseProps } from '../hooks/useResizablePanel';

interface Props extends BaseProps {
  className?: string;
}

export const ResizeHandle: React.FC<Props> = ({
  isDragging,
  onMouseDown,
  onTouchStart,
  onDoubleClick,
  className,
}) => (
  <div
    className={`relative w-1 cursor-col-resize flex-shrink-0 group${className ? ` ${className}` : ''}`}
  >
    {/* Visible track */}
    <div className={`absolute inset-y-0 inset-x-0 transition-colors ${
      isDragging ? 'bg-primary/50' : 'group-hover:bg-border'
    }`} />
    {/* Wider touch area */}
    <div
      className="absolute inset-y-0 -inset-x-2"
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onDoubleClick={onDoubleClick}
    />
  </div>
);

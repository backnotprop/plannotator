import React, { useRef } from 'react';
import { clampRatio } from './paneLayout';

export const PaneDivider: React.FC<{
  ratio: number;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  container: () => HTMLElement | null;
}> = ({ ratio, onChange, onCommit, container }) => {
  const dragging = useRef(false);

  const ratioAt = (clientX: number) => {
    const box = container()?.getBoundingClientRect();
    if (!box || box.width === 0) return ratio;
    return clampRatio((clientX - box.left) / box.width);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the two panes"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      data-pane-divider=""
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (dragging.current) onChange(ratioAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        onCommit(ratioAt(event.clientX));
      }}
      onDoubleClick={() => onCommit(0.5)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.1 : 0.02;
        if (event.key === 'ArrowLeft') onCommit(clampRatio(ratio - step));
        else if (event.key === 'ArrowRight') onCommit(clampRatio(ratio + step));
        else if (event.key === 'Home') onCommit(0.2);
        else if (event.key === 'End') onCommit(0.8);
        else return;
        event.preventDefault();
      }}
      className="group relative z-10 w-px flex-none cursor-col-resize bg-border focus-visible:outline-none"
    >
      <span aria-hidden="true" className="absolute inset-y-0 -left-1 -right-1" />
      <span aria-hidden="true" className="absolute inset-y-0 -left-px w-[3px] bg-primary/50 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
};

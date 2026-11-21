import { ResizeHandle } from "../ResizeHandle";
import type { useResizablePanel } from "../../hooks/useResizablePanel";

import { CollapsibleEdge, type EdgeKeyboardResize } from "./CollapsibleEdge";

function noop(): void {}

export function PanelEdge({
  resize,
  side,
  onCollapse,
  label,
  className,
  keyboard,
}: {
  resize: Pick<ReturnType<typeof useResizablePanel>, "isDragging" | "handleProps">;
  side: "left" | "right";
  onCollapse: () => void;
  label: string;
  className?: string;
  /** Arrow keys, Home and End resize the panel; without it the keyboard only collapses it (Enter). */
  keyboard?: EdgeKeyboardResize;
}) {
  return (
    <CollapsibleEdge
      onCollapse={onCollapse}
      label={label}
      isDragging={resize.isDragging}
      resize={keyboard}
      className={className}
    >
      <ResizeHandle {...resize.handleProps} side={side} onDoubleClick={noop} hideHoverTrack />
    </CollapsibleEdge>
  );
}

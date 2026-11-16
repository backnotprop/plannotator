import { ResizeHandle } from "../ResizeHandle";
import type { useResizablePanel } from "../../hooks/useResizablePanel";

import { CollapsibleEdge } from "./CollapsibleEdge";

function noop(): void {}

export function PanelEdge({
  resize,
  side,
  onCollapse,
  label,
  className,
}: {
  resize: Pick<ReturnType<typeof useResizablePanel>, "isDragging" | "handleProps">;
  side: "left" | "right";
  onCollapse: () => void;
  label: string;
  className?: string;
}) {
  return (
    <CollapsibleEdge
      onCollapse={onCollapse}
      label={label}
      isDragging={resize.isDragging}
      className={className}
    >
      <ResizeHandle {...resize.handleProps} side={side} onDoubleClick={noop} hideHoverTrack />
    </CollapsibleEdge>
  );
}

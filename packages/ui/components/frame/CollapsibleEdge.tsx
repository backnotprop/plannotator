import type { KeyboardEvent, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/tooltip";
import { cn } from "./lib/utils";

export interface EdgeKeyboardResize {
  value: number;
  min: number;
  max: number;
  resizeTo: (px: number) => void;
  side: "left" | "right";
}

const KEYBOARD_STEP = 10;

export function CollapsibleEdge({
  onCollapse,
  label,
  isDragging,
  resize,
  className,
  children,
}: {
  onCollapse: () => void;
  label: string;
  isDragging: boolean;
  resize?: EdgeKeyboardResize;
  className?: string;
  children: ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onCollapse();
      return;
    }
    if (!resize) return;
    const grow = resize.side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = resize.side === "left" ? "ArrowLeft" : "ArrowRight";
    let target: number | undefined;
    if (e.key === grow) target = resize.value + KEYBOARD_STEP;
    else if (e.key === shrink) target = resize.value - KEYBOARD_STEP;
    else if (e.key === "Home") target = resize.min;
    else if (e.key === "End") target = resize.max;
    if (target === undefined) return;
    e.preventDefault();
    resize.resizeTo(target);
  };

  const semantics = resize
    ? ({
        role: "separator",
        "aria-orientation": "vertical",
        "aria-valuenow": Math.round(resize.value),
        "aria-valuetext": `${Math.round(resize.value)} pixels wide`,
        "aria-valuemin": resize.min,
        "aria-valuemax": resize.max,
      } as const)
    : ({ role: "button" } as const);

  return (
    <Tooltip trackCursorAxis="both" delay={300}>
      <TooltipTrigger
        render={
          <div
            {...semantics}
            tabIndex={0}
            aria-label={label}
            onKeyDown={onKeyDown}
            className={cn(
              "collapsible-edge relative flex w-0 flex-shrink-0 outline-none",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      {!isDragging && (
        <TooltipContent
          side="bottom"
          sideOffset={14}
          data-frame-motion="fade"
          className="text-frame-muted-fg"
        >
          Click to collapse, drag to resize
        </TooltipContent>
      )}
    </Tooltip>
  );
}

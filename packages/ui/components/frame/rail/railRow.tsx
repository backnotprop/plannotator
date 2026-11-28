import { ChevronDown, ChevronRight, Plus } from "lucide-react";

import { FOCUS_RING, HOVER_QUIET } from "../lib/recipes";
import { cn } from "../lib/utils";

export const RAIL_ROW = cn(
  "flex h-frame-row w-full items-center gap-1.5 rounded-frame-selection px-2 text-frame-sm font-normal text-frame-muted-fg transition-colors hover:text-foreground",
  HOVER_QUIET,
  FOCUS_RING,
);

export const RAIL_SUB_ROW = "flex h-7 items-center gap-1.5 rounded-frame-selection pl-[26px]";

export const RAIL_ADD_ROW = cn(
  RAIL_SUB_ROW,
  "w-full pr-2 text-frame-xs text-frame-tertiary transition-colors hover:text-foreground",
  HOVER_QUIET,
  FOCUS_RING,
);

export function RailAddRowLabel({ children }: { children: string }) {
  return (
    <>
      <Plus className="size-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </>
  );
}

export const RAIL_HINT = "py-0.5 pl-[26px] pr-2 text-frame-2xs text-frame-tertiary";

export function RailTerminal({
  count,
  expanded,
}: {
  count: number | "loading" | "unavailable" | { summary: string };
  expanded: boolean;
}) {
  const summary = typeof count === "object" ? count.summary : null;
  return (
    <span
      className={cn(
        "grid shrink-0 items-center justify-items-end gap-[3px]",
        summary === null ? "min-w-[37px] grid-cols-[22px_12px]" : "grid-cols-[auto_12px]",
      )}
      data-plan-rail-terminal
    >
      <span
        aria-label={
          count === "loading"
            ? "Count is loading"
            : count === "unavailable"
              ? "Count is unavailable"
              : undefined
        }
        className={cn(
          "text-right text-frame-2xs text-frame-tertiary",
          summary === null ? "tabular-nums" : "whitespace-nowrap",
        )}
        data-plan-rail-terminal-count
      >
        {summary ?? (typeof count === "number" ? count : "…")}
      </span>
      <span
        className="grid size-3 place-items-center text-frame-tertiary"
        data-plan-rail-terminal-chevron={expanded ? "down" : "right"}
      >
        {expanded ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
      </span>
    </span>
  );
}

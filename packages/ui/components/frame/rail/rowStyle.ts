import { FOCUS_RING, HOVER_QUIET } from "../lib/recipes";
import { cn } from "../lib/utils";

export const INDENT = 14;
export const pad = (depth: number) => ({ paddingLeft: `${8 + depth * INDENT}px` });

export const SIDEBAR_COLLECTION_NAME_TEXT = "font-normal";

export const ROW =
  "group/row flex h-frame-row w-full items-center gap-1.5 rounded-frame-selection pr-2 text-left text-frame-sm " +
  "text-frame-muted-fg transition-colors hover:text-foreground " +
  `${HOVER_QUIET} ${FOCUS_RING} ` +
  "[content-visibility:auto] [contain-intrinsic-size:auto_28px] " +
  "[[data-mobile=true]_&]:h-11";

export const FIELD_ROW = cn(ROW, "relative z-1 [content-visibility:visible]");

export const FIELD_IN_ROW = "h-frame-row min-w-0 flex-1 px-1.5 py-0";

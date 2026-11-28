import { cloneElement, type ReactElement, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { Skeleton } from "../primitives/skeleton";
import { RAIL_ROW } from "./railRow";

export function PagesRailHead({
  label,
  backLink,
  meta = null,
}: {
  readonly label: string | null;
  readonly backLink: ReactElement;
  /** A quiet second line under the back link, aligned with its label (a glyph and words; bring a title for long ones). */
  readonly meta?: ReactNode;
}) {
  return (
    <div className="mx-2 border-b border-frame-border-subtle py-1" data-pages-rail-head="">
      {label === null ? (
        <Skeleton className="my-1 h-frame-row w-3/4" />
      ) : (
        cloneElement(backLink, {
          className: RAIL_ROW,
          "data-pages-back-link": "",
          "aria-label": `Back to ${label}`,
          children: (
            <>
              <ArrowLeft aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </>
          ),
        } as Record<string, unknown>)
      )}
      {label !== null && meta !== null && (
        <div data-pages-rail-meta="" className="truncate pb-1 pl-7 pr-2 text-frame-xs text-frame-muted-fg">
          {meta}
        </div>
      )}
    </div>
  );
}

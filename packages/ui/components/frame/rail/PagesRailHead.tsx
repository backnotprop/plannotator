import { cloneElement, type ReactElement } from "react";
import { ArrowLeft } from "lucide-react";

import { Skeleton } from "../primitives/skeleton";
import { RAIL_ROW } from "./railRow";

export function PagesRailHead({
  label,
  backLink,
}: {
  readonly label: string | null;
  readonly backLink: ReactElement;
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
    </div>
  );
}

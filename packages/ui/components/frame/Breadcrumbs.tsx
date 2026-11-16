import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { Skeleton } from "./primitives/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/tooltip";
import { FOCUS_RING } from "./lib/recipes";
import { cn } from "./lib/utils";

export interface CrumbRoot {
  readonly label: string;
  readonly link: ReactElement<{ className?: string; children?: ReactNode }>;
}

export function Breadcrumbs({
  collectionName,
  collectionLink,
  path,
  root = null,
}: {
  readonly collectionName: string | null;
  readonly collectionLink: ReactElement;
  /** The file on screen; leave it out on the collection's own page. */
  readonly path?: string | null;
  readonly root?: CrumbRoot | null;
}) {
  const filename = path == null ? null : (path.split("/").at(-1) ?? path);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<"none" | "parents">("none");
  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (container === null || measure === null) return;
    const update = () => {
      const available = container.clientWidth;
      const full = measure.getBoundingClientRect().width;
      setCollapsed(available >= full ? "none" : "parents");
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [collectionName, filename]);
  if (collectionName === null)
    return (
      <div className="flex min-w-0 flex-1 items-center" data-breadcrumb-pending>
        <Skeleton className="h-3.5 w-28 shrink-0" aria-hidden />
      </div>
    );
  return (
    <div
      ref={containerRef}
      className="relative min-w-0 flex-1"
      data-breadcrumb-collapse={collapsed}
    >
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute flex w-max items-center gap-1.5 whitespace-nowrap font-sans text-frame-sm"
      >
        {root !== null && (
          <>
            <span>{root.label}</span>
            <span className="text-frame-xs">/</span>
          </>
        )}
        <span className="font-medium">{collectionName}</span>
        {filename !== null && (
          <>
            <span className="text-frame-xs">/</span>
            <span className="font-medium">{filename}</span>
          </>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {root !== null && collapsed === "none" && (
          <>
            {cloneElement(root.link, {
              "data-breadcrumb-root": "",
              className: cn(
                "shrink-0 whitespace-nowrap rounded-frame-structure font-sans text-frame-sm text-frame-muted-fg hover:text-foreground [&[href]]:hover:underline",
                FOCUS_RING,
              ),
              children: root.label,
            } as Record<string, unknown>)}
            <span className="shrink-0 text-frame-xs text-frame-muted-fg" aria-hidden="true">
              /
            </span>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={cloneElement(collectionLink, {
              "aria-label": collectionName,
              "aria-current": filename === null ? "page" : undefined,
              className: cn(
                "whitespace-nowrap rounded-frame-structure font-sans text-frame-sm font-medium [&[href]]:hover:underline",
                collapsed === "parents"
                  ? "min-w-0 max-w-[45%] shrink-0 truncate"
                  : "shrink-0",
                FOCUS_RING,
              ),
            } as Record<string, unknown>)}
          >
            {collectionName}
          </TooltipTrigger>
          <TooltipContent>{collectionName}</TooltipContent>
        </Tooltip>
        {filename !== null && path != null && (
          <>
            <span className="shrink-0 text-frame-xs text-frame-muted-fg" aria-hidden="true">
              /
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-current="page"
                    className="min-w-0 flex-1 truncate font-sans text-frame-sm font-medium text-foreground"
                  />
                }
              >
                {filename}
              </TooltipTrigger>
              <TooltipContent>{path}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

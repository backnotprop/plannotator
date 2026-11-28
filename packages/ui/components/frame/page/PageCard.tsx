import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function PageHeader({
  identity,
  actions,
  actionsClassName,
}: {
  identity: ReactNode;
  actions: ReactNode;
  actionsClassName?: string;
}) {
  return (
    <>
      <div className="flex min-w-24 flex-1 items-center gap-1.5 overflow-hidden md:min-w-0">
        {identity}
      </div>
      <div
        role="group"
        aria-label="Page actions"
        data-document-actions=""
        className={cn(
          "flex shrink-0 items-center gap-1 [&_a]:text-frame-xs [&_button]:text-frame-xs",
          "max-md:order-2 max-md:basis-full max-md:flex-wrap max-md:justify-start max-md:gap-1",
          actionsClassName,
        )}
      >
        {actions}
      </div>
    </>
  );
}

export function PageCard({
  hidden = false,
  top,
  children,
}: {
  hidden?: boolean;
  top?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-document-shell
      className={cn(
        "relative flex h-full min-w-0 flex-1 overflow-hidden bg-card",
        hidden && "hidden",
      )}
    >
      <div className="relative flex h-full min-w-[280px] flex-1 flex-col overflow-hidden">
        {top}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

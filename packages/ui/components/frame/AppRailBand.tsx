import type { ReactNode } from "react";

import { cn } from "./lib/utils";

export function AppRailBand({
  variant = "default",
  children,
}: {
  variant?: "default" | "dense";
  children?: ReactNode;
}) {
  return (
    <nav
      data-page-header
      className={cn(
        "flex min-w-0 shrink-0 items-center border-b border-border pt-px px-4 backdrop-blur",
        variant === "dense"
          ? "h-9 gap-1 md:gap-1.5 overflow-x-auto overflow-y-hidden max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:overflow-visible max-md:py-1 bg-frame-band frame-dark:bg-background/80 frame-dark:frame-reduce-transparency:bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "h-10 gap-2 overflow-hidden bg-background/80 frame-reduce-transparency:bg-background",
      )}
    >
      {children}
    </nav>
  );
}

import type { ReactNode, Ref } from "react";

import { cn } from "./lib/utils";

export function FrameGround({
  tone,
  colors = "fixed",
  as = "main",
  children,
}: {
  tone?: "plain" | "tinted";
  /** "theme": selected, hover and subtle border follow the theme's primary and foreground (frame.css). */
  colors?: "fixed" | "theme";
  /** "main" (default) fills the viewport and holds the page's <main>; "div" fills its container, for a host that has its own. */
  as?: "main" | "div";
  children: ReactNode;
}) {
  const Pane = as;
  return (
    <div
      data-frame-ground=""
      data-frame-tone={tone}
      data-frame-colors={colors}
      className={cn("flex w-full overflow-hidden", as === "main" ? "h-svh" : "h-full")}
    >
      <Pane
        data-frame-pane=""
        className="relative flex-1 overflow-hidden bg-card md:my-2 md:mr-2 md:ml-2 md:rounded-frame-pane md:shadow-frame-pane"
      >
        {children}
      </Pane>
    </div>
  );
}

export function FrameBox({
  band,
  rowRef,
  standalone = false,
  children,
}: {
  band: ReactNode;
  rowRef?: Ref<HTMLDivElement>;
  standalone?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-frame={standalone ? undefined : ""}
      className={cn(
        "isolate flex min-w-0 flex-col bg-background",
        standalone ? "h-dvh" : "h-full",
      )}
    >
      {band}
      <div
        ref={rowRef}
        data-frame-row=""
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

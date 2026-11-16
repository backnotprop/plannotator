import type { ReactNode, Ref } from "react";

import { cn } from "./lib/utils";

export function FrameGround({
  tone,
  children,
}: {
  tone?: "plain" | "tinted";
  children: ReactNode;
}) {
  return (
    <div data-frame-ground="" data-frame-tone={tone} className="flex h-svh w-full overflow-hidden">
      <main
        data-frame-pane=""
        className="relative flex-1 overflow-hidden bg-card md:my-2 md:mr-2 md:ml-2 md:rounded-frame-pane md:shadow-frame-pane"
      >
        {children}
      </main>
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

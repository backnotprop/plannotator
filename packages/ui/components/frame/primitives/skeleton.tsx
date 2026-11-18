import type * as React from "react";

import { cn } from "../lib/utils";

function Skeleton({
  className,
  pulse = true,
  ...props
}: React.ComponentProps<"div"> & { pulse?: boolean }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        pulse
          ? "bg-muted animate-pulse motion-reduce:animate-none rounded-frame-control"
          : "bg-muted rounded-frame-control",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };

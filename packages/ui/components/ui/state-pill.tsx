import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

/**
 * StatePill — semantic status indicator (PR/issue/session state). Rounded-full pill
 * with tone-based color. Uses standard color ramps (green/red/purple) for instantly
 * legible state rather than theme accent tokens.
 */
const statePillVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        open: "bg-green-500/10 text-green-500",
        closed: "bg-red-500/10 text-red-500",
        merged: "bg-purple-500/10 text-purple-500",
        muted: "bg-muted text-muted-foreground",
        secondary: "bg-secondary text-secondary-foreground",
      },
    },
    defaultVariants: {
      tone: "muted",
    },
  },
);

export type StatePillTone = NonNullable<VariantProps<typeof statePillVariants>["tone"]>;

function StatePill({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statePillVariants>) {
  return (
    <span
      data-slot="state-pill"
      className={cn(statePillVariants({ tone }), className)}
      {...props}
    />
  );
}

export { StatePill, statePillVariants };

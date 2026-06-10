import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Button — the canonical action primitive (shared by the frontend shell and the
 * embedded plan/review apps). cva variants + sizes, optional `iconLeft`/`iconRight`
 * slots, and `asChild` for polymorphism.
 *
 * `success` (solid, token-driven green) covers the plan app's Approve action; the
 * Feedback action uses `outline`. (No `accent` variant — `text-accent` on `bg-accent`
 * has no contrast in neutral-accent themes.)
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium transition-[color,background-color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        success: "bg-success text-success-foreground shadow-xs hover:bg-success/90",
        outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        xxs: "h-6 rounded-md gap-1.5 px-2.5",
        xs: "h-7 rounded-md gap-1.5 px-2.5",
        sm: "h-8 rounded-md gap-1.5 px-3",
        lg: "h-10 rounded-md px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonIcon = React.ReactNode;

function Button({
  children,
  className,
  variant,
  size,
  asChild = false,
  iconLeft,
  iconRight,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    iconLeft?: ButtonIcon;
    iconRight?: ButtonIcon;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {iconLeft ? (
        <span data-slot="button-icon" data-side="left" aria-hidden="true" className="shrink-0">
          {iconLeft}
        </span>
      ) : null}
      <Slottable>{children}</Slottable>
      {iconRight ? (
        <span data-slot="button-icon" data-side="right" aria-hidden="true" className="shrink-0">
          {iconRight}
        </span>
      ) : null}
    </Comp>
  );
}

export { Button, buttonVariants };

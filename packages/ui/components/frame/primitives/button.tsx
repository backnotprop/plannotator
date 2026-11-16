/** The frame's button: frame tokens (row height, control radius, quiet fill), not `components/ui/button`'s look. */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { FOCUS_RING } from "../lib/recipes";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-frame-control text-frame-sm font-medium transition-[color,background-color,border-color,box-shadow] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0 aria-invalid:ring-destructive/20 frame-dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    FOCUS_RING,
  ],
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "border border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-transparent bg-frame-quiet-fill hover:bg-frame-quiet-fill-hover",
        ghost: "border border-transparent text-frame-muted-fg hover:bg-frame-hover hover:text-foreground",
        link: "border border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-frame-control px-3 max-md:min-h-11",
        xxs: "h-frame-row gap-1.5 px-2.5 max-md:min-h-11",
        xs: "h-frame-row gap-1.5 px-2.5 max-md:min-h-11",
        sm: "h-frame-row gap-1.5 px-2.5 max-md:min-h-11",
        lg: "h-9 px-4 max-md:min-h-11",
        icon: "relative size-7 after:absolute after:-inset-1 max-md:min-h-11 max-md:min-w-11",
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
  iconLeft,
  iconRight,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    iconLeft?: ButtonIcon;
    iconRight?: ButtonIcon;
  }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {iconLeft ? (
        <span
          data-slot="button-icon"
          data-side="left"
          aria-hidden="true"
          className="shrink-0"
        >
          {iconLeft}
        </span>
      ) : null}
      {children}
      {iconRight ? (
        <span
          data-slot="button-icon"
          data-side="right"
          aria-hidden="true"
          className="shrink-0"
        >
          {iconRight}
        </span>
      ) : null}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };

import type * as React from "react";

import { cn } from "../../lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1.5 px-6", className)} {...props} />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-title" className={cn("font-semibold leading-none", className)} {...props} />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-footer" className={cn("flex items-center px-6", className)} {...props} />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };

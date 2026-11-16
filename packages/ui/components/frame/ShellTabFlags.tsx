import type { ReactNode } from "react";

import { FOCUS_RING } from "./lib/recipes";
import { cn } from "./lib/utils";

function Flag({
  title,
  ariaLabel,
  onClick,
  autoFocus,
  children,
}: {
  title: string;
  ariaLabel: string;
  onClick: () => void;
  autoFocus: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={false}
      className={cn(
        "flex h-9 w-7 items-center justify-center rounded-r-frame-control border border-l-0 border-border/50 bg-card/80 text-frame-muted-fg backdrop-blur-sm transition-colors hover:bg-card hover:text-foreground frame-reduce-transparency:bg-card frame-reduce-transparency:backdrop-blur-none",
        FOCUS_RING,
      )}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        {children}
      </svg>
    </button>
  );
}

export function ShellTabFlags({ onOpenFiles, autoFocus = false }: { onOpenFiles: () => void; autoFocus?: boolean }) {
  return (
    <div data-rail-flags="" className="relative z-20 hidden w-7 shrink-0 flex-col gap-1 pt-3 md:flex">
      <Flag title="Files" ariaLabel="Show files" onClick={onOpenFiles} autoFocus={autoFocus}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </Flag>
    </div>
  );
}

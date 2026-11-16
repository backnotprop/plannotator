import type { ReactNode } from "react";

import { Sheet, SheetContent } from "../primitives/sheet";

function firstFocus(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("[data-comments-sheet] [data-comments-list]") ??
    document.querySelector<HTMLElement>("[data-comments-sheet]")
  );
}

export function CommentsSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        closeButton={false}
        aria-label="Comments"
        data-comments-sheet=""
        initialFocus={firstFocus}
        className="h-[85dvh] gap-0 overflow-hidden p-0 [&_[data-comments-panel]]:min-h-0 [&_[data-comments-panel]]:flex-1"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}

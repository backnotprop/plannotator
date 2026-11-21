import type { ReactNode } from "react";

import { Sheet, SheetContent } from "../primitives/sheet";

function firstFocus(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("[data-versions-sheet] [data-version-viewing] a") ??
    document.querySelector<HTMLElement>("[data-versions-sheet]")
  );
}

export function VersionsSheet({
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
        aria-label="Versions"
        data-versions-sheet=""
        initialFocus={firstFocus}
        className="h-[70dvh] gap-0 overflow-hidden p-0 [&_[data-versions-panel]]:min-h-0 [&_[data-versions-panel]]:w-full [&_[data-versions-panel]]:flex-1 [&_[data-versions-panel]]:border-l-0"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}

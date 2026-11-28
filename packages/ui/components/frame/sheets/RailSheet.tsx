import { PanelLeftOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../primitives/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../primitives/sheet";
import { useSupportsDockedRail } from "../lib/useSupportsDockedRail";

export function RailSheet({
  head,
  children,
  closeKey,
  triggerLabel = "Open the sidebar",
  triggerTitle = "Sidebar",
  title = "Pages",
  description = "The pages in this collection.",
  docked,
  open: openProp,
  onOpenChange,
  trigger = true,
}: {
  head: ReactNode;
  children: ReactNode;
  closeKey: string;
  triggerLabel?: string;
  triggerTitle?: string;
  title?: string;
  description?: string;
  /**
   * `false` offers the sheet at any width, for a docked rail that does not fit the row
   * (pass `DocumentRailShell`'s `onFitChange` result). Below 768px the sheet always shows.
   */
  docked?: boolean;
  /** Controlled open state (with `onOpenChange`), for a host that opens the sheet from its own control. Absent: the sheet keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `false` draws no trigger button: the host opens the sheet through `open`. */
  trigger?: boolean;
}) {
  const wide = useSupportsDockedRail();
  const supportsDockedRail = wide && docked !== false;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (supportsDockedRail && open) setOpen(false);
  }, [supportsDockedRail]);

  useEffect(() => {
    if (open) setOpen(false);
  }, [closeKey]);

  if (supportsDockedRail) return null;

  return (
    <>
      {trigger && (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={triggerLabel}
        aria-expanded={open}
        title={triggerTitle}
        className="shrink-0"
        onClick={() => setOpen(true)}
      >
        <PanelLeftOpen aria-hidden="true" />
      </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          data-mobile="true"
          data-plan-sidebar="compact"
          className="flex flex-col gap-0 overflow-hidden bg-card p-0"
          style={{ width: "min(360px, calc(100vw - 2rem))", maxWidth: "none" }}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          <div className="pt-12">{head}</div>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 py-1">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

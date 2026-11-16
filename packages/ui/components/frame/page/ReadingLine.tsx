import type { ReactElement, ReactNode } from "react";

import { Button } from "../primitives/button";
import { FOCUS_RING } from "../lib/recipes";
import { cn } from "../lib/utils";

export interface OlderVersion {
  readonly back: ReactElement;
  readonly actions?: ReactNode;
  readonly restore: ReactNode;
}

function readingWords(
  shownNumber: number | null,
  currentNumber: number | null,
  older: boolean,
): { readonly tag: string | null; readonly rest: string; readonly spoken: string } {
  if (!older) {
    return shownNumber === null
      ? { tag: null, rest: "", spoken: "Versions" }
      : {
          tag: `v${shownNumber}`,
          rest: " · newest",
          spoken: `Versions. Reading version ${shownNumber}, the newest`,
        };
  }
  if (shownNumber === null) {
    return { tag: null, rest: "an older version", spoken: "Versions. Reading an older version" };
  }
  if (currentNumber === null) {
    return { tag: `v${shownNumber}`, rest: "", spoken: `Versions. Reading version ${shownNumber}` };
  }
  return {
    tag: `v${shownNumber}`,
    rest: ` of ${currentNumber}`,
    spoken: `Versions. Reading version ${shownNumber} of ${currentNumber}`,
  };
}

export function ReadingLine({
  shownNumber,
  currentNumber,
  versionsOpen,
  onToggleVersions,
  approved = null,
  older = null,
}: {
  readonly shownNumber: number | null;
  readonly currentNumber: number | null;
  readonly versionsOpen: boolean;
  readonly onToggleVersions: ((next: boolean) => void) | null;
  readonly approved?: ReactNode;
  readonly older?: OlderVersion | null;
}) {
  const words = readingWords(shownNumber, currentNumber, older !== null);
  if (older === null && words.tag === null && approved === null) return null;
  const inner = (
    <>
      Reading{" "}
      {words.tag !== null && (
        <span data-page-version="" className="font-medium text-foreground">
          {words.tag}
        </span>
      )}
      {words.rest}
    </>
  );
  return (
    <div
      data-reading-line={older === null ? "newest" : "older"}
      data-older-version-bar={older === null ? undefined : ""}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-frame-sm text-muted-foreground md:py-1.5",
        older !== null && "border-b border-border bg-muted/40",
      )}
    >
      <span className={cn("flex min-w-0 flex-wrap items-baseline gap-x-2", older !== null && "max-md:basis-full")}>
        {onToggleVersions === null ? (
          <span>{inner}</span>
        ) : (
          <button
            type="button"
            data-reading-versions=""
            aria-expanded={versionsOpen}
            aria-label={words.spoken}
            onClick={() => onToggleVersions(!versionsOpen)}
            className={cn(
              "relative rounded-frame-structure hover:text-foreground",
              "max-md:after:absolute max-md:after:-inset-y-3 max-md:after:-inset-x-1 max-md:after:content-['']",
              FOCUS_RING,
            )}
          >
            {inner}
          </button>
        )}
        {older !== null && <span role="status">You are looking at an older version.</span>}
      </span>
      {older !== null && (
        <>
          {older.actions !== undefined && older.actions !== null && (
            <span className="flex md:ml-auto max-md:order-last max-md:basis-full">
              {older.actions}
            </span>
          )}
          <span className={cn("flex items-center gap-2", (older.actions === undefined || older.actions === null) && "md:ml-auto")}>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              nativeButton={false}
              render={older.back}
            >
              {currentNumber === null
                ? "Back to the newest version"
                : `Back to version ${currentNumber}`}
            </Button>
            {older.restore}
          </span>
        </>
      )}
      {older === null && approved !== null && <span className="flex min-w-0 md:ml-auto">{approved}</span>}
    </div>
  );
}

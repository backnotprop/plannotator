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
      : { tag: `v${shownNumber}`, rest: " · newest", spoken: `Version ${shownNumber}, the newest` };
  }
  if (shownNumber === null) {
    return { tag: null, rest: "Versions", spoken: "Versions" };
  }
  if (currentNumber === null) {
    return { tag: `v${shownNumber}`, rest: "", spoken: `Version ${shownNumber}, an older version` };
  }
  return {
    tag: `v${shownNumber}`,
    rest: ` of ${currentNumber}`,
    spoken: `Version ${shownNumber} of ${currentNumber}, an older version`,
  };
}

export function ReadingLine({
  shownNumber,
  currentNumber,
  versionsOpen,
  onToggleVersions,
  approved = null,
  older = null,
  comparing = null,
  count = null,
  versionAt = "end",
  start = null,
}: {
  readonly shownNumber: number | null;
  readonly currentNumber: number | null;
  readonly versionsOpen: boolean;
  readonly onToggleVersions: ((next: boolean) => void) | null;
  readonly approved?: ReactNode;
  readonly older?: OlderVersion | null;
  /** While two versions are compared, the host's words for it (for example "Comparing v2 with v6") replace the version words. */
  readonly comparing?: string | null;
  /** How many versions there are, shown on the versions toggle. */
  readonly count?: number | null;
  /**
   * Where the version words and toggle sit: "end" (default), at the right next to the panel
   * they open, with `approved` on the start side; or "start", with `approved` at the right.
   */
  readonly versionAt?: "start" | "end";
  /** Content at the start of the line, before everything else (a project name, a decision mark). */
  readonly start?: ReactNode;
}) {
  const words = readingWords(shownNumber, currentNumber, older !== null);
  if (older === null && words.tag === null && approved === null && comparing === null && start === null) return null;
  const end = versionAt === "end";
  const totalShown = comparing === null && older !== null && shownNumber !== null && currentNumber !== null;
  const shownCount = totalShown ? null : count;
  const counted =
    shownCount === null || onToggleVersions === null ? null : (
      <span data-reading-versions-count="" className="ml-1.5 tabular-nums text-frame-tertiary">
        {shownCount}
      </span>
    );
  const inner =
    comparing !== null ? (
      <>
        <span data-reading-comparing="" className="text-foreground">
          {comparing}
        </span>
        {counted}
      </>
    ) : (
      <>
        {words.tag !== null && (
          <span data-page-version="" className="font-medium text-foreground">
            {words.tag}
          </span>
        )}
        {words.rest}
        {counted}
      </>
    );
  const shown = `${words.tag ?? ""}${words.rest}`;
  const named =
    shown === "" || shown === words.spoken
      ? words.spoken
      : `${shown}, ${words.spoken.charAt(0).toLowerCase()}${words.spoken.slice(1)}`;
  const main = comparing ?? named;
  const spoken = [
    main,
    shownCount === null ? null : `${shownCount} ${shownCount === 1 ? "version" : "versions"}`,
    main === "Versions" || shownCount !== null ? null : "Versions",
  ]
    .filter((part): part is string => part !== null)
    .join(". ");
  const toggle =
    onToggleVersions === null ? (
      <span>{inner}</span>
    ) : (
      <button
        type="button"
        data-reading-versions=""
        aria-expanded={versionsOpen}
        aria-label={spoken}
        onClick={() => onToggleVersions(!versionsOpen)}
        className={cn(
          "relative rounded-frame-structure hover:text-foreground",
          "max-md:after:absolute max-md:after:-inset-y-3 max-md:after:-inset-x-1 max-md:after:content-['']",
          FOCUS_RING,
        )}
      >
        {inner}
      </button>
    );
  return (
    <div
      data-reading-line={older === null ? "newest" : "older"}
      data-older-version-bar={older === null ? undefined : ""}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-frame-sm text-frame-muted-fg md:py-1.5",
        older !== null && "border-b border-border bg-muted/40",
      )}
    >
      {start !== null && (
        <span data-reading-start="" className="flex min-w-0 items-center gap-2">
          {start}
        </span>
      )}
      {end ? (
        <>
          {older === null && approved !== null && <span className="flex min-w-0">{approved}</span>}
          {older !== null && <span role="status">You are looking at an older version.</span>}
        </>
      ) : (
        <span className={cn("flex min-w-0 flex-wrap items-baseline gap-x-2", older !== null && "max-md:basis-full")}>
          {toggle}
          {older !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span role="status">You are looking at an older version.</span>
            </>
          )}
        </span>
      )}
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
      {!end && older === null && approved !== null && <span className="flex min-w-0 md:ml-auto">{approved}</span>}
      {end && (
        <span
          data-reading-version-end=""
          className={cn("flex min-w-0 items-baseline gap-x-2", older === null ? "ml-auto" : "max-md:ml-auto")}
        >
          {toggle}
        </span>
      )}
    </div>
  );
}

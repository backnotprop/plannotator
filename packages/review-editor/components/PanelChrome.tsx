import React from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Copy, Settings2, X } from "lucide-react";
import { Tooltip } from "@plannotator/ui/components/Tooltip";

/**
 * Shared chrome for the left review panels (FileTree, SectionsPanel).
 *
 * The header's top row belongs to the PanelViewToggle alone (full width), so
 * the controls that used to share it — staged count, search, collapse-all,
 * hide-viewed, viewed counter — render as their own row directly above the
 * file list, below the "All files" entry. One source so both views keep the
 * same cluster in the same order.
 */
export function PanelControlsRow({
  stagedCount = 0,
  isSearchVisible = false,
  onOpenSearch,
  onToggleAllFolders,
  areAllFoldersExpanded = false,
  collapseDisabled = false,
  onToggleHideViewed,
  hideViewedFiles = false,
  viewedCount,
  totalCount,
  onCopyRawDiff,
  canCopyRawDiff = false,
  copyRawDiffStatus = "idle",
  showViewedControls = true,
  onToggleShowViewedControls,
  showStageControls = true,
  onToggleShowStageControls,
}: {
  stagedCount?: number;
  isSearchVisible?: boolean;
  onOpenSearch?: () => void;
  /** Tree view only — the sections view has no folders to collapse. */
  onToggleAllFolders?: () => void;
  areAllFoldersExpanded?: boolean;
  collapseDisabled?: boolean;
  onToggleHideViewed?: () => void;
  hideViewedFiles?: boolean;
  viewedCount: number;
  totalCount: number;
  onCopyRawDiff?: () => void;
  canCopyRawDiff?: boolean;
  copyRawDiffStatus?: "idle" | "success" | "error";
  showViewedControls?: boolean;
  onToggleShowViewedControls?: () => void;
  showStageControls?: boolean;
  onToggleShowStageControls?: () => void;
}) {
  const copyLabel =
    copyRawDiffStatus === "success"
      ? "Copied all diffs"
      : copyRawDiffStatus === "error"
        ? "Could not copy all diffs"
        : "Copy all diffs";

  return (
    <div
      className="flex items-center justify-between gap-2 pl-1 pr-2 py-1"
      data-panel-controls-row
    >
      {showViewedControls && (
        <div
          className="flex min-w-0 items-center gap-1.5"
          data-panel-viewed-controls
        >
          {onToggleHideViewed && (
            <button
              type="button"
              onClick={onToggleHideViewed}
              className={`panel-utility-button p-1 rounded transition-colors ${hideViewedFiles ? "bg-primary/15 text-primary" : "hover:bg-muted text-muted-foreground"}`}
              aria-label={
                hideViewedFiles ? "Show viewed files" : "Hide viewed files"
              }
              title={
                hideViewedFiles ? "Show viewed files" : "Hide viewed files"
              }
            >
              {hideViewedFiles ? (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                  />
                </svg>
              ) : (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              )}
            </button>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {viewedCount}/{totalCount}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {showStageControls && stagedCount > 0 && (
          <span className="text-xs text-primary font-medium">
            {stagedCount} added
          </span>
        )}
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            className={`panel-utility-button p-1 rounded transition-colors ${isSearchVisible ? "bg-primary/15 text-primary" : "hover:bg-muted text-muted-foreground"}`}
            aria-label="Search diff"
            title="Search diff (Cmd/Ctrl+F)"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"
              />
            </svg>
          </button>
        )}
        {onToggleAllFolders && (
          <button
            type="button"
            onClick={onToggleAllFolders}
            disabled={collapseDisabled}
            className="panel-utility-button p-1 rounded transition-colors hover:bg-muted text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={
              areAllFoldersExpanded
                ? "Collapse all folders"
                : "Expand all folders"
            }
            title={
              areAllFoldersExpanded
                ? "Collapse all folders"
                : "Expand all folders"
            }
          >
            {areAllFoldersExpanded ? (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 2l7 6 7-6"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 22l7-6 7 6"
                />
              </svg>
            ) : (
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 8l7-6 7 6"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 16l7 6 7-6"
                />
              </svg>
            )}
          </button>
        )}
        {onCopyRawDiff && (
          <Tooltip content={copyLabel} side="bottom" delayDuration={300}>
            <button
              type="button"
              onClick={onCopyRawDiff}
              disabled={!canCopyRawDiff}
              aria-label={copyLabel}
              className={`panel-utility-button p-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                copyRawDiffStatus === "success"
                  ? "text-success"
                  : copyRawDiffStatus === "error"
                    ? "text-destructive"
                    : "hover:bg-muted text-muted-foreground"
              }`}
            >
              {copyRawDiffStatus === "success" ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : copyRawDiffStatus === "error" ? (
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        )}
        {onToggleShowViewedControls && onToggleShowStageControls && (
          <Popover.Root>
            <Popover.Trigger
              render={
                <button
                  type="button"
                  className="panel-utility-button p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label="Tree controls"
                  title="Tree controls"
                >
                  <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              }
            />
            <Popover.Portal>
              <Popover.Positioner
                align="end"
                side="top"
                sideOffset={6}
                className="z-[110]"
              >
                <Popover.Popup
                  className="w-64 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none"
                  aria-label="Tree controls"
                  data-review-tree-settings
                >
                  <div className="px-2 pb-1.5 pt-1">
                    <div className="text-xs font-medium">Tree controls</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showViewedControls}
                    onClick={() => {
                      // Hiding the only filter affordance must never leave the
                      // file list silently filtered.
                      if (showViewedControls && hideViewedFiles) onToggleHideViewed?.();
                      onToggleShowViewedControls();
                    }}
                    className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs">Viewed controls</span>
                      <span className="block text-[10px] leading-snug text-muted-foreground">
                        Per-file viewed buttons
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-7 flex-shrink-0 items-center rounded-full border px-0.5 ${
                        showViewedControls
                          ? "justify-end border-primary/70 bg-primary"
                          : "justify-start border-border bg-muted"
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${showViewedControls ? "bg-primary-foreground" : "bg-muted-foreground/70"}`}
                      />
                    </span>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showStageControls}
                    onClick={onToggleShowStageControls}
                    className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs">Git add controls</span>
                      <span className="block text-[10px] leading-snug text-muted-foreground">
                        Stage buttons and status markers
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-7 flex-shrink-0 items-center rounded-full border px-0.5 ${
                        showStageControls
                          ? "justify-end border-primary/70 bg-primary"
                          : "justify-start border-border bg-muted"
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${showStageControls ? "bg-primary-foreground" : "bg-muted-foreground/70"}`}
                      />
                    </span>
                  </button>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>

      <span className="sr-only" aria-live="polite">
        {copyRawDiffStatus === "success"
          ? "All diffs copied"
          : copyRawDiffStatus === "error"
            ? "Copy failed"
            : ""}
      </span>
    </div>
  );
}

export function PanelSearchField({
  inputRef,
  query,
  resultCount,
  isPending,
  onChange,
  onKeyDown,
  onClear,
  onClose,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  query: string;
  resultCount: number;
  isPending: boolean;
  onChange: (value: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
  onClear?: () => void;
  onClose?: () => void;
}) {
  const hasQuery = !!query.trim();
  const actionLabel = hasQuery ? "Clear search" : "Close search";

  return (
    <div
      className="flex items-center border-b border-border/50 px-2"
      style={{ height: "var(--panel-header-h)" }}
      data-panel-search-field
    >
      <div className="relative flex-1">
        <svg
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search diff..."
          aria-label="Search diff"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded bg-muted py-1.5 pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {hasQuery && !isPending && (
            <span className="text-[10px] tabular-nums text-muted-foreground/40">
              {resultCount}
            </span>
          )}
          <button
            type="button"
            onClick={hasQuery ? onClear : onClose}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/50 hover:text-foreground"
            aria-label={actionLabel}
            title={actionLabel}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

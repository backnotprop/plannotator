import React, { useLayoutEffect, useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronsDownUp, ChevronsUpDown, Copy, Ellipsis, Eye, EyeOff, TextSearch, X } from "lucide-react";
import { Tooltip } from "@plannotator/ui/components/Tooltip";

/**
 * Shared chrome for the left review panels (FileTree, SectionsPanel), approved
 * design record "review-sidebar-aligned".
 *
 * Under the nav rows, two rows stick to the top of the scrolling list while
 * the files scroll beneath them:
 *
 *  - the tools row: Changes N / All files (the caller's `scope`), then Search
 *    in diff and Collapse all as one-click icons, and a "…" menu with Copy all
 *    diffs, Auto-mark viewed, Group by kind, the Viewed button and the Git add
 *    button;
 *  - the progress row: "0 of 12 viewed · 1 staged" in words ("All 12 viewed"
 *    when done), and Hide viewed as a one-click eye at its end.
 *
 * A hairline shows under the block only while files scroll beneath it. One
 * source so both views keep the same tools in the same places. In a narrow
 * panel the icons wrap under the scope instead of drawing over it.
 */
/** From this panel width the scope and the tools always share one line (they
 *  fit at the default 256 px in either scope); narrower, the tools always
 *  wrap under the scope. Either way switching scope never moves the list. */
export const TOOLS_ONE_ROW_WIDTH = 256;

export interface PanelControlsProps {
  stagedCount?: number;
  isSearchVisible?: boolean;
  onOpenSearch?: () => void;
  /** Closes the search a second click on Search in diff finds open. Without
   *  it the button is a plain button (no pressed state). */
  onCloseSearch?: () => void;
  /** Keep the scope and the tools on one line (`TOOLS_ONE_ROW_WIDTH`). */
  oneRow?: boolean;
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
  /** Auto-mark-viewed (`reviewAutoViewed`). Optional: without the handler the
   *  menu item is not rendered, so hosts that don't have the feature are
   *  unchanged. */
  autoViewed?: boolean;
  onToggleAutoViewed?: () => void;
  /** Tree view only: split the tree into Code / Tests / Generated blocks.
   *  Without the handler the menu item is not rendered. */
  groupByKind?: boolean;
  onToggleGroupByKind?: () => void;
  /** The tools row's lead: the Changes / All files switch (`ScopeSwitch`).
   *  Unset: the row is labelled "Files". */
  scope?: React.ReactNode;
}

/** 24 px icon buttons (WCAG 2.2 target size); pressed is a quiet grey fill. */
const TOOL =
  "panel-utility-button w-6 h-6 rounded-md text-muted-foreground transition-colors hover:bg-[var(--sidebar-fill)] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed";
const TOOL_PRESSED = "bg-[var(--sidebar-fill-strong)] text-foreground";

const MENU_ITEM =
  "flex w-full items-center gap-2 h-7 px-2 rounded-md text-[13px] text-foreground outline-none cursor-default select-none data-[highlighted]:bg-muted data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed";

export function copyDiffLabel(status: PanelControlsProps["copyRawDiffStatus"]): string {
  return status === "success" ? "Copied all diffs" : status === "error" ? "Could not copy all diffs" : "Copy all diffs";
}

/** A one-click icon tool with its name as a tooltip. `pressed` makes it a
 *  toggle button (aria-pressed); its name stays the same either way. */
function ToolButton({
  label,
  tooltip = label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  tooltip?: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip} side="bottom">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        className={`${TOOL} ${pressed ? TOOL_PRESSED : ""}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The tools and progress rows, stuck to the top of the list. The block's
 * hairline shows only while files are scrolled under it (`data-stuck`): it
 * marks that rows are hidden, it is not a section line.
 */
function StickyTools({ children }: { children: React.ReactNode }) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sentinel = sentinelRef.current;
    const block = blockRef.current;
    if (!sentinel || !block) return;
    let scroller: HTMLElement | null = block.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const port = scroller;
    const update = () => {
      const stuck = sentinel.getBoundingClientRect().top < port.getBoundingClientRect().top - 0.5;
      block.toggleAttribute("data-stuck", stuck);
    };
    update();
    port.addEventListener("scroll", update, { passive: true });
    return () => port.removeEventListener("scroll", update);
  }, []);
  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" data-review-sticky-sentinel="" />
      <div
        ref={blockRef}
        className="review-sticky-tools sticky top-0 z-10 -mx-2 px-2 pb-3 flex flex-col bg-background"
        data-review-sticky-tools=""
      >
        {children}
      </div>
    </>
  );
}

/** Where the review stands, in words, with the Hide viewed eye at the end
 *  (under the "…" button). No bar: at 0 % it read as a divider line. */
function ProgressRow({
  viewedCount,
  totalCount,
  stagedCount = 0,
  showViewedControls = true,
  showStageControls = true,
  hideViewedFiles = false,
  onToggleHideViewed,
}: PanelControlsProps) {
  const showStaged = showStageControls && stagedCount > 0;
  if (!showViewedControls && !showStaged) return null;
  const allViewed = showViewedControls && totalCount > 0 && viewedCount >= totalCount;
  return (
    <div
      className="flex items-center min-h-6 pl-2 pr-1 gap-1.5 text-[12px] text-muted-foreground tabular-nums"
      data-review-progress-caption=""
    >
      {/* Wraps between its parts, never inside one, in a narrow panel. */}
      <span className="min-w-0 flex flex-wrap items-center gap-x-1.5">
        {showViewedControls && (
          <span data-panel-viewed-controls="" className={`whitespace-nowrap${allViewed ? " text-success" : ""}`}>
            {allViewed ? `All ${totalCount} viewed` : `${viewedCount} of ${totalCount} viewed`}
          </span>
        )}
        {showViewedControls && showStaged && <span aria-hidden="true" data-progress-dot="">·</span>}
        {showStaged && (
          <span data-panel-staged-count="" className="whitespace-nowrap" title="Files staged with git add">
            {stagedCount} staged
          </span>
        )}
      </span>
      {showViewedControls && onToggleHideViewed && (
        <span className="ml-auto flex">
          <ToolButton label="Hide viewed files" onClick={onToggleHideViewed} pressed={hideViewedFiles}>
            {hideViewedFiles ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
          </ToolButton>
        </span>
      )}
    </div>
  );
}

/** The "…" menu: Copy all diffs and the set-and-forget settings. Copy keeps
 *  the menu open so its "Copied all diffs" label is seen. */
function ListOptionsMenu({
  showViewedControls = true,
  onToggleShowViewedControls,
  showStageControls = true,
  onToggleShowStageControls,
  hideViewedFiles = false,
  onToggleHideViewed,
  autoViewed = true,
  onToggleAutoViewed,
  groupByKind = true,
  onToggleGroupByKind,
  onCopyRawDiff,
  canCopyRawDiff = false,
  copyRawDiffStatus = "idle",
}: PanelControlsProps) {
  const perFile = !!onToggleShowViewedControls && !!onToggleShowStageControls;
  const settings = !!onToggleAutoViewed || !!onToggleGroupByKind;
  if (!onCopyRawDiff && !settings && !perFile) return null;
  const check = (on: boolean) => (
    <span className="ml-auto w-3.5 flex justify-center text-foreground">
      {on ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : null}
    </span>
  );
  return (
    <Menu.Root>
      <Tooltip content="List options" side="bottom">
        <Menu.Trigger className={`${TOOL} data-[popup-open]:bg-[var(--sidebar-fill-strong)] data-[popup-open]:text-foreground`} aria-label="List options">
          <Ellipsis className="w-4 h-4" aria-hidden="true" />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner align="end" side="bottom" sideOffset={6} className="z-[110] outline-none">
          <Menu.Popup
            className="w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
            data-review-tree-settings=""
          >
            {onCopyRawDiff && (
              <Menu.Item className={MENU_ITEM} onClick={onCopyRawDiff} disabled={!canCopyRawDiff} closeOnClick={false} data-review-copy-all-diffs="">
                {copyRawDiffStatus === "success" ? (
                  <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" />
                ) : copyRawDiffStatus === "error" ? (
                  <X className="w-3.5 h-3.5 text-destructive" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                )}
                {copyDiffLabel(copyRawDiffStatus)}
              </Menu.Item>
            )}
            {onCopyRawDiff && settings && <Menu.Separator className="my-1 h-px bg-border/70" />}
            {onToggleAutoViewed && (
              <Menu.CheckboxItem
                className={MENU_ITEM}
                checked={autoViewed}
                onCheckedChange={() => onToggleAutoViewed()}
                closeOnClick={false}
                data-review-auto-viewed-toggle=""
              >
                Auto-mark viewed
                {check(autoViewed)}
              </Menu.CheckboxItem>
            )}
            {onToggleGroupByKind && (
              <Menu.CheckboxItem
                className={MENU_ITEM}
                checked={groupByKind}
                onCheckedChange={() => onToggleGroupByKind()}
                closeOnClick={false}
                data-review-group-by-kind-toggle=""
              >
                Group by kind
                {check(groupByKind)}
              </Menu.CheckboxItem>
            )}
            {perFile && (
              <Menu.Group>
                {(onCopyRawDiff || settings) && <Menu.Separator className="my-1 h-px bg-border/70" />}
                <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">On each file</Menu.GroupLabel>
                <Menu.CheckboxItem
                  className={MENU_ITEM}
                  checked={showViewedControls}
                  onCheckedChange={() => {
                    // Hiding the only filter affordance must never leave the
                    // file list silently filtered.
                    if (showViewedControls && hideViewedFiles) onToggleHideViewed?.();
                    onToggleShowViewedControls!();
                  }}
                  closeOnClick={false}
                  data-review-viewed-controls-toggle=""
                >
                  Viewed button
                  {check(showViewedControls)}
                </Menu.CheckboxItem>
                <Menu.CheckboxItem
                  className={MENU_ITEM}
                  checked={showStageControls}
                  onCheckedChange={() => onToggleShowStageControls!()}
                  closeOnClick={false}
                  data-review-stage-controls-toggle=""
                >
                  Git add button
                  {check(showStageControls)}
                </Menu.CheckboxItem>
              </Menu.Group>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function PanelControlsRow(props: PanelControlsProps) {
  const {
    isSearchVisible = false,
    onOpenSearch,
    onCloseSearch,
    oneRow = false,
    onToggleAllFolders,
    areAllFoldersExpanded = false,
    collapseDisabled = false,
    copyRawDiffStatus = "idle",
    scope,
  } = props;
  const collapseLabel = areAllFoldersExpanded ? "Collapse all folders" : "Expand all folders";
  const searchToggles = !!onCloseSearch;
  return (
    <StickyTools>
      <div
        className={`flex ${oneRow ? "flex-nowrap" : "flex-wrap"} items-center min-h-7 gap-y-1`}
        data-panel-controls-row=""
      >
        {scope ?? <span className="px-2 text-[13px] font-medium text-muted-foreground">Files</span>}
        <div className="ml-auto flex flex-shrink-0 items-center pr-1">
          {onOpenSearch && (
            <ToolButton
              label="Search in diff"
              tooltip={searchToggles && isSearchVisible ? "Close search in diff" : "Search in diff (Cmd/Ctrl+F)"}
              onClick={searchToggles && isSearchVisible ? onCloseSearch! : onOpenSearch}
              pressed={searchToggles ? isSearchVisible : undefined}
            >
              <TextSearch className="w-3.5 h-3.5" aria-hidden="true" />
            </ToolButton>
          )}
          {onToggleAllFolders && (
            <ToolButton label={collapseLabel} onClick={onToggleAllFolders} disabled={collapseDisabled}>
              {areAllFoldersExpanded ? (
                <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </ToolButton>
          )}
          <ListOptionsMenu {...props} />
        </div>
        <span className="sr-only" aria-live="polite">
          {copyRawDiffStatus === "success" ? "All diffs copied" : copyRawDiffStatus === "error" ? "Copy failed" : ""}
        </span>
      </div>
      <ProgressRow {...props} />
    </StickyTools>
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

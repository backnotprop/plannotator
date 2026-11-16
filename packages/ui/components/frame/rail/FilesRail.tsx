import { cloneElement, type HTMLAttributes, type ReactElement, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import { Skeleton } from "../primitives/skeleton";
import { EYEBROW, FOCUS_RING, HOVER_QUIET } from "../lib/recipes";
import { cn } from "../lib/utils";
import type { FileGlyph } from "./fileIcons";
import { ROW, pad } from "./rowStyle";

export function FilesRailHeading({
  label = "Pages",
  count,
  countTitle = (n) => `${n} page${n === 1 ? "" : "s"}`,
  filterVisible = false,
  onToggleFilter,
  actions,
  menu,
}: {
  label?: string;
  count: number | null;
  /** The count's hover text. Default: "3 pages". */
  countTitle?: (count: number) => string;
  filterVisible?: boolean;
  /** Without it the heading has no Filter button (a second heading, for example "Artifacts"). */
  onToggleFilter?: () => void;
  actions?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="mt-1 flex items-center justify-between px-2 pb-1">
      <span className="flex items-baseline gap-1.5">
        <span className={EYEBROW}>{label}</span>
        {count !== null && (
          <span
            className="text-frame-2xs tabular-nums text-frame-tertiary"
            title={countTitle(count)}
          >
            {count}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {onToggleFilter !== undefined && (
          <button
            type="button"
            aria-label="Filter files"
            aria-expanded={filterVisible}
            title="Filter files"
            onClick={onToggleFilter}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-frame-control text-frame-tertiary transition-colors hover:text-foreground",
              HOVER_QUIET,
              FOCUS_RING,
              filterVisible === true && "bg-muted text-foreground",
            )}
          >
            <Search className="size-3.5" />
          </button>
        )}
        {actions}
        {menu}
      </span>
    </div>
  );
}

export const RAIL_ICON_BUTTON = cn(
  "inline-flex size-7 items-center justify-center rounded-frame-control text-frame-tertiary transition-colors hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-50",
  HOVER_QUIET,
  FOCUS_RING,
);

export function FilesRailFilter({ children }: { children: ReactNode }) {
  return <div className="mx-2 mb-1">{children}</div>;
}

export function FilesRailLoading() {
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1">
      <Skeleton className="h-frame-row w-3/4" />
      <Skeleton className="h-frame-row w-1/2" />
      <Skeleton className="h-frame-row w-2/3" />
    </div>
  );
}

export function FilesRailError({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="px-3 py-2 text-frame-2xs text-destructive/80" title={detail}>
      {message}
    </div>
  );
}

export function FilesRailEmpty({ children }: { children: ReactNode }) {
  return <div className="mx-2 mt-1 px-2 py-3 text-frame-2xs text-frame-tertiary">{children}</div>;
}

export function FilesRailNoMatch({ children }: { children: ReactNode }) {
  return (
    <p aria-live="polite" className="mx-2 px-1 py-2 text-frame-xs text-frame-tertiary">
      {children}
    </p>
  );
}

export function FilesRailRows({
  rowsRef,
  children,
}: {
  rowsRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={rowsRef} className="px-2">
      {children}
    </div>
  );
}

export function FileRow({
  id,
  name,
  title,
  depth,
  active,
  icon: Icon,
  link,
  presence,
  trailing,
  moving = false,
  openCommentCount = 0,
  error = null,
  busy = false,
  dragProps,
  renderActions,
  onOpen,
}: {
  id: string;
  name: string;
  title: string;
  depth: number;
  active: boolean;
  icon: FileGlyph;
  link: ReactElement;
  presence?: ReactNode;
  /** At the right end of the row, after the comment count: a mark such as "Main". */
  trailing?: ReactNode;
  moving?: boolean;
  openCommentCount?: number;
  error?: string | null;
  busy?: boolean;
  dragProps?: Pick<HTMLAttributes<HTMLDivElement>, "draggable" | "onDragStart" | "onDragEnd">;
  renderActions?: (row: ReactElement) => ReactNode;
  onOpen?: () => void;
}) {
  const hostClick = (link.props as { onClick?: (event: unknown) => void }).onClick;
  const row = cloneElement(link, {
    draggable: false,
    onClick:
      onOpen === undefined
        ? hostClick
        : (event: unknown) => {
            hostClick?.(event);
            onOpen();
          },
    style: pad(depth),
    className: cn(
      ROW,
      "pr-6",
      active && "bg-frame-selected text-frame-selected-fg hover:bg-frame-selected",
    ),
    title,
    "data-file-row-link": "",
    children: (
      <>
        <Icon className="size-3.5 shrink-0 text-frame-tertiary" />
        <span className="min-w-0 truncate transition-none">{name}</span>
        {presence}
        <span className="min-w-0 flex-1" />
        {moving ? (
          <span role="status" className="shrink-0 text-frame-2xs text-frame-tertiary">
            Moving…
          </span>
        ) : openCommentCount > 0 ? (
          <span
            className="shrink-0 text-frame-2xs tabular-nums text-frame-tertiary"
            data-page-comment-count=""
            aria-label={`${openCommentCount} open ${openCommentCount === 1 ? "comment" : "comments"}`}
          >
            {openCommentCount}
          </span>
        ) : null}
        {trailing !== undefined && trailing !== null && (
          <span data-file-row-trailing="" className="flex shrink-0 items-center">
            {trailing}
          </span>
        )}
      </>
    ),
  } as Record<string, unknown>);
  return (
    <div className="group/row relative" data-file-id={id} aria-busy={busy} {...dragProps}>
      {renderActions === undefined ? row : renderActions(row)}
      {error === null ? null : (
        <p role="alert" style={pad(depth)} className="py-1 pr-2 text-frame-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function FolderRow({
  name,
  path,
  depth,
  collapsed,
  selected,
  hot = false,
  toggleDisabled,
  onToggle,
  onSelect,
  presence,
  dropProps,
}: {
  name: string;
  path: string;
  depth: number;
  collapsed: boolean;
  selected: boolean;
  hot?: boolean;
  toggleDisabled: boolean;
  onToggle: () => void;
  onSelect: () => void;
  presence?: ReactNode;
  dropProps?: Pick<
    HTMLAttributes<HTMLDivElement>,
    "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
  >;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      style={pad(depth)}
      className={cn(
        ROW,
        "relative text-foreground/75",
        selected && "bg-frame-selected/50",
        hot && "bg-primary/10 ring-1 ring-primary",
      )}
      data-drop-folder={path}
      data-drop-folder-hot={hot ? "" : undefined}
      {...dropProps}
    >
      <button
        type="button"
        aria-label={(collapsed ? "Expand " : "Collapse ") + path}
        aria-expanded={!collapsed}
        disabled={toggleDisabled}
        onClick={onToggle}
        className={cn(
          "relative inline-flex size-5 shrink-0 items-center justify-center rounded-frame-structure",
          "[[data-mobile=true]_&]:after:absolute [[data-mobile=true]_&]:after:-inset-x-1.5 [[data-mobile=true]_&]:after:-inset-y-3",
          FOCUS_RING,
        )}
      >
        <Chevron className="size-3.5 text-frame-tertiary" />
      </button>
      <button
        type="button"
        title={path + "/"}
        disabled={toggleDisabled}
        aria-pressed={selected}
        onClick={() => {
          onSelect();
          if (collapsed) onToggle();
        }}
        className={cn("min-w-0 flex-1 truncate text-left transition-none", FOCUS_RING)}
      >
        {name}/
      </button>
      {presence}
    </div>
  );
}

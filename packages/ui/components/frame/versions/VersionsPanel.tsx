import { ChevronDown, Circle, CircleAlert, CircleCheck, X } from "lucide-react";
import { cloneElement, createContext, useContext, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "../primitives/button";
import { Skeleton } from "../primitives/skeleton";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { whenWords } from "../lib/formatTime";
import { FOCUS_RING, HOVER_QUIET, SELECTED } from "../lib/recipes";
import { cn } from "../lib/utils";

import {
  authorWords,
  compareEntry,
  foldHoldingViewing,
  foldTag,
  foldTitle,
  versionItems,
  versionTag,
  versionTitle,
  type VersionAuthor,
  type VersionDecision,
  type FrameVersionEntry,
} from "./versionsModel";

const TEXT_ACTION = cn(
  "relative rounded-frame-structure text-frame-xs font-medium text-frame-muted-fg hover:text-foreground",
  "max-md:after:absolute max-md:after:-inset-x-1 max-md:after:-inset-y-3.5 max-md:after:content-['']",
  FOCUS_RING,
);

const ROW = "flex w-full flex-col gap-0.5 rounded-frame-floating px-3 py-2 text-left max-md:min-h-11";

function fullDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function When({ iso }: { readonly iso: string }) {
  return (
    <time
      dateTime={iso}
      title={fullDate(iso)}
      className="whitespace-nowrap text-frame-xs text-frame-muted-fg tabular-nums"
    >
      {whenWords(iso)}
    </time>
  );
}

export function VersionActions({
  version,
  number,
  currentNumber = null,
  canCompare,
  soft = false,
  onCompare,
  onCopyLink,
  actions,
}: {
  readonly version: string;
  readonly number: number | null;
  readonly currentNumber?: number | null;
  readonly canCompare: boolean;
  readonly soft?: boolean;
  readonly onCompare: () => void;
  readonly onCopyLink: () => void;
  /** The host's own actions, beside "Compare". */
  readonly actions?: ReactNode;
}) {
  const named = number === null ? "this version" : `version ${number}`;
  const newest = currentNumber === null ? "the newest version" : `version ${currentNumber}`;
  const compareWords =
    number === null || currentNumber === null
      ? "Compare with the newest"
      : `Compare v${number} with v${currentNumber}`;
  return (
    <span data-version-actions="" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {canCompare &&
        (soft ? (
          <Button
            variant="outline"
            size="sm"
            data-version-compare=""
            data-version={version}
            aria-label={`Compare ${named} with ${newest}`}
            onClick={onCompare}
          >
            {compareWords}
          </Button>
        ) : (
          <button
            type="button"
            data-version-compare=""
            data-version={version}
            aria-label={`Compare ${named} with ${newest}`}
            className={TEXT_ACTION}
            onClick={onCompare}
          >
            {compareWords}
          </button>
        ))}
      {actions}
      <button
        type="button"
        data-version-copy-link=""
        aria-label={`Copy a link to ${named}`}
        title="The link always opens this exact version"
        className={TEXT_ACTION}
        onClick={onCopyLink}
      >
        Copy link
      </button>
    </span>
  );
}

export interface VersionRowContext {
  readonly phone: boolean;
  readonly exact: boolean;
}

export interface VersionRowPlace {
  readonly rowLink: (entry: FrameVersionEntry, context: VersionRowContext) => ReactElement;
  readonly exactMatch?: boolean;
  readonly onRowOpen?: (entry: FrameVersionEntry, phone: boolean) => void;
  readonly explainAgent?: (agentKind: string) => string | null;
  /** A line under a version's row (a host note or link); not inside the row's link. */
  readonly note?: (entry: FrameVersionEntry) => ReactNode;
  /** `false` hides the author line everywhere, for a host with no authors. Default `true`. */
  readonly authors?: boolean;
}

const DECISION_ICON = {
  positive: { Icon: CircleCheck, className: "text-success" },
  negative: { Icon: CircleAlert, className: "text-destructive" },
  neutral: { Icon: Circle, className: "text-frame-muted-fg" },
} as const;

function Decision({ decision }: { readonly decision: VersionDecision }) {
  const { Icon, className } = DECISION_ICON[decision.tone];
  return (
    <span
      data-version-decision={decision.tone}
      className="flex min-w-0 items-center gap-1.5 text-frame-xs text-foreground"
    >
      <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden="true" />
      <span className="truncate">{decision.label}</span>
    </span>
  );
}

function rowName(entry: FrameVersionEntry, who: string, compared = false): string {
  return [
    versionTitle(entry),
    entry.current ? "newest" : null,
    entry.viewing ? "on screen" : null,
    compared && !entry.viewing ? "compared" : null,
    who === "" ? null : who,
    whenWords(entry.createdAt),
    entry.sameAsOlder ? "no change to the text" : null,
    entry.approval === null ? null : `approved by ${entry.approval}`,
    entry.decision == null ? null : entry.decision.label,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

function Who({
  author,
  detail,
  explainAgent,
}: {
  readonly author: VersionAuthor;
  readonly detail: string;
  readonly explainAgent?: (agentKind: string) => string | null;
}) {
  const agent =
    author.kind === "agent" && explainAgent !== undefined
      ? explainAgent(author.agentKind)
      : null;
  return (
    <span
      data-version-author=""
      data-agent-chip={author.kind === "agent" ? author.agentKind : undefined}
      data-version-unnamed={author.kind === "unnamed" ? "" : undefined}
      title={agent === null ? detail || undefined : `${detail}. ${agent}`}
      className="min-h-4 truncate text-frame-xs text-frame-muted-fg"
    >
      {detail}
    </span>
  );
}

function RowLines({
  entry,
  nested,
  explainAgent,
  authors,
}: {
  readonly entry: FrameVersionEntry;
  readonly nested: boolean;
  readonly explainAgent?: (agentKind: string) => string | null;
  readonly authors: boolean;
}) {
  const who = nested || !authors ? "" : authorWords(entry.author);
  const detail = [who === "" ? null : who, entry.sameAsOlder ? "No change to the text" : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-2 leading-5">
        <span className="text-frame-sm font-semibold text-foreground">{versionTag(entry)}</span>
        <When iso={entry.createdAt} />
        {entry.current && (
          <span
            data-version-current-label=""
            className="ml-auto shrink-0 text-frame-xs text-frame-muted-fg"
          >
            Newest
          </span>
        )}
      </span>
      {(detail !== "" || (!nested && authors && entry.author.kind !== "none")) && (
        <Who author={entry.author} detail={detail} explainAgent={explainAgent} />
      )}
      {entry.approval !== null && (
        <span
          data-version-approval=""
          className="flex min-w-0 items-center gap-1.5 text-frame-xs text-foreground"
        >
          <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          <span className="truncate">Approved by {entry.approval}</span>
        </span>
      )}
      {entry.decision != null && <Decision decision={entry.decision} />}
    </>
  );
}

const NOTHING_COMPARED: ReadonlySet<string> = new Set();
const ComparedKeys = createContext<ReadonlySet<string>>(NOTHING_COMPARED);

function VersionRow({
  place,
  entry,
  nested,
}: {
  readonly place: VersionRowPlace;
  readonly entry: FrameVersionEntry;
  readonly nested: boolean;
}) {
  const isMobile = useIsMobile();
  const compared = useContext(ComparedKeys).has(entry.key);
  const marked = entry.viewing || compared;
  const authors = place.authors !== false;
  const name = rowName(entry, nested || !authors ? "" : authorWords(entry.author), compared);
  const note = place.note?.(entry);
  const link = entry.linked
    ? place.rowLink(entry, { phone: isMobile, exact: place.exactMatch ?? true })
    : null;
  const hostClick = (link?.props as { onClick?: (event: unknown) => void } | undefined)?.onClick;
  return (
    <li
      data-version-row=""
      data-version={entry.version}
      data-version-current={entry.current ? "" : undefined}
      data-version-viewing={entry.viewing ? "" : undefined}
      data-version-compared={compared ? "" : undefined}
    >
      {link !== null ? (
        cloneElement(link, {
          onClick:
            place.onRowOpen === undefined
              ? hostClick
              : (event: unknown) => {
                  hostClick?.(event);
                  place.onRowOpen?.(entry, isMobile);
                },
          "aria-current": entry.viewing ? "true" : undefined,
          "aria-label": name,
          className: cn(ROW, marked ? SELECTED : HOVER_QUIET, FOCUS_RING),
          children: (
            <RowLines entry={entry} nested={nested} explainAgent={place.explainAgent} authors={authors} />
          ),
        } as Record<string, unknown>)
      ) : (
        <div role="group" aria-label={name} className={cn(ROW, marked && SELECTED)}>
          <RowLines entry={entry} nested={nested} explainAgent={place.explainAgent} authors={authors} />
        </div>
      )}
      {note !== undefined && note !== null && (
        <div data-version-note="" className="px-3 pb-2 pt-1 text-frame-xs text-frame-muted-fg">
          {note}
        </div>
      )}
    </li>
  );
}

function FoldRow({
  place,
  entries,
  open,
  holdsViewing,
  onToggle,
}: {
  readonly place: VersionRowPlace;
  readonly entries: readonly FrameVersionEntry[];
  readonly open: boolean;
  readonly holdsViewing: boolean;
  readonly onToggle: () => void;
}) {
  const listId = useId();
  const comparedKeys = useContext(ComparedKeys);
  const newest = entries[0]!;
  const onScreen = entries.find((entry) => entry.viewing);
  const hidden = holdsViewing && !open && onScreen !== undefined;
  const who = place.authors === false ? "" : authorWords(newest.author);
  const summary = who === "" ? `${entries.length} saves` : `${who} · ${entries.length} saves`;
  const name = [
    foldTitle(entries),
    who === "" ? `${entries.length} saves` : `${who}, ${entries.length} saves`,
    whenWords(newest.createdAt),
    hidden && onScreen !== undefined ? `${versionTitle(onScreen)} on screen` : null,
    ...(open ? [] : entries.filter((entry) => comparedKeys.has(entry.key)).map((entry) => `${versionTitle(entry)} compared`)),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    <li
      data-version-fold=""
      data-version-fold-open={open ? "" : undefined}
      data-version-fold-holds-viewing={hidden ? "" : undefined}
    >
      <button
        type="button"
        data-version-fold-toggle=""
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={name}
        onClick={onToggle}
        className={cn(ROW, hidden ? SELECTED : HOVER_QUIET, FOCUS_RING)}
      >
        <span className="flex w-full min-w-0 items-baseline gap-2 leading-5">
          <span className="text-frame-sm font-semibold text-foreground">{foldTag(entries)}</span>
          <When iso={newest.createdAt} />
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 shrink-0 self-center text-frame-muted-fg transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </span>
        <span className="truncate text-frame-xs text-frame-muted-fg" title={summary}>
          {summary}
        </span>
        {hidden && onScreen !== undefined && (
          <span
            data-version-fold-on-screen=""
            className="truncate text-frame-xs font-medium text-foreground"
          >
            {versionTag(onScreen)} on screen
          </span>
        )}
      </button>
      {open && (
        <ol id={listId} aria-label={foldTitle(entries)} className="ml-3 flex flex-col gap-0.5">
          {entries.map((entry) => (
            <VersionRow key={entry.key} place={place} entry={entry} nested />
          ))}
        </ol>
      )}
    </li>
  );
}

export function VersionsPanel({
  status,
  entries,
  place,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onScreenActions,
  onClose,
  footer,
  comparing = null,
}: {
  status: "pending" | "error" | "success";
  entries: readonly FrameVersionEntry[];
  place: VersionRowPlace;
  onRetry: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onScreenActions?: (onScreen: FrameVersionEntry, compared: FrameVersionEntry | null) => ReactNode;
  onClose?: () => void;
  /** Under the list, after "Show older versions". */
  footer?: ReactNode;
  /** During a compare, the two versions' `key`s; both rows are marked, and a fold holding either opens. */
  comparing?: { readonly from: string; readonly to: string } | null;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => versionItems(entries, opened), [entries, opened]);
  const holding = foldHoldingViewing(items);
  const viewingKey = entries.find((entry) => entry.viewing)?.key ?? null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (holding !== null && viewingKey !== null && openedFor !== viewingKey) {
    setOpenedFor(viewingKey);
    setOpened((previous) => new Set(previous).add(holding));
  }
  const comparedKeys = useMemo(
    () => (comparing === null ? NOTHING_COMPARED : new Set([comparing.from, comparing.to])),
    [comparing?.from, comparing?.to],
  );
  const comparedFor = comparing === null ? null : `${comparing.from}\n${comparing.to}`;
  const [foldsOpenedFor, setFoldsOpenedFor] = useState<string | null>(null);
  if (comparedFor !== null && foldsOpenedFor !== comparedFor) {
    const holdingCompared = items.flatMap((item) =>
      item.kind === "fold" && !item.open && item.entries.some((entry) => comparedKeys.has(entry.key)) ? [item.key] : [],
    );
    setFoldsOpenedFor(comparedFor);
    if (holdingCompared.length > 0) {
      setOpened((previous) => {
        const next = new Set(previous);
        for (const key of holdingCompared) next.add(key);
        return next;
      });
    }
  }
  const onScreen =
    status === "success" ? (entries.find((entry) => entry.viewing) ?? null) : null;
  const compared = compareEntry(entries);
  const toggle = (fold: { readonly key: string; readonly entries: readonly FrameVersionEntry[]; readonly open: boolean }) =>
    setOpened((previous) => {
      const next = new Set(previous);
      if (fold.open) for (const entry of fold.entries) next.delete(entry.key);
      else next.add(fold.key);
      return next;
    });
  return (
    <ComparedKeys.Provider value={comparedKeys}>
      <aside
        data-versions-panel=""
        aria-label="Versions"
        className="flex w-full shrink-0 flex-col overflow-hidden bg-card md:w-72 md:border-l md:border-border"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 px-4">
          <h2 className="min-w-0 flex-1 truncate text-frame-sm font-medium">Versions</h2>
          {onClose !== undefined && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close versions"
              className="-mr-1.5"
              onClick={onClose}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-1 pb-3">
          {status === "pending" && (
            <div className="flex flex-col gap-3 px-3 py-2" aria-label="Loading versions">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {status === "error" && (
            <div className="flex flex-col items-start gap-2 px-3 py-2 text-frame-sm text-frame-muted-fg">
              <span>Couldn't load the versions.</span>
              <button type="button" className={TEXT_ACTION} onClick={onRetry}>
                Try again
              </button>
            </div>
          )}
          {status === "success" && entries.length === 0 && (
            <p data-versions-empty="" className="px-3 py-2 text-frame-sm text-frame-muted-fg">
              No versions yet. Each save of this page shows here.
            </p>
          )}
          {status === "success" && entries.length > 0 && (
            <ol aria-label="Versions, newest first" className="flex flex-col gap-0.5">
              {items.map((item) =>
                item.kind === "one" ? (
                  <VersionRow
                    key={item.entry.key}
                    place={place}
                    entry={item.entry}
                    nested={false}
                  />
                ) : (
                  <FoldRow
                    key={item.key}
                    place={place}
                    entries={item.entries}
                    open={item.open}
                    holdsViewing={item.holdsViewing}
                    onToggle={() => toggle(item)}
                  />
                ),
              )}
            </ol>
          )}
          {onScreen !== null && onScreenActions !== undefined && (
            <div className="mt-3 px-3">{onScreenActions(onScreen, compared)}</div>
          )}
          {status === "success" && entries.length === 1 && !hasMore && (
            <p data-versions-one="" className="px-3 pt-3 text-frame-xs text-frame-muted-fg">
              Later saves show here, newest first.
            </p>
          )}
          {hasMore && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              className={cn("mx-3 mt-3", TEXT_ACTION)}
            >
              {loadingMore ? "Loading older versions" : "Show older versions"}
            </button>
          )}
          {footer !== undefined && footer !== null && (
            <div data-versions-footer="" className="mt-3 px-3">
              {footer}
            </div>
          )}
        </div>
      </aside>
    </ComparedKeys.Provider>
  );
}

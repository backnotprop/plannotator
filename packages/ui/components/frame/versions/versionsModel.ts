export const NO_NAME_RECORDED = "No name recorded";

export const FOLD_GAP_MS = 30 * 60_000;

export type VersionAuthor =
  | { readonly kind: "person"; readonly name: string; readonly key: string }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly agentKind: string;
      readonly name: string;
      readonly line: string;
    }
  | { readonly kind: "unnamed" }
  | { readonly kind: "pending" }
  /** No author line at all, for a host whose versions mostly have no person's name. */
  | { readonly kind: "none" };

export interface FrameVersionEntry {
  readonly key: string;
  readonly version: string;
  readonly number: number | null;
  readonly createdAt: string;
  readonly author: VersionAuthor;
  readonly current: boolean;
  readonly viewing: boolean;
  readonly linked: boolean;
  readonly sameAsOlder: boolean;
  readonly approval: string | null;
  /** A host's decision on this version beside `approval`, for example "Changes asked" (negative). */
  readonly decision?: VersionDecision | null;
  readonly canCompare: boolean;
}

export interface VersionDecision {
  readonly label: string;
  readonly tone: "positive" | "negative" | "neutral";
}

export type VersionItem =
  | { readonly kind: "one"; readonly entry: FrameVersionEntry }
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly entries: readonly FrameVersionEntry[];
      readonly open: boolean;
      readonly holdsViewing: boolean;
    };

export function authorWords(author: VersionAuthor): string {
  if (author.kind === "person") return author.name;
  if (author.kind === "agent") {
    return author.line === "" ? author.name : `${author.name} ${author.line}`;
  }
  if (author.kind === "pending" || author.kind === "none") return "";
  return NO_NAME_RECORDED;
}

function foldKey(author: VersionAuthor): string | null {
  if (author.kind === "person") return author.key;
  if (author.kind === "agent") return `agent:${author.id}`;
  return null;
}

export function versionTitle(entry: Pick<FrameVersionEntry, "number">): string {
  return entry.number === null ? "Earlier version" : `Version ${entry.number}`;
}

export function versionTag(entry: Pick<FrameVersionEntry, "number">): string {
  return entry.number === null ? "Earlier" : `v${entry.number}`;
}

export function foldTag(entries: readonly FrameVersionEntry[]): string {
  const newest = entries[0]?.number ?? null;
  const oldest = entries.at(-1)?.number ?? null;
  if (newest === null || oldest === null) return `${entries.length} saves`;
  return `v${oldest} to v${newest}`;
}

export function compareEntry(entries: readonly FrameVersionEntry[]): FrameVersionEntry | null {
  return entries.find((entry) => entry.viewing && entry.canCompare) ?? null;
}

export function foldTitle(entries: readonly FrameVersionEntry[]): string {
  const newest = entries[0]?.number ?? null;
  const oldest = entries.at(-1)?.number ?? null;
  if (newest === null || oldest === null) return `${entries.length} versions`;
  return `Versions ${oldest} to ${newest}`;
}

function folds(entry: FrameVersionEntry): boolean {
  return !entry.current && foldKey(entry.author) !== null;
}

export function foldKeyOf(run: readonly FrameVersionEntry[]): string {
  return run[0]!.key;
}

export function versionItems(
  entries: readonly FrameVersionEntry[],
  opened: ReadonlySet<string>,
): VersionItem[] {
  const items: VersionItem[] = [];
  let run: FrameVersionEntry[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const key = foldKeyOf(run);
      items.push({
        kind: "fold",
        key,
        entries: run,
        open: run.some((entry) => opened.has(entry.key)),
        holdsViewing: run.some((entry) => entry.viewing),
      });
    } else {
      for (const entry of run) items.push({ kind: "one", entry });
    }
    run = [];
  };
  for (const entry of entries) {
    const last = run.at(-1);
    const joins =
      last !== undefined &&
      folds(entry) &&
      foldKey(entry.author) === foldKey(last.author) &&
      Date.parse(last.createdAt) - Date.parse(entry.createdAt) <= FOLD_GAP_MS;
    if (!joins) flush();
    if (folds(entry)) run.push(entry);
    else items.push({ kind: "one", entry });
  }
  flush();
  return items;
}

export function foldHoldingViewing(items: readonly VersionItem[]): string | null {
  for (const item of items) {
    if (item.kind === "fold" && item.holdsViewing) return item.key;
  }
  return null;
}

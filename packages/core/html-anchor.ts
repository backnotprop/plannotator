/**
 * Raw-HTML annotation anchors: the pure, host-facing helpers a consumer of
 * `@plannotator/ui`'s HtmlViewer needs on either side of its own storage.
 *
 * - `buildPersistedHtmlAnchor` trims a composed comment's anchor into a
 *   bounded record a host can persist (target cap, byte budget).
 * - `projectHostThreads` projects stored host rows back onto the viewer's
 *   `annotations` prop shape, in the order that becomes the marker numbering.
 * - `parseHtmlElementAnchor` and `parseHtmlElementContext` are the pure,
 *   fail-closed validators both of those run on the way through.
 *
 * Browser-safe and dependency-free (this package is `@plannotator/core`).
 * The types below are structurally identical to `HtmlElementAnchor`,
 * `HtmlAnnotationTarget` and `HtmlElementContext` in `@plannotator/ui/types`,
 * and the caps here ARE the caps enforced at `@plannotator/ui`'s own parent
 * trust boundary (`components/html-viewer/useHtmlAnnotation.ts`), which
 * imports and re-exports these validators rather than keeping its own copy —
 * one definition, never mirrored — so nothing persisted here is ever refused
 * on read.
 */

export interface HtmlAnchorPoint {
  x: number;
  y: number;
}

export interface HtmlElementAnchor {
  selector: string;
  tagName: string;
  text?: string;
  point?: HtmlAnchorPoint;
}

export interface HtmlAnnotationTarget {
  label?: string;
  text: string;
  anchor?: HtmlElementAnchor;
  context?: HtmlElementContext;
}

export interface HtmlElementContext {
  tag: string;
  id?: string;
  /** Author classes, generated/hashed ones skipped; may end in "+N more". */
  classes?: string[];
  /** Ancestor path, e.g. `body > div#root > header.site-header > nav#site-nav`. */
  path?: string;
  /** Explicit `role` or the tag's implicit ARIA role. */
  role?: string;
  /** Accessible name: aria-label, aria-labelledby, alt, title, <label for>, own short text. */
  name?: string;
  /** Allowlisted attributes in a fixed order (href/src scrubbed of query and fragment). */
  attrs?: Array<[string, string]>;
  /** Rendered text (innerText), whitespace-collapsed, word-boundary truncated. */
  text?: string;
  /** Collapsed HTML skeleton: opening tag with allowlisted attributes, then children as bare tags. */
  outline?: string;
  /** Number of element children (after skipping script/style/template and viewer overlays). */
  children?: number;
  /** Viewport-relative bounding box plus the viewport it was seen at. */
  rect?: { x: number; y: number; w: number; h: number; vw: number; vh: number };
  /** Nearest enclosing landmark/region, e.g. `header.site-header "Primary"`. */
  landmark?: string;
  /** Nearest preceding heading, e.g. `h2 "Usage"`. */
  heading?: string;
  /** Nearest author component marker, e.g. `data-component=AppNav`. */
  component?: string;
  /** Live-app sessions only: the route the element was seen on and the page title. */
  page?: { url: string; title?: string };
}

/** Mirrors `MAX_ANCHOR_SELECTOR_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_SELECTOR_LENGTH = 1024;
/** Mirrors `MAX_ANCHOR_TAG_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_TAG_LENGTH = 64;
/** Mirrors `MAX_ANCHOR_TEXT_LENGTH` in `@plannotator/ui` (the 400-char snapshot). */
export const MAX_HTML_ANCHOR_TEXT_LENGTH = 400;
/** Mirrors `MAX_TARGET_LABEL_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_TARGET_LABEL_LENGTH = 64;
/**
 * Persisted bound for an additional target's display text: the anchor
 * snapshot bound, not the viewer's 10,000-char draft bound (a handful of
 * draft-sized texts alone would blow a 16 KiB anchor budget).
 */
export const MAX_HTML_TARGET_TEXT_LENGTH = 400;
/** Mirrors `MAX_ADDITIONAL_TARGETS` in `@plannotator/ui` (the draft cap). */
export const MAX_HTML_ADDITIONAL_TARGETS = 16;
/** Default byte budget for a persisted anchor (16 KiB of UTF-8 JSON). */
export const DEFAULT_HTML_ANCHOR_MAX_BYTES = 16 * 1024;
/** Serialized bound for one element context (2 KiB of UTF-8 JSON). */
export const MAX_ELEMENT_CONTEXT_BYTES = 2048;
/**
 * Cap for live-app page identity strings (mirrors the bridge's own slice).
 * The single definition: `@plannotator/ui`'s parent trust boundary imports
 * and re-exports it from here rather than keeping its own copy.
 */
export const MAX_PAGE_URL_LENGTH = 2048;
const MAX_CONTEXT_TAG_LENGTH = 32;
const MAX_CONTEXT_ID_LENGTH = 100;
const MAX_CONTEXT_CLASSES = 9; // 8 + the "+N more" marker
const MAX_CONTEXT_CLASS_LENGTH = 48;
const MAX_CONTEXT_PATH_LENGTH = 512;
const MAX_CONTEXT_ROLE_LENGTH = 32;
const MAX_CONTEXT_NAME_LENGTH = 120;
const MAX_CONTEXT_ATTRS = 10;
const MAX_CONTEXT_ATTR_NAME_LENGTH = 40;
const MAX_CONTEXT_ATTR_VALUE_LENGTH = 120;
const MAX_CONTEXT_TEXT_LENGTH = 300;
const MAX_CONTEXT_OUTLINE_LENGTH = 600;
const MAX_CONTEXT_OUTLINE_LINES = 40;
const MAX_CONTEXT_LANDMARK_LENGTH = 80;
const MAX_CONTEXT_HEADING_LENGTH = 130;
const MAX_CONTEXT_COMPONENT_LENGTH = 100;
const MAX_CONTEXT_PAGE_TITLE_LENGTH = 200;

/** Attribute names the context may carry (mirrors CONTEXT_ATTRS in the bridge). */
export const CONTEXT_ATTR_ALLOWLIST = new Set([
  "href", "src", "alt", "title", "type", "name", "role", "placeholder", "for", "target", "rel",
  "aria-label", "aria-labelledby", "aria-describedby", "aria-current", "aria-expanded", "aria-hidden", "aria-controls",
  "data-annotate", "data-testid", "data-test", "data-test-id", "data-cy", "data-qa", "data-component", "data-id",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Truncate to at most `max` UTF-16 units without splitting a surrogate pair
 * (a lone high surrogate becomes U+FFFD once UTF-8-encoded on the wire).
 */
export function truncateSurrogateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

function parseHtmlAnchorPoint(value: unknown): HtmlAnchorPoint | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/**
 * Validate a stored element anchor; `null` fails closed to text-only restore.
 * A malformed `point` is dropped without rejecting the anchor it rides on
 * (the marker then falls back to the element rect's center), the same
 * additive rule the viewer applies to bridge messages.
 */
export function parseHtmlElementAnchor(value: unknown): HtmlElementAnchor | null {
  if (!isRecord(value)) return null;
  const { selector, tagName, text } = value;
  if (
    typeof selector !== "string"
    || selector.length === 0
    || selector.length > MAX_HTML_ANCHOR_SELECTOR_LENGTH
    || typeof tagName !== "string"
    || tagName.length === 0
    || tagName.length > MAX_HTML_ANCHOR_TAG_LENGTH
  ) {
    return null;
  }
  const point = parseHtmlAnchorPoint(value.point);
  if (text === undefined) return { selector, tagName, ...(point ? { point } : {}) };
  if (typeof text !== "string" || text.length > MAX_HTML_ANCHOR_TEXT_LENGTH) return null;
  return { selector, tagName, text, ...(point ? { point } : {}) };
}

/** Collapse control characters and whitespace runs, then cap. */
function collapseContextScalar(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > max ? truncateSurrogateSafe(collapsed, max) : collapsed;
}

/** The outline keeps its line breaks (it is fenced on export) but nothing
 *  else: control characters go, each line is whitespace-collapsed, and a
 *  backtick run that could close the export's fence is defused. */
function collapseContextOutline(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value
    .replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, " ")
    .replace(/`{3,}/g, "'''")
    .split("\n")
    .map((line) => {
      // Keep the skeleton's indentation (capped), collapse everything else.
      const indent = (/^ */.exec(line)?.[0] ?? "").slice(0, 12);
      return indent + line.slice(indent.length).replace(/\s+/g, " ").trim();
    })
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_CONTEXT_OUTLINE_LINES);
  const joined = lines.join("\n").trim();
  if (!joined) return undefined;
  return joined.length > MAX_CONTEXT_OUTLINE_LENGTH ? truncateSurrogateSafe(joined, MAX_CONTEXT_OUTLINE_LENGTH) : joined;
}

function contextBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Validate a bridge-posted element context. Pure and fail-closed: returns
 * `undefined` if `value` is not a valid element context or tag is missing/empty.
 * Every scalar is re-collapsed (control characters and whitespace runs),
 * attributes are filtered to the allowlist, and unknown keys are dropped.
 * If the serialized context exceeds MAX_ELEMENT_CONTEXT_BYTES, expendable
 * fields are shed in order until it fits.
 */
export function parseHtmlElementContext(value: unknown): HtmlElementContext | undefined {
  if (!isRecord(value)) return undefined;
  const tag = collapseContextScalar(value.tag, MAX_CONTEXT_TAG_LENGTH);
  if (!tag) return undefined;
  const context: HtmlElementContext = { tag: tag.toLowerCase() };
  const id = collapseContextScalar(value.id, MAX_CONTEXT_ID_LENGTH);
  if (id) context.id = id;
  if (Array.isArray(value.classes)) {
    const classes: string[] = [];
    for (const entry of value.classes) {
      if (classes.length >= MAX_CONTEXT_CLASSES) break;
      const cls = collapseContextScalar(entry, MAX_CONTEXT_CLASS_LENGTH);
      if (cls) classes.push(cls);
    }
    if (classes.length) context.classes = classes;
  }
  const path = collapseContextScalar(value.path, MAX_CONTEXT_PATH_LENGTH);
  if (path) context.path = path;
  const role = collapseContextScalar(value.role, MAX_CONTEXT_ROLE_LENGTH);
  if (role) context.role = role;
  const name = collapseContextScalar(value.name, MAX_CONTEXT_NAME_LENGTH);
  if (name) context.name = name;
  if (Array.isArray(value.attrs)) {
    const attrs: Array<[string, string]> = [];
    for (const entry of value.attrs) {
      if (attrs.length >= MAX_CONTEXT_ATTRS) break;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const attrName = collapseContextScalar(entry[0], MAX_CONTEXT_ATTR_NAME_LENGTH);
      if (!attrName || !CONTEXT_ATTR_ALLOWLIST.has(attrName.toLowerCase())) continue;
      if (typeof entry[1] !== "string") continue;
      attrs.push([attrName.toLowerCase(), collapseContextScalar(entry[1], MAX_CONTEXT_ATTR_VALUE_LENGTH) ?? ""]);
    }
    if (attrs.length) context.attrs = attrs;
  }
  const text = collapseContextScalar(value.text, MAX_CONTEXT_TEXT_LENGTH);
  if (text) context.text = text;
  const outline = collapseContextOutline(value.outline);
  if (outline) context.outline = outline;
  if (typeof value.children === "number" && Number.isFinite(value.children) && value.children >= 0) {
    context.children = Math.min(100000, Math.floor(value.children));
  }
  if (isRecord(value.rect)) {
    const rect = value.rect;
    const nums = ["x", "y", "w", "h", "vw", "vh"].map((key) => {
      const n = rect[key];
      return typeof n === "number" && Number.isFinite(n) ? Math.round(Math.max(-1e6, Math.min(1e6, n))) : null;
    });
    if (nums.every((n) => n !== null)) {
      const [x, y, w, h, vw, vh] = nums as number[];
      context.rect = { x: x!, y: y!, w: w!, h: h!, vw: vw!, vh: vh! };
    }
  }
  const landmark = collapseContextScalar(value.landmark, MAX_CONTEXT_LANDMARK_LENGTH);
  if (landmark) context.landmark = landmark;
  const heading = collapseContextScalar(value.heading, MAX_CONTEXT_HEADING_LENGTH);
  if (heading) context.heading = heading;
  const component = collapseContextScalar(value.component, MAX_CONTEXT_COMPONENT_LENGTH);
  if (component) context.component = component;
  if (isRecord(value.page)) {
    const url = collapseContextScalar(value.page.url, MAX_PAGE_URL_LENGTH);
    if (url) {
      context.page = { url };
      const title = collapseContextScalar(value.page.title, MAX_CONTEXT_PAGE_TITLE_LENGTH);
      if (title) context.page.title = title;
    }
  }
  // Serialized bound: shed the expendable fields in the bridge's order until the whole fits.
  const shedOrder: Array<keyof HtmlElementContext> = ["outline", "text", "attrs", "classes", "path", "heading", "landmark", "component"];
  for (const field of shedOrder) {
    if (contextBytes(context) <= MAX_ELEMENT_CONTEXT_BYTES) break;
    delete context[field];
  }
  return contextBytes(context) <= MAX_ELEMENT_CONTEXT_BYTES ? context : undefined;
}

/**
 * Validate stored additional targets. A target needs its display text; a
 * broken per-target anchor or label is dropped, not fatal (the target still
 * lists in the composer and export; only its marker restore is lost). The
 * count is capped on read too: rows can come from arbitrary API clients, and
 * the viewer slices to its own cap before the bridge anyway.
 */
export function parseHtmlAdditionalTargets(
  value: unknown,
  maxTargets: number = MAX_HTML_ADDITIONAL_TARGETS,
): HtmlAnnotationTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: HtmlAnnotationTarget[] = [];
  for (const entry of value) {
    if (targets.length >= maxTargets) break;
    if (!isRecord(entry)) continue;
    const { label, text, anchor, context } = entry;
    if (typeof text !== "string" || text.length === 0) continue;
    const parsedAnchor = parseHtmlElementAnchor(anchor);
    const parsedContext = parseHtmlElementContext(context);
    const validLabel =
      typeof label === "string" && label.length > 0 && label.length <= MAX_HTML_TARGET_LABEL_LENGTH
        ? label
        : undefined;
    targets.push({
      ...(validLabel !== undefined ? { label: validLabel } : {}),
      text: truncateSurrogateSafe(text, MAX_HTML_TARGET_TEXT_LENGTH),
      ...(parsedAnchor !== null ? { anchor: parsedAnchor } : {}),
      ...(parsedContext !== undefined ? { context: parsedContext } : {}),
    });
  }
  return targets;
}

/** The anchor record a host persists for a raw-HTML comment: the legacy
 * text quote plus, additively, the durable element fields when the viewer
 * captured them. */
export interface PersistedHtmlAnchor {
  originalText: string;
  htmlAnchor?: HtmlElementAnchor;
  htmlAdditionalTargets?: HtmlAnnotationTarget[];
  elementContext?: HtmlElementContext;
}

export interface BuildPersistedHtmlAnchorOptions {
  /** Byte budget for the serialized (UTF-8 JSON) anchor. Default 16 KiB. */
  maxBytes?: number;
  /** Product cap on persisted additional targets. Default 16 (the viewer's draft cap). */
  maxTargets?: number;
}

export interface PersistedHtmlAnchorResult {
  anchor: PersistedHtmlAnchor;
  /** Every target not persisted: `capDroppedTargets + sizeDroppedTargets`. */
  droppedTargets: number;
  /** Targets dropped by `maxTargets` (reported against the product cap). */
  capDroppedTargets: number;
  /** Targets shed to keep the serialized anchor under `maxBytes` (a different reason, said separately). */
  sizeDroppedTargets: number;
}

function serializedAnchorBytes(anchor: PersistedHtmlAnchor): number {
  return new TextEncoder().encode(JSON.stringify(anchor)).length;
}

/**
 * The quote length below which the byte budget stops eating the quote and
 * starts shedding targets instead. A 400-unit prefix (the anchor-snapshot
 * bound) is still a solid text-search restore key and panel context line;
 * truncating past it to make room for targets would trade the row's primary
 * anchor text for its extras.
 */
const MIN_USEFUL_QUOTE_LENGTH = MAX_HTML_ANCHOR_TEXT_LENGTH;

/**
 * Build the anchor a host persists for a raw-HTML comment. Additive over the
 * legacy `{ originalText }` shape: a drag capture without an element anchor
 * writes exactly that shape, and an input already within every bound comes
 * back byte-identical. Enforces the persistence bounds:
 *
 * - `htmlAnchor` is validated by the same fail-closed parser the read path
 *   uses (never persist what would be refused on read back);
 * - additional targets are capped at `maxTargets` in draft order, the cap
 *   drop counted separately from the size drop so a host's notice never
 *   reports a size-driven drop as its product cap;
 * - the serialized anchor is kept under `maxBytes`: the quote (the elastic
 *   field) is truncated first, but only down to MIN_USEFUL_QUOTE_LENGTH;
 *   below that, targets are shed from the end before the quote gives up
 *   another character, so a size squeeze can never silently annihilate the
 *   quoted text while extras survive. Truncation is surrogate-safe and
 *   yields a PREFIX, so text-search restore still matches it.
 */
export function buildPersistedHtmlAnchor(
  source: {
    originalText: string;
    htmlAnchor?: HtmlElementAnchor | null;
    htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null;
    elementContext?: HtmlElementContext | null;
  },
  options: BuildPersistedHtmlAnchorOptions = {},
): PersistedHtmlAnchorResult {
  const maxBytes = options.maxBytes ?? DEFAULT_HTML_ANCHOR_MAX_BYTES;
  const maxTargets = options.maxTargets ?? MAX_HTML_ADDITIONAL_TARGETS;
  // Persist-side validation mirrors the read side: bounds and shape are
  // enforced on what is written, not only on what is later read back.
  const htmlAnchor = parseHtmlElementAnchor(source.htmlAnchor) ?? undefined;
  let elementContext = parseHtmlElementContext(source.elementContext);
  const drafted = source.htmlAdditionalTargets ?? [];
  // Kept-target key order is text, label, anchor, context: the order the reference
  // host implementation persisted, so a stored anchor's serialization (and
  // any fingerprint over it) does not change when a host adopts this helper.
  let kept = drafted.slice(0, Math.max(0, maxTargets)).map((target) => {
    const entry: HtmlAnnotationTarget = {
      text: truncateSurrogateSafe(target.text, MAX_HTML_TARGET_TEXT_LENGTH),
    };
    if (target.label !== undefined) {
      entry.label = truncateSurrogateSafe(target.label, MAX_HTML_TARGET_LABEL_LENGTH);
    }
    const targetAnchor = parseHtmlElementAnchor(target.anchor);
    if (targetAnchor !== null) entry.anchor = targetAnchor;
    const targetContext = parseHtmlElementContext(target.context);
    if (targetContext !== undefined) entry.context = targetContext;
    return entry;
  });
  const capDroppedTargets = drafted.length - kept.length;
  let originalText = source.originalText;

  const compose = (): PersistedHtmlAnchor => ({
    originalText,
    ...(htmlAnchor !== undefined ? { htmlAnchor } : {}),
    ...(kept.length > 0 ? { htmlAdditionalTargets: kept } : {}),
    ...(elementContext !== undefined ? { elementContext } : {}),
  });

  let anchor = compose();

  const truncateQuoteWhileOver = (floor: number): void => {
    while (serializedAnchorBytes(anchor) > maxBytes && originalText.length > floor) {
      const over = serializedAnchorBytes(anchor) - maxBytes;
      // Each removed UTF-16 unit frees at least one byte; remove in honest
      // chunks and re-measure (escaping and multi-byte make exact math
      // per-character; the loop converges in a handful of passes).
      const cut = Math.min(
        originalText.length - floor,
        Math.max(1, Math.ceil(over / 4)),
      );
      originalText = truncateSurrogateSafe(originalText, originalText.length - cut);
      anchor = compose();
    }
  };

  // Byte budget, exact over the serialized JSON, in four stages:
  // 1. Quote down to its useful floor.
  truncateQuoteWhileOver(Math.min(MIN_USEFUL_QUOTE_LENGTH, originalText.length));

  // 2. Shed contexts (per-target first from the end, then primary) before dropping targets.
  for (let i = kept.length - 1; i >= 0 && serializedAnchorBytes(anchor) > maxBytes; i--) {
    if (kept[i]?.context !== undefined) {
      const { context: _, ...rest } = kept[i]!;
      kept[i] = rest;
      anchor = compose();
    }
  }
  if (serializedAnchorBytes(anchor) > maxBytes && elementContext !== undefined) {
    elementContext = undefined;
    anchor = compose();
  }

  // 3. Targets from the end.
  while (serializedAnchorBytes(anchor) > maxBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    anchor = compose();
  }

  // 4. Rest of the quote (only reachable if the base anchor plus a floor-length quote alone
  // overflow, which validated bounds make unreachable with the default budget).
  truncateQuoteWhileOver(0);
  const sizeDroppedTargets =
    drafted.length - capDroppedTargets - (anchor.htmlAdditionalTargets?.length ?? 0);
  return {
    anchor,
    droppedTargets: capDroppedTargets + sizeDroppedTargets,
    capDroppedTargets,
    sizeDroppedTargets,
  };
}

/** One stored host row, in the host's own thread order. */
export interface HostThread {
  id: string;
  /** The quoted text; empty for element-only pinpoints and document-level notes. */
  originalText: string;
  htmlAnchor?: HtmlElementAnchor | null;
  htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null;
  /** Agent-facing element context for the primary target. */
  elementContext?: HtmlElementContext | null;
  /** Thread state. Absent means the host has no state concept: the row is open. */
  state?: "open" | "resolved" | string;
  /** Optional presentational fields carried verbatim onto the projection. */
  text?: string;
  author?: string;
  createdA?: number;
  images?: Array<{ path: string; name: string }>;
}

export interface ProjectHostThreadsOptions {
  /** Keep only rows whose `state` is `"open"` (or absent). Default false: every row projects. */
  openOnly?: boolean;
  /**
   * How a row with nothing restorable (no quoted text, no element anchor)
   * projects. `'global'` (default, Plannotator's model): a document-level
   * `GLOBAL_COMMENT`, rendered by the panel's global card grammar and never
   * reported as unanchored. `'unanchored'`: a page `COMMENT` with an empty
   * quote and no anchor, which the viewer's unanchored report then names
   * (the panel renders it with an empty quote line), for hosts that treat
   * such rows as comments that lost their place.
   */
  documentLevel?: 'global' | 'unanchored';
  /**
   * Read-side cap on additional targets per row. Default undefined: the
   * viewer's own 16 applies (rows from arbitrary API clients can carry
   * more; the viewer slices before the bridge anyway). A host with a
   * smaller persisted cap passes it so the projection matches its store.
   */
  maxTargets?: number;
}

/**
 * The viewer-facing annotation shape, structurally the `Annotation` of
 * `@plannotator/ui/types` restricted to what the raw-HTML surface reads:
 * paint fields (`originalText`, `htmlAnchor`, `htmlAdditionalTargets`), the
 * type that decides marker versus document-level card, and the optional
 * presentational fields. `@plannotator/ui` re-exports the projection typed
 * as `Annotation[]`.
 */
export interface ProjectedHostAnnotation {
  id: string;
  blockId: "";
  startOffset: 0;
  endOffset: 0;
  type: "COMMENT" | "GLOBAL_COMMENT";
  text?: string;
  originalText: string;
  createdA: number;
  author?: string;
  images?: Array<{ path: string; name: string }>;
  htmlAnchor?: HtmlElementAnchor;
  htmlAdditionalTargets?: HtmlAnnotationTarget[];
  elementContext?: HtmlElementContext;
}

/**
 * Project stored host rows onto the viewer's `annotations` prop. The OUTPUT
 * ORDER IS THE INPUT ORDER (minus filtered rows), and the viewer numbers
 * markers by array position, so pass rows in the order the host's panel
 * lists them and bubble N is card N.
 *
 * - A row with nothing restorable at all (no quoted text and no element
 *   anchor, e.g. an agent's document-level note) projects by
 *   `documentLevel`: `'global'` (default) makes it a `GLOBAL_COMMENT`, a
 *   document-level comment the panel renders without a quote line and the
 *   viewer never reports as unanchored; `'unanchored'` keeps it a page
 *   `COMMENT` with an empty quote, which the viewer's unanchored report
 *   names. An element anchor is a page location even without quoted text
 *   (a pinpoint on an image or chart), so such rows stay `COMMENT` in both
 *   modes; projecting them global would drop their marker and number.
 * - Anchors are validated fail-closed on the way through (a malformed stored
 *   anchor degrades to text-only restore, never a crash); additional targets
 *   validate per entry and cap at `maxTargets` (default: the viewer's 16).
 * - `openOnly` keeps rows whose `state` is `"open"` or absent, so resolved
 *   rows unpaint and give their number up.
 *
 * Pure: no clock, no randomness. `createdA` defaults to 0 when the row
 * carries none; hosts that sort by time supply it.
 */
export function projectHostThreads(
  threads: readonly HostThread[],
  options: ProjectHostThreadsOptions = {},
): ProjectedHostAnnotation[] {
  const out: ProjectedHostAnnotation[] = [];
  const documentLevel = options.documentLevel ?? "global";
  const maxTargets = options.maxTargets ?? MAX_HTML_ADDITIONAL_TARGETS;
  for (const thread of threads) {
    if (options.openOnly && thread.state !== undefined && thread.state !== "open") continue;
    const htmlAnchor = parseHtmlElementAnchor(thread.htmlAnchor);
    const htmlAdditionalTargets = parseHtmlAdditionalTargets(thread.htmlAdditionalTargets, maxTargets);
    const elementContext = parseHtmlElementContext(thread.elementContext);
    const originalText = typeof thread.originalText === "string" ? thread.originalText : "";
    const anchorless = originalText === "" && htmlAnchor === null;
    out.push({
      id: thread.id,
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: anchorless && documentLevel === "global" ? "GLOBAL_COMMENT" : "COMMENT",
      ...(thread.text !== undefined ? { text: thread.text } : {}),
      originalText,
      createdA: typeof thread.createdA === "number" && Number.isFinite(thread.createdA) ? thread.createdA : 0,
      ...(thread.author !== undefined ? { author: thread.author } : {}),
      ...(thread.images && thread.images.length > 0 ? { images: thread.images.map((image) => ({ ...image })) } : {}),
      ...(htmlAnchor !== null ? { htmlAnchor } : {}),
      ...(htmlAdditionalTargets.length > 0 ? { htmlAdditionalTargets } : {}),
      ...(elementContext !== undefined ? { elementContext } : {}),
    });
  }
  return out;
}

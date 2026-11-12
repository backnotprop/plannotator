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
  classes?: string[];
  path?: string;
  role?: string;
  name?: string;
  attrs?: Array<[string, string]>;
  text?: string;
  outline?: string;
  children?: number;
  rect?: { x: number; y: number; w: number; h: number; vw: number; vh: number };
  landmark?: string;
  heading?: string;
  component?: string;
  page?: { url: string; title?: string };
  sourceName?: string;
}

/** Mirrors `MAX_ANCHOR_SELECTOR_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_SELECTOR_LENGTH = 1024;
/** Mirrors `MAX_ANCHOR_TAG_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_TAG_LENGTH = 64;
/** Mirrors `MAX_ANCHOR_TEXT_LENGTH` in `@plannotator/ui` (the 400-char snapshot). */
export const MAX_HTML_ANCHOR_TEXT_LENGTH = 400;
/** Mirrors `MAX_TARGET_LABEL_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_TARGET_LABEL_LENGTH = 64;
export const MAX_HTML_TARGET_TEXT_LENGTH = 400;
/** Mirrors `MAX_ADDITIONAL_TARGETS` in `@plannotator/ui` (the draft cap). */
export const MAX_HTML_ADDITIONAL_TARGETS = 16;
/** Default byte budget for a persisted anchor (16 KiB of UTF-8 JSON). */
export const DEFAULT_HTML_ANCHOR_MAX_BYTES = 16 * 1024;
/** Serialized bound for one element context (2 KiB of UTF-8 JSON). */
export const MAX_ELEMENT_CONTEXT_BYTES = 2048;
/** Cap for live-app page identity strings (mirrors the bridge's own slice). */
export const MAX_PAGE_URL_LENGTH = 2048;
const MAX_CONTEXT_TAG_LENGTH = 32;
const MAX_CONTEXT_ID_LENGTH = 100;
const MAX_CONTEXT_CLASSES = 9;
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
const MAX_CONTEXT_SOURCE_NAME_LENGTH = 80;

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
 * Truncate to at most `max` UTF-16 units without splitting a surrogate pair (a lone high surrogate
 * becomes U+FFFD once UTF-8-encoded on the wire).
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

/** Validate a stored element anchor; `null` fails closed to text-only restore. */
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

function collapseContextScalar(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > max ? truncateSurrogateSafe(collapsed, max) : collapsed;
}

function collapseContextOutline(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value
    .replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, " ")
    .replace(/`{3,}/g, "'''")
    .split("\n")
    .map((line) => {
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
 * Fields an over-budget context sheds, first to last; mirrors `CTX_SHED_ORDER` in the bridge (a
 * test keeps the two in step).
 */
export const ELEMENT_CONTEXT_SHED_ORDER: ReadonlyArray<keyof HtmlElementContext> = [
  "outline", "text", "attrs", "classes", "path", "heading", "landmark", "component", "sourceName",
];

/** Validate a bridge-posted element context. */
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
  const sourceName = collapseContextScalar(value.sourceName, MAX_CONTEXT_SOURCE_NAME_LENGTH);
  if (sourceName) context.sourceName = sourceName;
  if (isRecord(value.page)) {
    const url = collapseContextScalar(value.page.url, MAX_PAGE_URL_LENGTH);
    if (url) {
      context.page = { url };
      const title = collapseContextScalar(value.page.title, MAX_CONTEXT_PAGE_TITLE_LENGTH);
      if (title) context.page.title = title;
    }
  }
  for (const field of ELEMENT_CONTEXT_SHED_ORDER) {
    if (contextBytes(context) <= MAX_ELEMENT_CONTEXT_BYTES) break;
    delete context[field];
  }
  return contextBytes(context) <= MAX_ELEMENT_CONTEXT_BYTES ? context : undefined;
}

/** Validate stored additional targets. */
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

/**
 * The anchor record a host persists for a raw-HTML comment: the legacy text quote plus, additively,
 * the durable element fields when the viewer captured them.
 */
export interface PersistedHtmlAnchor {
  originalText: string;
  htmlAnchor?: HtmlElementAnchor;
  htmlAdditionalTargets?: HtmlAnnotationTarget[];
  elementContext?: HtmlElementContext;
}

export interface BuildPersistedHtmlAnchorOptions {
  maxBytes?: number;
  maxTargets?: number;
}

export interface PersistedHtmlAnchorResult {
  anchor: PersistedHtmlAnchor;
  droppedTargets: number;
  capDroppedTargets: number;
  sizeDroppedTargets: number;
}

function serializedAnchorBytes(anchor: PersistedHtmlAnchor): number {
  return new TextEncoder().encode(JSON.stringify(anchor)).length;
}

const MIN_USEFUL_QUOTE_LENGTH = MAX_HTML_ANCHOR_TEXT_LENGTH;

/** Build the anchor a host persists for a raw-HTML comment. */
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
  const htmlAnchor = parseHtmlElementAnchor(source.htmlAnchor) ?? undefined;
  let elementContext = parseHtmlElementContext(source.elementContext);
  const drafted = source.htmlAdditionalTargets ?? [];
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
      const cut = Math.min(
        originalText.length - floor,
        Math.max(1, Math.ceil(over / 4)),
      );
      originalText = truncateSurrogateSafe(originalText, originalText.length - cut);
      anchor = compose();
    }
  };

  truncateQuoteWhileOver(Math.min(MIN_USEFUL_QUOTE_LENGTH, originalText.length));

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

  while (serializedAnchorBytes(anchor) > maxBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    anchor = compose();
  }

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
  originalText: string;
  htmlAnchor?: HtmlElementAnchor | null;
  htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null;
  elementContext?: HtmlElementContext | null;
  state?: "open" | "resolved" | string;
  text?: string;
  author?: string;
  createdA?: number;
  images?: Array<{ path: string; name: string }>;
}

export interface ProjectHostThreadsOptions {
  openOnly?: boolean;
  documentLevel?: 'global' | 'unanchored';
  maxTargets?: number;
}

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
 * Project stored host rows onto the viewer's `annotations` prop. Output order is input order and the
 * viewer numbers markers by array position, so pass rows in the panel's order.
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

/**
 * Shape: the format of a board an agent draws, and the rules on it.
 *
 * A shape is one thing being worked out with one agent session. Each time the
 * agent draws it, the store keeps a full snapshot: a version. A version holds
 * four views (Picture, How it works, Requirements, Code), the numbered
 * references the views cite, and the parts the person can point at.
 *
 * Browser-safe and dependency-free: the store (packages/shared/shape), the
 * CLI and the board's UI (packages/ui/components/shape) all read it.
 *
 *  - `checkShapeBoard` validates what an agent writes (`plannotator shape
 *    update --file`) and names the exact field that is wrong.
 *  - `shapeParts` lists the parts of a board: every `data-mark` of a drawn
 *    view, every requirement, every Code step, the title and the claim. Ids
 *    stay the same across versions, which is what lets the board redraw only
 *    what changed.
 *  - `diffShapeVersions` compares two snapshots by those ids ("what changed
 *    since you looked"). The agent never writes what changed; it is worked
 *    out here.
 *
 * Spec: the approved Shape design record ("shape-living-board"), sections 3 and 4.
 */
import type { CodeGuideOutput } from './guide';
import { ulid } from './ulid';

export const SHAPE_FORMAT_VERSION = 1;

export type ShapeViewId = 'picture' | 'how' | 'reqs' | 'code';

/** The four views, in the dock's order. Their labels are the product's words. */
export const SHAPE_VIEWS: readonly { id: ShapeViewId; label: string }[] = [
  { id: 'picture', label: 'Picture' },
  { id: 'how', label: 'How it works' },
  { id: 'reqs', label: 'Requirements' },
  { id: 'code', label: 'Code' },
];

export function shapeViewLabel(view: ShapeViewId): string {
  return SHAPE_VIEWS.find((v) => v.id === view)?.label ?? view;
}

// ───────────────────────────── the board an agent writes ─────────────────────────────

/**
 * A drawn view (Picture, How it works): HTML and inline SVG the agent writes,
 * drawn in its own style scope.
 *
 *  - `data-step="N"`: parts with the same N arrive together, in number order.
 *    A `path` or `line` with `class="draw"` and `pathLength="1"` draws on.
 *  - `data-mark="id"`: a part the person can point at (Change it / Ask). Keep
 *    the id across versions for the same part.
 *  - `data-ref="n"`: an empty element that becomes reference bubble n.
 *  - Colours come from the frame's variables (`--ink`, `--paper`, `--mark`,
 *    `--grey`, `--rule`), so light and dark both work.
 */
export interface ShapeDrawnView {
  html: string;
  /** Rules for this view only (scoped to it). No `@import`, no outside `url()`. */
  css?: string;
  /**
   * A fixed canvas, in CSS pixels, that the board scales to fit. Absent: the
   * HTML flows like a page.
   */
  width?: number;
  height?: number;
  /** A stacked drawing for a narrow board (a phone), shown below 700 px. */
  tall?: { html: string; css?: string };
}

export interface ShapeRequirement {
  /** Stable across versions. */
  id: string;
  /** One terse line. Inline Markdown: links, `code`, **bold**, and `[^n]` for reference n. */
  text: string;
  /** Where it is built, for "open the code at this line". */
  code?: { path: string; line: number };
}

export interface ShapeRequirementGroup {
  id: string;
  /** "Who gets it", "When it shows"… in reading order. */
  label: string;
  items: ShapeRequirement[];
}

export interface ShapeRequirements {
  /** The line over the groups. */
  heading?: string;
  groups: ShapeRequirementGroup[];
  /** Short labelled lines at the foot (Open, Next). Inline Markdown. */
  foot?: { label: string; text: string }[];
}

/** One file a Code step plans to add or change, before the change exists. */
export interface ShapePlannedFile {
  path: string;
  kind: 'new' | 'change';
}

/**
 * The Code view: a Guided Review (the guide format the review app's guides use).
 * After implementation, `patch` is the real diff and each step lists the files
 * it changed. Before, the steps list the files they plan (`planned`), and a
 * `patch` holds only proposed diffs, which the board marks as not applied.
 */
export interface ShapeCodeView {
  stage: 'before' | 'after';
  guide: CodeGuideOutput;
  patch?: string;
  /** Before implementation: per step, the files it will add or change. */
  planned?: ShapePlannedFile[][];
  /** The provenance line under the guide's title. Inline Markdown. */
  source?: string;
  /** Files the whole-file viewer may open, each at a line. The host reads them. */
  files?: { path: string; line?: number }[];
}

export type ShapeRefKind = 'message' | 'image' | 'file' | 'pr' | 'diff' | 'link';
export const SHAPE_REF_KINDS: readonly ShapeRefKind[] = ['message', 'image', 'file', 'pr', 'diff', 'link'];

/**
 * A numbered reference: the views cite it as bubble `n`, and the References
 * list opens it in the real viewer.
 *
 *  - message: `target` is a thread message id (opens in the Thread tab).
 *  - image: `target` is the image (a file the store keeps, under `files/`); `images` steps through several.
 *  - file: `target` is a path in the project; `line` opens it there.
 *  - pr, link: `target` is the URL.
 *  - diff: `target` is a file path in the Code view's patch.
 */
export interface ShapeRef {
  n: number;
  kind: ShapeRefKind;
  title: string;
  sub?: string;
  target: string;
  line?: number;
  images?: { src: string; alt: string }[];
}

/** What an agent writes: one whole board. */
export interface ShapeBoard {
  title: string;
  /** One line: where it stands, and whether anything waits on the person. Inline Markdown. */
  claim: string;
  /** When the facts were current (ISO 8601). */
  asOf?: string;
  /** The agent's one line about this version. */
  note?: string;
  views: {
    picture?: ShapeDrawnView;
    how?: ShapeDrawnView;
    reqs?: ShapeRequirements;
    code?: ShapeCodeView;
  };
  refs?: ShapeRef[];
}

// ───────────────────────────── what the store keeps ─────────────────────────────

/** Where a part lives: a view, or the header (title, claim). */
export type ShapePartView = ShapeViewId | 'header';

export interface ShapePart {
  view: ShapePartView;
  id: string;
  /** Its words, whitespace folded. What a change is compared on. */
  text: string;
}

export interface ShapeSession {
  host: string;
  id: string;
}

/** One stored snapshot. */
export interface ShapeVersion extends ShapeBoard {
  n: number;
  at: string;
  /** The version the agent started from (null for the first). */
  base: number | null;
  /** The last thread message this version took in (Inbox shapes). */
  through: string | null;
  by: ShapeSession | null;
  parts: ShapePart[];
}

export type ShapeState = 'active' | 'finished';

/** `shape.json`: the shape itself. */
export interface ShapeRecord {
  v: typeof SHAPE_FORMAT_VERSION;
  id: string;
  title: string;
  project: { name: string; root: string };
  session: ShapeSession | null;
  /** The Inbox thread it hangs off (`msg_…`), or null for a standalone shape. */
  thread: string | null;
  state: ShapeState;
  created: string;
  updated: string;
  latest: number;
  /** The agent said it is drawing: until the next version, or `until`. */
  drawing: { at: string; until: string } | null;
}

export type ShapeNoteKind = 'change' | 'ask' | 'answer';

/**
 * A line of a shape's chat: the person's Change it and Ask, and the agent's
 * answers. A note with no `part` is on the whole board (`view` null) or on a
 * whole view: a general comment.
 */
export interface ShapeNote {
  id: string;
  at: string;
  kind: ShapeNoteKind;
  /** The version it was written on. */
  v: number;
  view: ShapeViewId | null;
  part: string | null;
  /** The marked words, as shown. */
  quote: string | null;
  text: string;
  /** `you`, or the agent session that answered. */
  from: 'you' | ShapeSession;
  /** An answer's question or change. */
  re: string | null;
  /** When an agent picked it up (`shape read`); null while it waits. */
  delivered: string | null;
}

/** A Change it that no agent has picked up: "1 change waits for the agent". */
export function shapeNoteWaits(note: ShapeNote): boolean {
  return note.kind === 'change' && note.from === 'you' && !note.delivered;
}

// ───────────────────────────── ids ─────────────────────────────

const SHAPE_ID_RE = /^shp_[0-9A-HJKMNP-TV-Z]{26}$/;
const NOTE_ID_RE = /^shn_[0-9A-HJKMNP-TV-Z]{26}$/;

export function shapeId(now?: number): string {
  return `shp_${ulid(now)}`;
}

export function shapeNoteId(now?: number): string {
  return `shn_${ulid(now)}`;
}

export function isShapeId(value: unknown): value is string {
  return typeof value === 'string' && SHAPE_ID_RE.test(value);
}

export function isShapeNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID_RE.test(value);
}

// ───────────────────────────── limits ─────────────────────────────

/** The most a board may hold. A refusal names the field and the limit. */
export const SHAPE_LIMITS = {
  title: 140,
  claim: 400,
  note: 280,
  html: 300_000,
  css: 60_000,
  canvas: { min: 200, max: 4000 },
  groups: 12,
  items: 40,
  line: 400,
  sections: 20,
  patch: 3_000_000,
  files: 100,
  refs: 60,
  refN: 999,
  refText: 300,
  target: 2000,
  images: 12,
  noteText: 4000,
  quote: 600,
} as const;

const PART_ID_RE = /^[A-Za-z][\w.-]{0,63}$/;

// ───────────────────────────── validation ─────────────────────────────

export type ShapeCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ─── what a drawing may load: only what the board holds ───
//
// One allowlist, used twice: here on the store side, so the agent hears at
// once which field is wrong, and by the board's sanitizer when it draws.

/**
 * Tags a drawing may not hold. `animate` and `set` can rewrite an href after
 * the sanitizer; `dialog` and `select` (its picker) open in the top layer,
 * over the whole app, past the frame's containment and clip.
 */
// `area` and `map`: an image map's `<area href>` is a link the board's guard would have to know too; a drawing has `<a>`.
const FORBIDDEN_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'form', 'style', 'template', 'portal', 'source', 'animate', 'set', 'animatemotion', 'animatetransform', 'dialog', 'select', 'area', 'map'];
export const SHAPE_FORBIDDEN_TAGS: readonly string[] = FORBIDDEN_TAGS;

/** Attributes that lift a part into the top layer (a popover, a modal), over the app: dropped. */
export const SHAPE_TOP_LAYER_ATTRS: readonly string[] = ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor', 'interestfor', 'interesttarget'];

/** Attributes that load something and have no safe use on a board: dropped. */
export const SHAPE_DROPPED_ATTRS: readonly string[] = ['srcset', 'imagesrcset', 'poster', 'ping', 'lowsrc', 'dynsrc', 'longdesc'];

/** Attributes that hold a URL: each must pass `shapeUrlAllowed`. */
export const SHAPE_URL_ATTRS: readonly string[] = ['src', 'href', 'xlink:href', 'action', 'formaction', 'background', 'data', 'cite', 'codebase', 'manifest', 'icon', 'usemap', 'profile', 'archive', 'classid'];

/** A URL as a URL parser reads it: the parser drops tabs and newlines anywhere, so `ht\ttps:` is `https:`. */
function urlKey(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
}

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;
/** A file the board keeps: `files/<name>`, one name (the store's own rule: no folder, no dot first) and no escapes. */
const BOARD_FILE_RE = /^files\/[^/\\%?#.][^/\\%?#]*$/;

/**
 * May a drawing's URL attribute hold this value? Only what the board holds:
 * `files/<name>`, `#fragment`, or a `data:image/` PNG, JPEG, GIF or WebP. A
 * link (`<a href>`) may also point out, over https. Anything else (another
 * scheme, `//host`, `\\host`, `https:host`, a path) is refused.
 */
export function shapeUrlAllowed(value: string, link = false): boolean {
  const key = urlKey(value);
  if (key.startsWith('#') || DATA_IMAGE_RE.test(key) || BOARD_FILE_RE.test(key)) return true;
  if (!link || !key.startsWith('https://')) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

/**
 * A reference's URL as the board opens it: http(s) with a host, else null.
 * The store checks this too; the board checks again where it opens one,
 * since a host can hand it a board from anywhere.
 */
export function shapeLinkUrl(target: string): string | null {
  if (!/^https?:\/\//.test(urlKey(target))) return null;
  try {
    const url = new URL(target.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

function codePoint(hex: string): string {
  const n = parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
}

/**
 * CSS without its comments. A `/*` inside a string is text, not a comment,
 * so strings are stepped over (with their escapes) while comments go.
 */
function stripCssComments(css: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === '\\') {
      out += css.slice(i, i + 2);
      i++;
    } else if (quote) {
      out += ch;
      if (ch === quote || ch === '\n') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else out += ch;
  }
  return out;
}

/**
 * CSS as its tokenizer reads it: escapes read (`u\72l(` is `url(`), lower
 * case, and comments gone outside strings. `keepComments` reads it with them
 * left in, a second look the checks also take, so no comment reading of ours
 * can hide a url.
 */
function cssKey(css: string, keepComments = false): string {
  return (keepComments ? css : stripCssComments(css))
    .replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g, (_, hex?: string, _nl?: string, ch?: string) =>
      hex ? codePoint(hex) : ch ?? '',
    )
    .toLowerCase();
}

/** The values a CSS text hands to `url(…)`, read as a URL parser reads them. */
function cssUrls(key: string): string[] {
  return [...key.matchAll(/url\s*\(\s*["']?([^)"']*)/g)].map((m) => urlKey(m[1] ?? ''));
}

/**
 * What a view's CSS (or a `style` attribute) may not hold: imports, fonts,
 * scripted CSS and anything that loads from outside. `url()` may name only a
 * `#fragment` or a data:image. Escapes and comments are read first.
 */
export function shapeCssProblems(css: string): string[] {
  const out: string[] = [];
  const keys = [cssKey(css), cssKey(css, true)];
  const any = (test: (key: string) => boolean) => keys.some(test);
  if (any((k) => /@import/.test(k))) out.push('@import is not allowed');
  if (any((k) => /@font-face/.test(k))) out.push('@font-face is not allowed');
  if (any((k) => /image-set\s*\(/.test(k))) out.push('image-set() is not allowed; use url() with a data:image');
  if (any((k) => /(?:^|[^\w-])src\s*\(/.test(k))) out.push('src() is not allowed; use url() with a data:image');
  if (any((k) => cssUrls(k).some((u) => !u.startsWith('#') && !DATA_IMAGE_RE.test(u)))) out.push('url() may name only a #fragment or a data:image (png, jpeg, gif, webp)');
  if (any((k) => /expression\s*\(|-moz-binding|behavior\s*:/.test(k))) out.push('scripted CSS is not allowed');
  // A customizable select's picker opens in the top layer, over the app.
  if (any((k) => /base-select|::?picker\s*\(/.test(k))) out.push('a select picker (base-select, ::picker) is not allowed');
  if (/<\/style/i.test(css)) out.push('</style> is not allowed');
  return out;
}

/**
 * A presentation attribute (`fill`, `mask`, `filter`, `clip-path`,
 * `marker-*`…) may use `url(#id)` and nothing else that loads.
 */
export function shapePaintAllowed(value: string): boolean {
  return [cssKey(value), cssKey(value, true)].every(
    (key) => !/image-set\s*\(|(?:^|[^\w-])src\s*\(/.test(key) && cssUrls(key).every((u) => u.startsWith('#')),
  );
}

/** Attributes that only ever hold words. */
const TEXT_ATTRS = new Set(['title', 'alt', 'class', 'id', 'role', 'lang', 'dir']);

const TAG_RE = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * What a drawn view's HTML may not hold: scripts, event handlers, and anything
 * that loads from outside the board. The board sanitizes again when it draws;
 * this refusal tells the agent at once, by field.
 */
export function shapeHtmlProblems(html: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  const lower = html.toLowerCase();
  for (const tag of FORBIDDEN_TAGS) {
    if (new RegExp(`<${tag}[\\s>/]`).test(lower)) {
      add(
        tag === 'style'
          ? '<style> is not allowed here; put rules in the view\'s css'
          : tag === 'dialog' || tag === 'select'
            ? `<${tag}> is not allowed (it opens over the whole app); draw it`
            : `<${tag}> is not allowed`,
      );
    }
  }
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) add('event handler attributes (on…=) are not allowed');
  if (/javascript\s*:/i.test(html)) add('javascript: URLs are not allowed');
  for (const t of html.matchAll(TAG_RE)) {
    const tag = t[1]!.toLowerCase();
    const attrs = [...(t[2] ?? '').matchAll(ATTR_RE)].map((a) => ({ name: a[1]!.toLowerCase(), raw: a[2] ?? a[3] ?? a[4] ?? '' }));
    if (tag === 'input' && attrs.some((a) => a.name === 'type' && decodeEntities(a.raw).trim().toLowerCase() === 'image')) add('<input type="image"> is not allowed');
    for (const { name, raw } of attrs) {
      if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('on') || TEXT_ATTRS.has(name)) continue;
      const value = decodeEntities(raw);
      const shown = value.slice(0, 80);
      const checked = name === 'style' || SHAPE_URL_ATTRS.includes(name) || /url|image-set|src|\\/i.test(value);
      // A named character reference this check cannot read (`&colon;`) could hide a scheme or a `(`.
      if (checked && /&[a-z][a-z0-9]*;/i.test(value)) {
        add(`${tag} ${name}: write characters plainly, not as named references like &colon;`);
        continue;
      }
      if (SHAPE_TOP_LAYER_ATTRS.includes(name)) add(`${name} is not allowed (it lifts a part over the whole app)`);
      else if (SHAPE_DROPPED_ATTRS.includes(name)) add(`${name} is not allowed (it loads from outside the board); use one src`);
      else if (SHAPE_URL_ATTRS.includes(name)) {
        const link = tag === 'a' && (name === 'href' || name === 'xlink:href');
        if (!shapeUrlAllowed(value, link)) {
          add(`<${tag} ${name}="${shown}">: nothing may load from outside the board; use files/<name>, #id or a data:image${link ? ' (a link may be https://)' : ''}`);
        }
      } else if (name === 'style') {
        for (const p of shapeCssProblems(value)) add(`<${tag} style>: ${p}`);
      } else if (!shapePaintAllowed(value)) add(`<${tag} ${name}="${shown}">: only url(#id) is allowed here`);
    }
  }
  for (const m of html.matchAll(/\sdata-code\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = m[1] ?? m[2] ?? '';
    if (!parseShapeCodeTarget(value)) add(`data-code="${value.slice(0, 80)}" is not a file and line in the project (write path#L42)`);
  }
  return out;
}

/**
 * A path in the project, relative to its root: `src/a.ts`. Not absolute
 * (`/x`, `C:/x`, `~/x`), no `.` or `..` part, no backslash (a UNC path or a
 * Windows `..\`), no `%` escape, no URL scheme and no control character.
 */
export function isShapeProjectPath(path: string): boolean {
  if (!path || path.length > 500 || path !== path.trim()) return false;
  if (/[\u0000-\u001f\u007f\\%]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const PROJECT_PATH_RULE = 'must be a path in the project, relative to its root (src/a.ts): no leading / or ~, no drive or scheme, no . or .. part, no backslash or %';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  errors: string[] = [];
  fail(field: string, message: string) {
    this.errors.push(`${field}: ${message}`);
  }
  text(value: unknown, field: string, max: number, required = true): string | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(field, 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.fail(field, 'must be a string');
      return undefined;
    }
    if (required && !value.trim()) {
      this.fail(field, 'is empty');
      return undefined;
    }
    if (value.length > max) {
      this.fail(field, `is ${value.length} characters; at most ${max}`);
      return undefined;
    }
    return value;
  }
  int(value: unknown, field: string, min: number, max: number, required = true): number | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(field, 'is required');
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(field, `must be a whole number from ${min} to ${max}`);
      return undefined;
    }
    return value;
  }
  list(value: unknown, field: string, max: number): unknown[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      this.fail(field, 'must be a list');
      return undefined;
    }
    if (value.length > max) {
      this.fail(field, `has ${value.length} entries; at most ${max}`);
      return undefined;
    }
    return value;
  }
  /** A path in the project (`isShapeProjectPath`). */
  path(value: unknown, field: string): string | undefined {
    const path = this.text(value, field, 500);
    if (path === undefined) return undefined;
    if (!isShapeProjectPath(path)) {
      this.fail(field, `"${path.slice(0, 80)}" ${PROJECT_PATH_RULE}`);
      return undefined;
    }
    return path;
  }
  id(value: unknown, field: string): string | undefined {
    if (typeof value !== 'string' || !PART_ID_RE.test(value)) {
      this.fail(field, 'must be an id: a letter, then letters, digits, ".", "_" or "-" (at most 64)');
      return undefined;
    }
    return value;
  }
}

function checkDrawn(c: Checker, value: unknown, field: string): ShapeDrawnView | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with html');
    return undefined;
  }
  const html = c.text(value.html, `${field}.html`, SHAPE_LIMITS.html);
  if (html !== undefined) for (const p of shapeHtmlProblems(html)) c.fail(`${field}.html`, p);
  const css = c.text(value.css, `${field}.css`, SHAPE_LIMITS.css, false);
  if (css !== undefined) for (const p of shapeCssProblems(css)) c.fail(`${field}.css`, p);
  const width = c.int(value.width, `${field}.width`, SHAPE_LIMITS.canvas.min, SHAPE_LIMITS.canvas.max, false);
  const height = c.int(value.height, `${field}.height`, SHAPE_LIMITS.canvas.min, SHAPE_LIMITS.canvas.max, false);
  if ((width === undefined) !== (height === undefined) && !c.errors.some((e) => e.startsWith(`${field}.width`) || e.startsWith(`${field}.height`))) {
    c.fail(field, 'width and height go together (a fixed canvas), or neither');
  }
  let tall: ShapeDrawnView['tall'];
  if (value.tall !== undefined && value.tall !== null) {
    if (!isRecord(value.tall)) c.fail(`${field}.tall`, 'must be an object with html');
    else {
      const th = c.text(value.tall.html, `${field}.tall.html`, SHAPE_LIMITS.html);
      if (th !== undefined) for (const p of shapeHtmlProblems(th)) c.fail(`${field}.tall.html`, p);
      const tc = c.text(value.tall.css, `${field}.tall.css`, SHAPE_LIMITS.css, false);
      if (tc !== undefined) for (const p of shapeCssProblems(tc)) c.fail(`${field}.tall.css`, p);
      if (th !== undefined) tall = { html: th, ...(tc ? { css: tc } : {}) };
    }
  }
  if (html === undefined) return undefined;
  return {
    html,
    ...(css ? { css } : {}),
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
    ...(tall ? { tall } : {}),
  };
}

function checkReqs(c: Checker, value: unknown, field: string): ShapeRequirements | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with groups');
    return undefined;
  }
  const heading = c.text(value.heading, `${field}.heading`, SHAPE_LIMITS.line, false);
  const groups = c.list(value.groups, `${field}.groups`, SHAPE_LIMITS.groups);
  if (!groups) {
    if (value.groups === undefined) c.fail(`${field}.groups`, 'is required');
    return undefined;
  }
  const ids = new Set<string>();
  const out: ShapeRequirementGroup[] = [];
  groups.forEach((g, gi) => {
    const gf = `${field}.groups[${gi}]`;
    if (!isRecord(g)) return c.fail(gf, 'must be an object');
    const id = c.id(g.id, `${gf}.id`);
    const label = c.text(g.label, `${gf}.label`, 80);
    const items = c.list(g.items, `${gf}.items`, SHAPE_LIMITS.items) ?? [];
    if (g.items === undefined) c.fail(`${gf}.items`, 'is required');
    const rows: ShapeRequirement[] = [];
    items.forEach((it, ii) => {
      const f = `${gf}.items[${ii}]`;
      if (!isRecord(it)) return c.fail(f, 'must be an object');
      const iid = c.id(it.id, `${f}.id`);
      if (iid && ids.has(iid)) c.fail(`${f}.id`, `"${iid}" is used twice`);
      if (iid) ids.add(iid);
      const text = c.text(it.text, `${f}.text`, SHAPE_LIMITS.line);
      let code: ShapeRequirement['code'];
      if (it.code !== undefined && it.code !== null) {
        if (!isRecord(it.code)) c.fail(`${f}.code`, 'must be { path, line }');
        else {
          const path = c.path(it.code.path, `${f}.code.path`);
          const line = c.int(it.code.line, `${f}.code.line`, 1, 10_000_000);
          if (path && line) code = { path, line };
        }
      }
      if (iid && text) rows.push({ id: iid, text, ...(code ? { code } : {}) });
    });
    if (id && label) out.push({ id, label, items: rows });
  });
  let foot: ShapeRequirements['foot'];
  const feet = c.list(value.foot, `${field}.foot`, 6);
  if (feet) {
    foot = [];
    feet.forEach((f, i) => {
      if (!isRecord(f)) return c.fail(`${field}.foot[${i}]`, 'must be { label, text }');
      const label = c.text(f.label, `${field}.foot[${i}].label`, 24);
      const text = c.text(f.text, `${field}.foot[${i}].text`, SHAPE_LIMITS.line);
      if (label && text) foot!.push({ label, text });
    });
  }
  return { ...(heading ? { heading } : {}), groups: out, ...(foot?.length ? { foot } : {}) };
}

function checkCode(c: Checker, value: unknown, field: string): ShapeCodeView | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with stage and guide');
    return undefined;
  }
  const stage = value.stage === 'before' || value.stage === 'after' ? value.stage : undefined;
  if (!stage) c.fail(`${field}.stage`, 'must be "before" or "after"');
  const g = value.guide;
  let guide: CodeGuideOutput | undefined;
  if (!isRecord(g)) c.fail(`${field}.guide`, 'must be a guide: { title, intent, sections }');
  else {
    const title = c.text(g.title, `${field}.guide.title`, 200);
    const intent = c.text(g.intent, `${field}.guide.intent`, 1000, false) ?? '';
    const sections = c.list(g.sections, `${field}.guide.sections`, SHAPE_LIMITS.sections);
    if (g.sections === undefined) c.fail(`${field}.guide.sections`, 'is required');
    const outSections: CodeGuideOutput['sections'] = [];
    (sections ?? []).forEach((s, i) => {
      const f = `${field}.guide.sections[${i}]`;
      if (!isRecord(s)) return c.fail(f, 'must be { title, overview, diffs }');
      const st = c.text(s.title, `${f}.title`, 200);
      const ov = c.text(s.overview, `${f}.overview`, 8000, false) ?? '';
      const diffs = c.list(s.diffs, `${f}.diffs`, SHAPE_LIMITS.files) ?? [];
      const outDiffs: CodeGuideOutput['sections'][number]['diffs'] = [];
      diffs.forEach((d, j) => {
        if (!isRecord(d)) return c.fail(`${f}.diffs[${j}]`, 'must be { file, summary }');
        const file = c.path(d.file, `${f}.diffs[${j}].file`);
        const summary = c.text(d.summary, `${f}.diffs[${j}].summary`, 600, false);
        if (file) outDiffs.push({ file, ...(summary ? { summary } : {}) });
      });
      if (st) outSections.push({ title: st, overview: ov, diffs: outDiffs });
    });
    const unplaced = c.list(g.unplacedFiles, `${field}.guide.unplacedFiles`, 500);
    const unplacedFiles = unplaced?.filter((p, i): p is string => typeof p === 'string' && c.path(p, `${field}.guide.unplacedFiles[${i}]`) !== undefined);
    if (title) guide = { title, intent, sections: outSections, ...(unplacedFiles?.length ? { unplacedFiles } : {}) };
  }
  const patch = c.text(value.patch, `${field}.patch`, SHAPE_LIMITS.patch, false);
  let planned: ShapePlannedFile[][] | undefined;
  const pl = c.list(value.planned, `${field}.planned`, SHAPE_LIMITS.sections);
  if (pl) {
    planned = pl.map((step, i) => {
      const files = c.list(step, `${field}.planned[${i}]`, SHAPE_LIMITS.files) ?? [];
      return files.flatMap((f, j) => {
        const ff = `${field}.planned[${i}][${j}]`;
        if (!isRecord(f)) {
          c.fail(ff, 'must be { path, kind }');
          return [];
        }
        const path = c.path(f.path, `${ff}.path`);
        if (f.kind !== 'new' && f.kind !== 'change') c.fail(`${ff}.kind`, 'must be "new" or "change"');
        return path && (f.kind === 'new' || f.kind === 'change') ? [{ path, kind: f.kind }] : [];
      });
    });
  }
  const source = c.text(value.source, `${field}.source`, SHAPE_LIMITS.line, false);
  let files: ShapeCodeView['files'];
  const fl = c.list(value.files, `${field}.files`, SHAPE_LIMITS.files);
  if (fl) {
    files = fl.flatMap((f, i) => {
      if (!isRecord(f)) {
        c.fail(`${field}.files[${i}]`, 'must be { path, line? }');
        return [];
      }
      const path = c.path(f.path, `${field}.files[${i}].path`);
      const line = c.int(f.line, `${field}.files[${i}].line`, 1, 10_000_000, false);
      return path ? [{ path, ...(line ? { line } : {}) }] : [];
    });
  }
  if (!stage || !guide) return undefined;
  return {
    stage,
    guide,
    ...(patch ? { patch } : {}),
    ...(planned ? { planned } : {}),
    ...(source ? { source } : {}),
    ...(files?.length ? { files } : {}),
  };
}

function checkRefs(c: Checker, value: unknown): ShapeRef[] | undefined {
  const refs = c.list(value, 'refs', SHAPE_LIMITS.refs);
  if (!refs) return undefined;
  const seen = new Set<number>();
  const out: ShapeRef[] = [];
  refs.forEach((r, i) => {
    const f = `refs[${i}]`;
    if (!isRecord(r)) return c.fail(f, 'must be an object');
    const n = c.int(r.n, `${f}.n`, 1, SHAPE_LIMITS.refN);
    if (n !== undefined && seen.has(n)) c.fail(`${f}.n`, `${n} is used twice`);
    if (n !== undefined) seen.add(n);
    const kind = SHAPE_REF_KINDS.includes(r.kind as ShapeRefKind) ? (r.kind as ShapeRefKind) : undefined;
    if (!kind) c.fail(`${f}.kind`, `must be one of ${SHAPE_REF_KINDS.join(', ')}`);
    const title = c.text(r.title, `${f}.title`, SHAPE_LIMITS.refText);
    const sub = c.text(r.sub, `${f}.sub`, SHAPE_LIMITS.refText, false);
    const target = c.text(r.target, `${f}.target`, SHAPE_LIMITS.target);
    if (target && (kind === 'pr' || kind === 'link') && !shapeLinkUrl(target)) c.fail(`${f}.target`, 'must be an http(s) URL');
    if (target && /^\s*javascript:/i.test(target)) c.fail(`${f}.target`, 'javascript: is not allowed');
    if (target && (kind === 'file' || kind === 'diff') && !isShapeProjectPath(target)) c.fail(`${f}.target`, `"${target.slice(0, 80)}" ${PROJECT_PATH_RULE}`);
    const line = c.int(r.line, `${f}.line`, 1, 10_000_000, false);
    let images: ShapeRef['images'];
    const imgs = c.list(r.images, `${f}.images`, SHAPE_LIMITS.images);
    if (imgs) {
      images = imgs.flatMap((im, j) => {
        if (!isRecord(im)) {
          c.fail(`${f}.images[${j}]`, 'must be { src, alt }');
          return [];
        }
        const src = c.text(im.src, `${f}.images[${j}].src`, SHAPE_LIMITS.target);
        const alt = c.text(im.alt, `${f}.images[${j}].alt`, SHAPE_LIMITS.refText, false) ?? '';
        return src ? [{ src, alt }] : [];
      });
    }
    if (n !== undefined && kind && title && target) {
      out.push({ n, kind, title, ...(sub ? { sub } : {}), target, ...(line ? { line } : {}), ...(images?.length ? { images } : {}) });
    }
  });
  return out.sort((a, b) => a.n - b.n);
}

/** Validate what an agent writes. Every problem is named by its field. */
/**
 * One drawn view on its own, as another surface takes it (code review's
 * pictures): `{ html, css?, width?, height?, tall? }`, with the same checks a
 * board's Picture gets. Each problem names its field under `field`.
 */
export function checkShapeDrawnView(input: unknown, field = 'view'): ShapeCheck<ShapeDrawnView> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: [`${field}: must be an object with html`] };
  const view = checkDrawn(c, input, field);
  if (c.errors.length || !view) return { ok: false, errors: c.errors.length ? c.errors : [`${field}.html: is required`] };
  return { ok: true, value: view };
}

export function checkShapeBoard(input: unknown): ShapeCheck<ShapeBoard> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['the board must be a JSON object: { title, claim, views, refs }'] };
  const title = c.text(input.title, 'title', SHAPE_LIMITS.title);
  const claim = c.text(input.claim, 'claim', SHAPE_LIMITS.claim);
  const note = c.text(input.note, 'note', SHAPE_LIMITS.note, false);
  let asOf: string | undefined;
  if (input.asOf !== undefined && input.asOf !== null) {
    if (typeof input.asOf !== 'string' || Number.isNaN(Date.parse(input.asOf))) c.fail('asOf', 'must be an ISO 8601 date and time');
    else asOf = new Date(input.asOf).toISOString();
  }
  const views: ShapeBoard['views'] = {};
  if (!isRecord(input.views)) c.fail('views', 'is required: { picture, how, reqs, code }, at least one');
  else {
    for (const key of Object.keys(input.views)) {
      if (!SHAPE_VIEWS.some((v) => v.id === key)) c.fail(`views.${key}`, 'is not a view (picture, how, reqs, code)');
    }
    const picture = checkDrawn(c, input.views.picture, 'views.picture');
    const how = checkDrawn(c, input.views.how, 'views.how');
    const reqs = checkReqs(c, input.views.reqs, 'views.reqs');
    const code = checkCode(c, input.views.code, 'views.code');
    if (picture) views.picture = picture;
    if (how) views.how = how;
    if (reqs) views.reqs = reqs;
    if (code) views.code = code;
    if (!input.views.picture && !input.views.how && !input.views.reqs && !input.views.code) c.fail('views', 'needs at least one view');
  }
  const refs = checkRefs(c, input.refs);
  if (c.errors.length || !title || !claim) return { ok: false, errors: c.errors.length ? c.errors : ['title and claim are required'] };
  const board: ShapeBoard = { title, claim, ...(asOf ? { asOf } : {}), ...(note ? { note } : {}), views, ...(refs?.length ? { refs } : {}) };
  // Every cited reference must exist.
  const known = new Set((refs ?? []).map((r) => r.n));
  const cited = shapeCitedRefs(board);
  const missing = [...cited].filter((n) => !known.has(n)).sort((a, b) => a - b);
  if (missing.length) return { ok: false, errors: [`refs: the board cites ${missing.map((n) => `[${n}]`).join(', ')} but refs has no entry with that n`] };
  return { ok: true, value: board };
}

// ───────────────────────────── parts ─────────────────────────────

const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rarr;/g, '→')
    // A browser reads a numeric reference with or without its `;`.
    .replace(/&#(\d+);?/g, (_, d: string) => codePoint(Number(d).toString(16)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => codePoint(h))
    .replace(/&amp;/g, '&');
}

const fold = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The marked parts of a drawn view's HTML, in document order: each element
 * with `data-mark`, and the words inside it (a nested mark's words count for
 * both). A mark id seen again (the wide and the tall drawing name the same
 * part) keeps its first words. No DOM: the store runs in Node.
 */
export function shapeHtmlMarks(html: string): { id: string; text: string }[] {
  const out = new Map<string, string>();
  const stack: { tag: string; mark: string | null; text: string[] }[] = [];
  // `<[!]--`, not the bare comment opener: some JS parsers (Semgrep's) read `<!--` as an HTML-like comment.
  const re = /<[!]--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const close = (frame: { mark: string | null; text: string[] }) => {
    if (frame.mark && !out.has(frame.mark)) out.set(frame.mark, fold(frame.text.join(' ')));
  };
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5]);
      for (const f of stack) if (f.mark) f.text.push(text);
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at < 0) continue;
      while (stack.length > at) close(stack.pop()!);
      continue;
    }
    const attrs = m[3] ?? '';
    const mark = /\sdata-mark\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(` ${attrs}`);
    const id = mark ? (mark[1] ?? mark[2] ?? mark[3] ?? '').trim() : '';
    const selfClosing = !!m[4] || VOID.has(tag);
    const frame = { tag, mark: id || null, text: [] as string[] };
    if (selfClosing) close(frame);
    else stack.push(frame);
  }
  while (stack.length) close(stack.pop()!);
  return [...out].map(([id, text]) => ({ id, text }));
}

/** Every part of a board, by view. The diff and the redraw key on `view` + `id`. */
export function shapeParts(board: ShapeBoard): ShapePart[] {
  const parts: ShapePart[] = [
    { view: 'header', id: 'title', text: fold(board.title) },
    { view: 'header', id: 'claim', text: fold(board.claim) },
  ];
  for (const view of ['picture', 'how'] as const) {
    const drawn = board.views[view];
    if (!drawn) continue;
    const seen = new Set<string>();
    for (const html of [drawn.html, drawn.tall?.html ?? '']) {
      for (const mark of shapeHtmlMarks(html)) {
        if (seen.has(mark.id)) continue;
        seen.add(mark.id);
        parts.push({ view, id: mark.id, text: mark.text });
      }
    }
  }
  for (const group of board.views.reqs?.groups ?? []) {
    for (const item of group.items) parts.push({ view: 'reqs', id: item.id, text: fold(`${group.label}: ${item.text}`) });
  }
  board.views.code?.guide.sections.forEach((section, i) => {
    parts.push({ view: 'code', id: `step-${i + 1}`, text: fold(`${section.title}. ${section.overview} ${section.diffs.map((d) => d.file).join(' ')}`) });
  });
  return parts;
}

/** A place in code a drawn part points at. */
export interface ShapeCodeTarget {
  path: string;
  line: number;
  lineEnd?: number;
}

/**
 * Reads a part's `data-code` ("src/snooze.ts#L42", "src/snooze.ts#L42-L48"
 * or "src/snooze.ts:42"). Null when it is not one: a path outside the
 * project (`isShapeProjectPath`: absolute, `..`, a backslash), a URL or no line.
 */
export function parseShapeCodeTarget(value: string | null | undefined): ShapeCodeTarget | null {
  const m = (value ?? '').trim().match(/^([^#:\s][^#:]*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/);
  if (!m) return null;
  const path = m[1]!;
  if (!isShapeProjectPath(path)) return null;
  const line = Number(m[2] ?? m[4]);
  const end = m[3] ?? m[5];
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const lineEnd = end ? Number(end) : undefined;
  return lineEnd && lineEnd > line ? { path, line, lineEnd } : { path, line };
}

/** The reference numbers a board cites: `data-ref` in drawn views, `[^n]` in text. */
export function shapeCitedRefs(board: ShapeBoard): Set<number> {
  const out = new Set<number>();
  const fromText = (text: string | undefined) => {
    for (const m of (text ?? '').matchAll(/\[\^(\d{1,3})\]/g)) out.add(Number(m[1]));
  };
  const fromHtml = (html: string | undefined) => {
    for (const m of (html ?? '').matchAll(/\sdata-ref\s*=\s*["']?(\d{1,3})/g)) out.add(Number(m[1]));
  };
  fromText(board.claim);
  for (const view of ['picture', 'how'] as const) {
    fromHtml(board.views[view]?.html);
    fromHtml(board.views[view]?.tall?.html);
  }
  for (const group of board.views.reqs?.groups ?? []) for (const item of group.items) fromText(item.text);
  for (const foot of board.views.reqs?.foot ?? []) fromText(foot.text);
  fromText(board.views.code?.source);
  return out;
}

// ───────────────────────────── diff ─────────────────────────────

export interface ShapeChange {
  view: ShapePartView;
  id: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

export interface ShapeDiff {
  from: number;
  to: number;
  changes: ShapeChange[];
  /** Views whose content changed at all (a part, or anything else in the view). In the dock's order. */
  views: ShapeViewId[];
  refs: { added: number[]; removed: number[]; changed: number[] };
}

type Diffable = Pick<ShapeVersion, 'n' | 'views' | 'parts' | 'refs'> & Partial<Pick<ShapeVersion, 'title' | 'claim'>>;

/** What changed from `a` to `b`, by part ids. Snapshots, so any two versions compare. */
export function diffShapeVersions(a: Diffable, b: Diffable): ShapeDiff {
  const key = (p: ShapePart) => `${p.view}\u0000${p.id}`;
  const before = new Map(a.parts.map((p) => [key(p), p]));
  const after = new Map(b.parts.map((p) => [key(p), p]));
  const changes: ShapeChange[] = [];
  for (const p of b.parts) {
    const old = before.get(key(p));
    if (!old) changes.push({ view: p.view, id: p.id, kind: 'added', after: p.text });
    else if (old.text !== p.text) changes.push({ view: p.view, id: p.id, kind: 'changed', before: old.text, after: p.text });
  }
  for (const p of a.parts) if (!after.has(key(p))) changes.push({ view: p.view, id: p.id, kind: 'removed', before: p.text });

  const views = SHAPE_VIEWS.map((v) => v.id).filter((view) => {
    if (changes.some((c) => c.view === view)) return true;
    return JSON.stringify(a.views[view] ?? null) !== JSON.stringify(b.views[view] ?? null);
  });

  const refsA = new Map((a.refs ?? []).map((r) => [r.n, JSON.stringify(r)]));
  const refsB = new Map((b.refs ?? []).map((r) => [r.n, JSON.stringify(r)]));
  const refs = {
    added: [...refsB.keys()].filter((n) => !refsA.has(n)),
    removed: [...refsA.keys()].filter((n) => !refsB.has(n)),
    changed: [...refsB.keys()].filter((n) => refsA.has(n) && refsA.get(n) !== refsB.get(n)),
  };
  return { from: a.n, to: b.n, changes, views, refs };
}

/** "What changed since you looked", as short lines: one per view, then references. */
export function summarizeShapeDiff(diff: ShapeDiff): string[] {
  const lines: string[] = [];
  const header = diff.changes.filter((c) => c.view === 'header');
  if (header.some((c) => c.id === 'title')) lines.push('The title changed');
  if (header.some((c) => c.id === 'claim')) lines.push('The claim changed');
  for (const view of diff.views) {
    const here = diff.changes.filter((c) => c.view === view);
    const count = (kind: ShapeChange['kind']) => here.filter((c) => c.kind === kind).length;
    const bits = [
      count('changed') && `${count('changed')} changed`,
      count('added') && `${count('added')} added`,
      count('removed') && `${count('removed')} removed`,
    ].filter(Boolean);
    lines.push(`${shapeViewLabel(view)}: ${bits.length ? bits.join(', ') : 'redrawn'}`);
  }
  const r = diff.refs;
  const refBits = [r.added.length && `${r.added.length} added`, r.removed.length && `${r.removed.length} removed`, r.changed.length && `${r.changed.length} changed`].filter(Boolean);
  if (refBits.length) lines.push(`References: ${refBits.join(', ')}`);
  return lines;
}

// ───────────────────────────── notes ─────────────────────────────

export interface ShapeNoteInput {
  kind: 'change' | 'ask';
  v: number;
  view?: ShapeViewId | null;
  part?: string | null;
  quote?: string | null;
  text: string;
}

/** Validate a person's Change it or Ask. No part: a general comment (on a view, or the whole board). */
export function checkShapeNoteInput(input: unknown): ShapeCheck<ShapeNoteInput> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['a note must be an object'] };
  const kind = input.kind === 'change' || input.kind === 'ask' ? input.kind : undefined;
  if (!kind) c.fail('kind', 'must be "change" or "ask"');
  const v = c.int(input.v, 'v', 1, 1_000_000);
  let view: ShapeViewId | null = null;
  if (input.view !== undefined && input.view !== null) {
    if (!SHAPE_VIEWS.some((x) => x.id === input.view)) c.fail('view', 'must be picture, how, reqs or code');
    else view = input.view as ShapeViewId;
  }
  let part: string | null = null;
  if (input.part !== undefined && input.part !== null) {
    if (typeof input.part !== 'string' || !input.part.trim() || input.part.length > 200) c.fail('part', 'must be a part id');
    else part = input.part;
  }
  if (part && !view) c.fail('view', 'is required with a part');
  const quote = c.text(input.quote, 'quote', SHAPE_LIMITS.quote, false) ?? null;
  const text = c.text(input.text, 'text', SHAPE_LIMITS.noteText);
  if (c.errors.length || !kind || !v || !text) return { ok: false, errors: c.errors };
  return { ok: true, value: { kind, v, view, part, quote, text } };
}
